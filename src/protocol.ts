// Pure helpers for the FluidNC / Grbl text protocol as seen over the WebSocket.
//
// FluidNC v4 sends console output as *binary* frames whose payload is plain
// text. Frames are coalesced (up to ~1400 bytes), so one frame can carry many
// lines or end in the middle of one. Short *text* frames carry WebUI control
// messages such as "currentID:3", "CURRENT_ID:3" and "PING:...".

export const REALTIME = {
  status: '?',
  feedHold: '!',
  cycleStart: '~',
  softReset: '\x18',
} as const;

const CONTROL_PREFIX = /^(currentID|CURRENT_ID|activeID|ACTIVE_ID|PING|DHT|ERROR|MSG|NOTIFICATION):/;

/** True for WebUI bookkeeping frames that are not console output. */
export function isControlMessage(text: string): boolean {
  return CONTROL_PREFIX.test(text);
}

/** Reassembles newline-terminated lines from arbitrarily split chunks. */
export class LineAssembler {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    return parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  }

  reset(): void {
    this.buffer = '';
  }
}

export type Axes = [number, number, number];

export interface StatusReport {
  /** Idle, Run, Hold, Jog, Alarm, Door, Check, Home, Sleep. */
  state: string;
  /** e.g. "0" in "Hold:0". */
  subState?: string;
  mpos?: Axes;
  wpos?: Axes;
  wco?: Axes;
  feed?: number;
}

function axes(v: string): Axes | undefined {
  const n = v.split(',').map(Number);
  if (n.length < 2 || n.some((x) => !Number.isFinite(x))) return undefined;
  return [n[0], n[1], n[2] ?? 0];
}

/** Parse "<Idle|MPos:0.000,0.000,5.000|FS:0,0>" style reports. */
export function parseStatus(line: string): StatusReport | undefined {
  const m = /^<([^>]*)>$/.exec(line.trim());
  if (!m) return undefined;
  const [head, ...fields] = m[1].split('|');
  const [state, subState] = head.split(':');
  if (!state) return undefined;
  const report: StatusReport = { state, ...(subState !== undefined ? { subState } : {}) };
  for (const f of fields) {
    const i = f.indexOf(':');
    if (i < 0) continue;
    const key = f.slice(0, i);
    const val = f.slice(i + 1);
    if (key === 'MPos') report.mpos = axes(val);
    else if (key === 'WPos') report.wpos = axes(val);
    else if (key === 'WCO') report.wco = axes(val);
    else if (key === 'FS' || key === 'F') report.feed = Number(val.split(',')[0]);
  }
  return report;
}

/** Work position from a report, deriving it from MPos - WCO when needed. */
export function workPosition(r: StatusReport, lastWco?: Axes): Axes | undefined {
  if (r.wpos) return r.wpos;
  if (!r.mpos) return undefined;
  const wco = r.wco ?? lastWco;
  return wco ? [r.mpos[0] - wco[0], r.mpos[1] - wco[1], r.mpos[2] - wco[2]] : r.mpos;
}

export type Response =
  | { type: 'ok' }
  | { type: 'error'; code: string; text: string }
  | { type: 'alarm'; code: string; text: string }
  | { type: 'status'; status: StatusReport }
  | { type: 'greeting'; text: string }
  | { type: 'message'; text: string };

export function classifyResponse(line: string): Response {
  const t = line.trim();
  if (t === 'ok') return { type: 'ok' };
  const err = /^error:\s*(.*)$/i.exec(t);
  if (err) return { type: 'error', code: err[1], text: t };
  const alarm = /^ALARM:\s*(.*)$/i.exec(t);
  if (alarm) return { type: 'alarm', code: alarm[1], text: t };
  if (t.startsWith('<')) {
    const status = parseStatus(t);
    if (status) return { type: 'status', status };
  }
  // Startup banner after boot or soft reset, e.g. "Grbl 4.1 [FluidNC v4.1.1 (wifi) '$' for help]".
  if (/^Grbl\b/.test(t) || /\[FluidNC\b/.test(t)) return { type: 'greeting', text: t };
  return { type: 'message', text: t };
}
