// End to end: the browser connection + streamer talking to the mock FluidNC
// over a real WebSocket (Node's built-in client).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FluidNCConnection, type ConnState } from '../src/connection';
import { generateGcode } from '../src/gcode';
import { OFFSET_ORIGIN_LINE, OriginSetter, SET_ORIGIN_LINES } from '../src/origin';
import { Streamer, type StreamProgress } from '../src/streamer';
import { parseLine, startMockFluidNC } from '../sim/mock-fluidnc.mjs';

interface Sim {
  port: number;
  machine: { state: string; pos: { x: number; y: number; z: number }; wco: { x: number; y: number; z: number } };
  close(): Promise<void>;
}

const waitFor = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const square = [
  [
    { x: 50, y: 50 },
    { x: 150, y: 50 },
    { x: 150, y: 150 },
    { x: 50, y: 150 },
    { x: 50, y: 50 },
  ],
  [
    { x: 200, y: 200 },
    { x: 300, y: 300 },
  ],
];
const gcode = generateGcode(square, {
  drawFeed: 3000,
  travelFeed: 6000,
  travelUseG1: false,
  penUpZ: 5,
  penDownZ: 0,
  penDwell: 0.15,
});

describe('mock FluidNC parser', () => {
  it('accepts our G-code and rejects malformed lines', () => {
    for (const l of [...gcode, ...SET_ORIGIN_LINES, OFFSET_ORIGIN_LINE]) expect(parseLine(l).error).toBeUndefined();
    expect(parseLine('G1 X1 Y').error).toBe(2);
    expect(parseLine('hello').error).toBe(2);
    expect(parseLine('123').error).toBe(1);
    expect(parseLine('G38.2 X1').error).toBe(20);
    expect(parseLine('; comment').kind).toBe('empty');
  });
});

describe('connection + streamer against the simulator', () => {
  let sim: Sim;
  let conn: FluidNCConnection;
  let states: ConnState[];
  let lines: string[];
  let streamer: Streamer | undefined;
  let origin: OriginSetter | undefined;

  beforeEach(async () => {
    sim = await startMockFluidNC({ port: 0, speedup: 200 });
    states = [];
    lines = [];
    streamer = undefined;
    origin = undefined;
    conn = new FluidNCConnection({
      pollMs: 50,
      staleMs: 500,
      timeoutMs: 1000,
      backoffMinMs: 50,
      backoffMaxMs: 200,
      onState: (s) => states.push(s),
      onLine: (l) => {
        lines.push(l);
        streamer?.handleLine(l);
        origin?.handleLine(l);
      },
    });
  });

  afterEach(async () => {
    conn.disconnect();
    await sim.close();
  });

  const startJob = (job: string[], maxInFlight = 3) => {
    const updates: StreamProgress[] = [];
    let maxOutstanding = 0;
    streamer = new Streamer(
      job,
      {
        sendLine: (l) => {
          conn.sendLine(l);
          const p = streamer!.progress;
          maxOutstanding = Math.max(maxOutstanding, p.sent - p.acked);
        },
        sendRealtime: (c) => conn.sendRealtime(c),
      },
      { maxInFlight, penUpLine: 'G21 G90 G0 Z5', resetTimeoutMs: 1500, onUpdate: (p) => updates.push(p) },
    );
    streamer.start();
    return { updates, maxOutstanding: () => maxOutstanding };
  };

  it('connects only after a status reply, then streams a whole job with flow control', async () => {
    conn.connect(`ws://127.0.0.1:${sim.port}/`);
    expect(states[0]).toBe('connecting');
    await waitFor(() => conn.isConnected);
    expect(lines.some((l) => l.startsWith('<Idle|MPos:'))).toBe(true);

    const { updates, maxOutstanding } = startJob(gcode, 3);
    await waitFor(() => streamer!.progress.state === 'done');
    expect(streamer!.progress).toMatchObject({ sent: gcode.length, acked: gcode.length });
    expect(maxOutstanding()).toBeLessThanOrEqual(3);
    expect(updates.some((u) => u.state === 'running')).toBe(true);
    // Ended pen up at the origin.
    expect(sim.machine.pos).toEqual({ x: 0, y: 0, z: 5 });
  });

  it('pause holds the machine and resume finishes the job', async () => {
    conn.connect(`ws://127.0.0.1:${sim.port}/`);
    await waitFor(() => conn.isConnected);
    startJob(gcode, 2);
    await waitFor(() => streamer!.progress.acked >= 3);
    streamer!.pause();
    await waitFor(() => sim.machine.state === 'Hold');
    const acked = streamer!.progress.acked;
    await new Promise((r) => setTimeout(r, 200));
    // At most the in-flight lines can complete after a hold; then nothing moves.
    expect(streamer!.progress.acked - acked).toBeLessThanOrEqual(1);
    expect(streamer!.progress.state).toBe('paused');
    streamer!.resume();
    await waitFor(() => streamer!.progress.state === 'done');
  });

  it('stop soft-resets mid-job, unlocks and lifts the pen', async () => {
    conn.connect(`ws://127.0.0.1:${sim.port}/`);
    await waitFor(() => conn.isConnected);
    // Long draw moves so the job is surely mid-motion when stopped.
    const slow = ['G21 G90', 'G0 Z0', ...Array.from({ length: 20 }, (_, i) => `G1 X${(i % 2) * 300} Y${i} F600`)];
    startJob(slow, 2);
    await waitFor(() => streamer!.progress.acked >= 2 && sim.machine.state === 'Run');
    streamer!.stop();
    await waitFor(() => streamer!.progress.state === 'stopped');
    expect(lines).toContain('ALARM:3');
    await waitFor(() => sim.machine.pos.z === 5 && sim.machine.state === 'Idle');
    expect(streamer!.progress.sent).toBeLessThan(slow.length);
  });

  it('error: from the controller aborts the job', async () => {
    conn.connect(`ws://127.0.0.1:${sim.port}/`);
    await waitFor(() => conn.isConnected);
    startJob(['G21 G90', 'G0 Z5', 'G1 X10 Y', 'G1 X20 Y20 F1000', 'G1 X30 Y30'], 1);
    await waitFor(() => streamer!.progress.state === 'failed');
    expect(streamer!.progress.error).toMatch(/^error:2 after line 3: G1 X10 Y$/);
    expect(streamer!.progress.sent).toBe(3);
  });

  const runCommands = async (cmds: string[]) => {
    startJob(cmds, 1);
    await waitFor(() => streamer!.progress.state === 'done');
    streamer = undefined;
  };

  const setOrigin = async () => {
    origin = new OriginSetter((l) => conn.sendLine(l), { timeoutMs: 2000 });
    origin.start();
    await waitFor(() => !origin!.active);
    return origin.progress;
  };

  it('set origin moves the machine position, so moves and soft limits count from the pen', async () => {
    conn.connect(`ws://127.0.0.1:${sim.port}/`);
    await waitFor(() => conn.isConnected);
    await runCommands(['G21 G90', 'G0 X120 Y80', 'G10 L20 P0 X5 Y5']);
    expect(sim.machine.wco).toMatchObject({ x: 115, y: 75 });

    expect(await setOrigin()).toEqual({ state: 'done', result: { mode: 'machine' } });
    // MPos is X0 Y0 where the pen stood, with no work offset left over.
    expect(sim.machine.pos).toEqual({ x: 0, y: 0, z: 5 });
    expect(sim.machine.wco).toMatchObject({ x: 0, y: 0 });

    await runCommands(['G0 X10 Y20', 'G0 X0 Y0']);
    expect(sim.machine.pos).toMatchObject({ x: 0, y: 0 });
  });

  it('set origin falls back to a work offset with an older config.yaml', async () => {
    await sim.close();
    sim = await startMockFluidNC({ port: 0, speedup: 200, homeXY: false });
    conn.connect(`ws://127.0.0.1:${sim.port}/`);
    await waitFor(() => conn.isConnected);
    await runCommands(['G21 G90', 'G0 X120 Y80 Z0']);

    const p = await setOrigin();
    expect(p.state).toBe('done');
    expect(p.result).toMatchObject({ mode: 'offset', offset: { x: 120, y: 80 } });
    // The machine did not move, the pen lifted, and work X0 Y0 is here now.
    expect(sim.machine.pos).toEqual({ x: 120, y: 80, z: 5 });
    expect(sim.machine.wco).toMatchObject({ x: 120, y: 80 });
    await runCommands(['G0 X10 Y20']);
    expect(sim.machine.pos).toMatchObject({ x: 130, y: 100 });
  });

  it('reports errors and reconnects with backoff when the server goes away', async () => {
    conn.connect(`ws://127.0.0.1:${sim.port}/`);
    await waitFor(() => conn.isConnected);
    const port = sim.port;
    await sim.close();
    await waitFor(() => conn.connState === 'error');
    expect(conn.stateDetail).toMatch(/Retrying/);
    sim = await startMockFluidNC({ port, speedup: 200 });
    await waitFor(() => conn.isConnected, 5000);
  });
});
