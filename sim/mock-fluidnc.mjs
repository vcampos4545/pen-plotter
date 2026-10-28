#!/usr/bin/env node
// A small mock of FluidNC's WebSocket console, for developing without hardware.
//
// Mirrors the parts of FluidNC the app relies on:
//   - console output goes out as binary frames of text, coalesced like the
//     real firmware does; "currentID:N" / "CURRENT_ID:N" text frames on connect
//   - realtime characters: "?" status report, "!" feed hold, "~" resume,
//     0x18 soft reset (ALARM:3 if it interrupts motion, then the banner)
//   - G-code lines run one at a time and are acked with "ok" when they finish;
//     malformed or unsupported lines get "error:N"; lines in Alarm get error:9
//   - work offsets: G10 L2 / L20 (one coordinate system), G92.1; status reports
//     carry MPos, plus WCO on the first report and every 10th after it
//   - "$X" unlocks, "$$" / "$I" / "$G" print a little
//   - "$H" models firmware/config.yaml: X/Y homing cycle -1 sets their MPos to 0
//     where they stand, then the Z servo "homes" to Z5. With homeXY false it
//     models an older config (X/Y cycle 0): $H only lifts the pen.
//
// Usage: npm run sim -- [--port 8081] [--host 127.0.0.1] [--speedup 20] [--home-xy false]

import { WebSocketServer } from 'ws';
import { pathToFileURL } from 'node:url';

const BANNER = "Grbl 3.9 [FluidNC v4.1.1-mock (sim) '$' for help]";
const RAPID_MM_MIN = 12000;
const NUM = /^([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))/;
const SUPPORTED_G = new Set([0, 1, 4, 10, 17, 20, 21, 90, 91, 92.1, 94]);
const SUPPORTED_M = new Set([0, 2, 3, 4, 5, 30]);
const LETTERS = new Set(['G', 'M', 'X', 'Y', 'Z', 'F', 'P', 'L', 'S', 'N']);
const PEN_UP_Z = 5;
const WCO_EVERY = 10;

/** Parse one line. Returns { kind: 'empty' | 'system' | 'gcode', ... } or { error: code }. */
export function parseLine(raw) {
  const s = raw
    .replace(/\([^)]*\)/g, '')
    .replace(/;.*$/, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!s) return { kind: 'empty' };
  if (s.startsWith('$')) return { kind: 'system', cmd: s };
  const words = [];
  let rest = s;
  while (rest) {
    const m = NUM.exec(rest);
    if (!m) return { error: /^[A-Z]/.test(rest) ? 2 : 1 }; // bad number / expected letter
    const letter = m[1];
    const value = Number(m[2]);
    if (!LETTERS.has(letter)) return { error: 20 };
    if (letter === 'G' && !SUPPORTED_G.has(value)) return { error: 20 };
    if (letter === 'M' && !SUPPORTED_M.has(value)) return { error: 20 };
    words.push([letter, value]);
    rest = rest.slice(m[0].length);
  }
  return { kind: 'gcode', words };
}

const fmt = (n) => n.toFixed(3);

export function startMockFluidNC({ port = 8081, host = '127.0.0.1', speedup = 20, homeXY = true, log = () => {} } = {}) {
  const m = {
    state: 'Idle', // Idle | Run | Hold | Alarm
    pos: { x: 0, y: 0, z: 0 }, // machine position (MPos)
    wco: { x: 0, y: 0, z: 0 }, // G54 work offset; WPos = MPos - wco - g92
    g92: { x: 0, y: 0, z: 0 },
    reports: 0,
    feed: 1000,
    motion: 0,
    relative: false,
    inches: false,
    queue: [],
    current: null, // { item, start, target, duration, elapsed, runningSince, timer }
  };
  const clients = new Map(); // ws -> { id, lineBuf, outBuf, flushTimer }
  let nextId = 0;

  const out = (ws, text) => {
    const c = clients.get(ws);
    if (!c) return;
    c.outBuf += `${text}\r\n`;
    // Coalesce output into one binary frame per burst, like FluidNC's WSChannel.
    if (!c.flushTimer) {
      c.flushTimer = setTimeout(() => {
        c.flushTimer = null;
        if (ws.readyState === ws.OPEN && c.outBuf) ws.send(Buffer.from(c.outBuf, 'utf8'), { binary: true });
        c.outBuf = '';
      }, 4);
    }
  };
  const broadcast = (text) => {
    for (const ws of clients.keys()) out(ws, text);
  };

  const livePos = () => {
    const cur = m.current;
    if (!cur || !cur.target) return m.pos;
    const t = cur.elapsed + (cur.runningSince ? Date.now() - cur.runningSince : 0);
    const f = cur.duration > 0 ? Math.min(1, t / cur.duration) : 1;
    return {
      x: cur.start.x + (cur.target.x - cur.start.x) * f,
      y: cur.start.y + (cur.target.y - cur.start.y) * f,
      z: cur.start.z + (cur.target.z - cur.start.z) * f,
    };
  };

  const statusReport = () => {
    const p = livePos();
    const state = m.state === 'Hold' ? 'Hold:0' : m.state;
    const feed = m.state === 'Run' && m.current ? m.feed : 0;
    const off = (k) => m.wco[k] + m.g92[k];
    const wco = m.reports++ % WCO_EVERY === 0 ? `|WCO:${fmt(off('x'))},${fmt(off('y'))},${fmt(off('z'))}` : '';
    return `<${state}|MPos:${fmt(p.x)},${fmt(p.y)},${fmt(p.z)}|FS:${feed},0${wco}>`;
  };

  // Work out what a parsed G-code line does: new modal state, target and duration (ms).
  const plan = (words) => {
    let motion = m.motion;
    let relative = m.relative;
    let inches = m.inches;
    let feed = m.feed;
    let dwell = null;
    let g10 = false;
    let g92reset = false;
    let lword = null;
    const axes = {};
    for (const [l, v] of words) {
      if (l === 'G') {
        if (v === 0 || v === 1) motion = v;
        else if (v === 4) dwell = 0;
        else if (v === 10) g10 = true;
        else if (v === 92.1) g92reset = true;
        else if (v === 90) relative = false;
        else if (v === 91) relative = true;
        else if (v === 20) inches = true;
        else if (v === 21) inches = false;
      } else if (l === 'X' || l === 'Y' || l === 'Z') axes[l.toLowerCase()] = v * (inches ? 25.4 : 1);
      else if (l === 'F') feed = v * (inches ? 25.4 : 1);
      else if (l === 'P' && dwell !== null) dwell = v;
      else if (l === 'L') lword = v;
    }
    const apply = () => {
      m.motion = motion;
      m.relative = relative;
      m.inches = inches;
      m.feed = feed;
    };
    if (g10 && (lword === 2 || lword === 20)) {
      // Only one coordinate system is modelled, so P is ignored.
      const setOffsets = () => {
        apply();
        for (const k of Object.keys(axes)) m.wco[k] = lword === 2 ? axes[k] : m.pos[k] - m.g92[k] - axes[k];
      };
      return { apply: setOffsets, target: null, duration: 0 };
    }
    if (g92reset) {
      const reset = () => {
        apply();
        m.g92 = { x: 0, y: 0, z: 0 };
      };
      return { apply: reset, target: null, duration: 0 };
    }
    if (dwell !== null) return { apply, target: null, duration: (dwell * 1000) / speedup };
    if (Object.keys(axes).length === 0) return { apply, target: null, duration: 0 };
    const start = { ...m.pos };
    const target = { ...start };
    for (const k of Object.keys(axes)) target[k] = relative ? start[k] + axes[k] : axes[k] + m.wco[k] + m.g92[k];
    const d = Math.hypot(target.x - start.x, target.y - start.y, target.z - start.z);
    const rate = motion === 0 ? RAPID_MM_MIN : feed;
    return { apply, target, duration: ((d / rate) * 60000) / speedup };
  };

  const finishCurrent = () => {
    const cur = m.current;
    m.current = null;
    if (cur.target) m.pos = cur.target;
    out(cur.item.ws, cur.item.reply ?? 'ok');
    runNext();
  };

  const runNext = () => {
    if (m.current || m.state === 'Hold' || m.state === 'Alarm') return;
    const item = m.queue.shift();
    if (!item) {
      if (m.state === 'Run') m.state = 'Idle';
      return;
    }
    if (item.reply || item.run) {
      // errors and system commands keep their place in the response order
      item.run?.();
      m.current = { item, target: null, duration: 0, elapsed: 0 };
      setImmediate(finishCurrent);
      return;
    }
    const p = plan(item.words);
    p.apply();
    m.state = 'Run';
    const duration = Math.max(2, p.duration);
    m.current = { item, start: { ...m.pos }, target: p.target, duration, elapsed: 0, runningSince: Date.now() };
    m.current.timer = setTimeout(finishCurrent, duration);
  };

  const enqueue = (item) => {
    m.queue.push(item);
    runNext();
  };

  const hold = () => {
    // Also hold from Idle so lines arriving mid-job wait for "~".
    if (m.state !== 'Run' && m.state !== 'Idle') return;
    m.state = 'Hold';
    const cur = m.current;
    if (cur && cur.timer) {
      clearTimeout(cur.timer);
      cur.timer = null;
      cur.elapsed += Date.now() - cur.runningSince;
      cur.runningSince = 0;
    }
  };

  const resume = () => {
    if (m.state !== 'Hold') return;
    m.state = 'Run';
    const cur = m.current;
    if (cur && !cur.timer && cur.item && !cur.item.reply) {
      cur.runningSince = Date.now();
      cur.timer = setTimeout(finishCurrent, Math.max(0, cur.duration - cur.elapsed));
    } else if (!cur) {
      runNext();
    }
  };

  const softReset = () => {
    const wasMoving = m.state === 'Run' || m.state === 'Hold';
    if (m.current) {
      clearTimeout(m.current.timer);
      m.pos = livePos();
      m.current = null;
    }
    m.queue = [];
    m.motion = 0;
    m.relative = false;
    m.inches = false;
    if (wasMoving) {
      m.state = 'Alarm';
      broadcast('ALARM:3');
    } else if (m.state !== 'Alarm') {
      m.state = 'Idle';
    }
    broadcast(BANNER);
    if (m.state === 'Alarm') broadcast("[MSG:'$H'|'$X' to unlock]");
    log(`soft reset${wasMoving ? ' during motion -> Alarm' : ''}`);
  };

  // $H with the repo's config.yaml: X/Y (cycle -1) take MPos 0 without moving,
  // Z (cycle 1, servo) jumps to its mpos_mm. Homing also clears an alarm.
  const home = () => {
    if (homeXY) {
      m.pos.x = 0;
      m.pos.y = 0;
    }
    m.pos.z = PEN_UP_Z;
    if (m.state === 'Alarm') m.state = 'Idle';
    log(`homed${homeXY ? ' X Y' : ''} Z`);
  };

  const system = (ws, cmd) => {
    if (cmd === '$X') {
      if (m.state === 'Alarm') {
        m.state = 'Idle';
        out(ws, '[MSG:INFO: Caution: Unlocked]');
      }
      return 'ok';
    }
    if (cmd === '$$') {
      out(ws, '$0=10');
      out(ws, '$10=1');
      return 'ok';
    }
    if (cmd === '$I') {
      out(ws, '[VER:3.9 FluidNC v4.1.1-mock:]');
      return 'ok';
    }
    if (cmd === '$G') {
      out(ws, `[GC:G${m.motion} G54 G17 ${m.inches ? 'G20' : 'G21'} ${m.relative ? 'G91' : 'G90'} G94 M5 M9 T0 F${m.feed} S0]`);
      return 'ok';
    }
    if (cmd === '$H') {
      home();
      return 'ok';
    }
    return 'error:3';
  };

  const handleLine = (ws, line) => {
    const parsed = parseLine(line);
    log(`<- ${line}`);
    if (parsed.error) return enqueue({ ws, reply: `error:${parsed.error}` });
    if (parsed.kind === 'empty') return enqueue({ ws, reply: 'ok' });
    if (parsed.kind === 'system') {
      // $X must work while in Alarm, which blocks the motion queue.
      if (m.state === 'Alarm') return out(ws, system(ws, parsed.cmd));
      if (parsed.cmd === '$H') return enqueue({ ws, run: home });
      return enqueue({ ws, reply: system(ws, parsed.cmd) });
    }
    if (m.state === 'Alarm') return out(ws, 'error:9');
    enqueue({ ws, words: parsed.words });
  };

  const wss = new WebSocketServer({ port, host });
  wss.on('connection', (ws, req) => {
    const id = nextId++;
    clients.set(ws, { id, lineBuf: '', outBuf: '', flushTimer: null });
    log(`client #${id} connected from ${req.socket.remoteAddress} (${req.url})`);
    ws.send(`currentID:${id}`);
    ws.send(`CURRENT_ID:${id}`);
    ws.on('message', (data) => {
      const c = clients.get(ws);
      for (const ch of data.toString('utf8')) {
        if (ch === '?') out(ws, statusReport());
        else if (ch === '!') hold();
        else if (ch === '~') resume();
        else if (ch === '\x18') softReset();
        else if (ch === '\n') {
          const line = c.lineBuf;
          c.lineBuf = '';
          handleLine(ws, line);
        } else if (ch !== '\r') c.lineBuf += ch;
      }
    });
    ws.on('close', () => {
      const c = clients.get(ws);
      if (c?.flushTimer) clearTimeout(c.flushTimer);
      clients.delete(ws);
      log(`client #${id} disconnected`);
    });
  });

  return new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => {
      resolve({
        port: wss.address().port,
        machine: m,
        close: () =>
          new Promise((done) => {
            if (m.current) clearTimeout(m.current.timer);
            for (const ws of clients.keys()) ws.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].replace(/^--/, '').split('=');
    const value = inline ?? argv[++i];
    if (key === 'port') opts.port = Number(value);
    else if (key === 'host') opts.host = value;
    else if (key === 'speedup') opts.speedup = Number(value);
    else if (key === 'home-xy') opts.homeXY = value !== 'false';
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = {
    port: Number(process.env.SIM_PORT) || 8081,
    host: process.env.SIM_HOST || '127.0.0.1',
    speedup: Number(process.env.SIM_SPEEDUP) || 20,
    ...parseArgs(process.argv.slice(2)),
  };
  const verbose = process.env.SIM_VERBOSE === '1';
  startMockFluidNC({
    ...opts,
    log: (msg) => {
      if (verbose || !msg.startsWith('<-')) console.log(`[sim] ${msg}`);
    },
  }).then(
    ({ port }) => {
      console.log(`[sim] mock FluidNC listening on ws://${opts.host}:${port}/ (speedup x${opts.speedup})`);
      console.log(`[sim] in the app settings use host ${opts.host === '0.0.0.0' ? 'localhost' : opts.host}, port ${port}, path /`);
    },
    (err) => {
      console.error(`[sim] failed to start: ${err.message}`);
      process.exit(1);
    },
  );
}
