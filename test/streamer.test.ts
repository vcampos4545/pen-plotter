import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Streamer, type StreamProgress } from '../src/streamer';

function setup(lines: string[], maxInFlight = 3) {
  const sent: string[] = [];
  const realtime: string[] = [];
  const updates: StreamProgress[] = [];
  const s = new Streamer(
    lines,
    { sendLine: (l) => sent.push(l), sendRealtime: (c) => realtime.push(c) },
    { maxInFlight, penUpLine: 'G21 G90 G0 Z5', resetTimeoutMs: 1000, onUpdate: (p) => updates.push(p) },
  );
  return { s, sent, realtime, updates };
}

const job = Array.from({ length: 10 }, (_, i) => `G1 X${i} Y${i}`);

describe('Streamer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps at most maxInFlight lines outstanding', () => {
    const { s, sent } = setup(job, 3);
    s.start();
    expect(sent).toEqual(job.slice(0, 3));
    s.handleLine('ok');
    expect(sent).toHaveLength(4);
    // Status reports and messages do not release lines.
    s.handleLine('<Run|MPos:0,0,0|FS:0,0>');
    s.handleLine('[MSG:INFO: hello]');
    expect(sent).toHaveLength(4);
    for (let i = 0; i < 9; i++) s.handleLine('ok');
    expect(sent).toEqual(job);
    expect(s.progress).toMatchObject({ state: 'draining', sent: 10, acked: 10, total: 10 });
    s.handleLine('<Idle|MPos:0,0,0|FS:0,0>');
    expect(s.progress.state).toBe('done');
    expect(s.active).toBe(false);
  });

  it('ignores stray oks beyond what was sent', () => {
    const { s } = setup(job, 2);
    s.start();
    s.handleLine('ok');
    s.handleLine('ok');
    s.handleLine('ok');
    s.handleLine('ok');
    expect(s.progress.acked).toBeLessThanOrEqual(s.progress.sent);
  });

  it('pause stops sending and sends !, resume sends ~ and continues', () => {
    const { s, sent, realtime } = setup(job, 2);
    s.start();
    s.pause();
    expect(realtime).toEqual(['!']);
    s.handleLine('ok');
    s.handleLine('ok');
    expect(sent).toHaveLength(2);
    expect(s.progress).toMatchObject({ state: 'paused', acked: 2 });
    s.resume();
    expect(realtime).toEqual(['!', '~']);
    expect(sent).toHaveLength(4);
    expect(s.progress.state).toBe('running');
  });

  it('stop soft-resets, then unlocks and lifts the pen after the banner', () => {
    const { s, sent, realtime } = setup(job, 2);
    s.start();
    s.stop();
    expect(realtime).toEqual(['\x18']);
    expect(s.progress.state).toBe('stopping');
    // Late replies during the reset are ignored.
    s.handleLine('ok');
    s.handleLine('ALARM:3');
    expect(sent).toHaveLength(2);
    s.handleLine("Grbl 3.9 [FluidNC v4.1.1 (wifi) '$' for help]");
    expect(sent.slice(2)).toEqual(['$X', 'G21 G90 G0 Z5']);
    expect(s.progress.state).toBe('stopped');
  });

  it('stop lifts the pen after a timeout if no banner arrives', () => {
    const { s, sent } = setup(job, 2);
    s.start();
    s.stop();
    vi.advanceTimersByTime(999);
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(2);
    expect(sent.slice(2)).toEqual(['$X', 'G21 G90 G0 Z5']);
  });

  it('error: aborts the job like Stop and records the failing line', () => {
    const { s, sent, realtime } = setup(job, 3);
    s.start();
    s.handleLine('ok');
    s.handleLine('error:20');
    expect(realtime).toEqual(['\x18']);
    expect(sent).toHaveLength(4); // nothing more after the error
    s.handleLine('Grbl 3.9 [FluidNC]');
    expect(s.progress.state).toBe('failed');
    expect(s.progress.error).toContain('error:20');
    expect(s.progress.error).toContain(job[1]);
  });

  it('ALARM: aborts the job', () => {
    const { s, realtime } = setup(job, 3);
    s.start();
    s.handleLine('ALARM:1');
    expect(realtime).toEqual(['\x18']);
    vi.advanceTimersByTime(1000);
    expect(s.progress).toMatchObject({ state: 'failed', error: 'ALARM:1' });
  });

  it('connection loss keeps the job resumable instead of failing it', () => {
    const { s, sent } = setup(job, 3);
    s.start();
    s.connectionLost();
    expect(s.progress.state).toBe('reconnecting');
    expect(s.active).toBe(true);
    expect(s.progress.note).toMatch(/line 1 of 10/);
    s.handleLine('ok');
    expect(sent).toHaveLength(3);
  });
});

describe('Streamer after a dropped connection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Pen-up travel, pen down, a square, pen up.
  const program = [
    'G21 G90',
    'G0 Z5',
    'G0 X10 Y10',
    'G0 Z0',
    'G1 X20 Y10 F1000',
    'G1 X20 Y20',
    'G1 X10 Y20',
    'G1 X10 Y10',
    'G0 Z5',
    'G0 X0 Y0',
  ];
  const resume = { penUpZ: 5, penDwell: 0, travelUseG1: false, travelFeed: 6000 };
  const idleAt = (x: number, y: number, z = 0) => `<Idle|MPos:${x},${y},${z}|FS:0,0>`;

  function dropAfter(acks: number, maxInFlight = 3) {
    const sent: string[] = [];
    const realtime: string[] = [];
    const s = new Streamer(
      program,
      { sendLine: (l) => sent.push(l), sendRealtime: (c) => realtime.push(c) },
      { maxInFlight, penUpLine: 'G21 G90 G0 Z5', graceMs: 30000, resume },
    );
    s.start();
    for (let i = 0; i < acks; i++) s.handleLine('ok');
    s.connectionLost();
    return { s, sent, realtime };
  }

  it('reconnecting within the grace window, then resuming from where the machine stopped', () => {
    // Lines 0..4 acked, 5..7 sent but unacknowledged when the link drops.
    const { s, sent } = dropAfter(5);
    expect(s.progress).toMatchObject({ state: 'reconnecting', sent: 8, acked: 5 });
    vi.advanceTimersByTime(10000);
    s.connectionRestored();
    expect(s.progress.state).toBe('interrupted');
    expect(s.canResume).toBe(false); // no status report yet
    s.handleLine('<Run|MPos:20,15,0|FS:1000,0|WCO:0,0,0>');
    expect(s.canResume).toBe(true);

    sent.length = 0;
    s.resume();
    expect(s.progress.state).toBe('resyncing');
    // Still finishing buffered moves: nothing is sent yet.
    s.handleLine('<Run|MPos:20,20,0|FS:1000,0>');
    expect(sent).toEqual([]);
    // Came to rest at the end of line 5 (G1 X20 Y20): line 6 was never received.
    s.handleLine(idleAt(20, 20));
    expect(s.progress).toMatchObject({ state: 'running', acked: 6, sent: 6 });
    // Pen up, back to the last point, pen down, feed, then the job from line 6.
    expect(sent).toEqual(['G21 G90', 'G0 Z5', 'G0 X20 Y20']);
    for (let i = 0; i < 20; i++) s.handleLine('ok');
    expect(sent).toEqual(['G21 G90', 'G0 Z5', 'G0 X20 Y20', 'G0 Z0', 'F1000', ...program.slice(6)]);
    expect(s.progress).toMatchObject({ state: 'draining', acked: 10 });
    s.handleLine(idleAt(0, 0, 5));
    expect(s.progress.state).toBe('done');
  });

  it('after the grace window the job is interrupted, and Resume works once the link is back', () => {
    const { s, sent } = dropAfter(5);
    vi.advanceTimersByTime(30001);
    expect(s.progress.state).toBe('interrupted');
    expect(s.progress.note).toMatch(/Resume becomes available/);
    expect(s.canResume).toBe(false);
    s.resume(); // no link: ignored
    expect(s.progress.state).toBe('interrupted');

    s.connectionRestored();
    s.handleLine(idleAt(10, 20));
    expect(s.canResume).toBe(true);
    sent.length = 0;
    s.resume();
    // All three in-flight lines ran (ended at X10 Y20, line 6).
    expect(s.progress).toMatchObject({ state: 'running', acked: 7, sent: 7 });
    expect(sent).toEqual(['G21 G90', 'G0 Z5', 'G0 X10 Y20']);
  });

  it('resumes from the start of the in-flight window when only acked lines ran', () => {
    const { s, sent } = dropAfter(5);
    s.connectionRestored();
    s.handleLine(idleAt(20, 10));
    sent.length = 0;
    s.resume();
    expect(s.progress).toMatchObject({ acked: 5, sent: 5 });
    for (let i = 0; i < 4; i++) s.handleLine('ok');
    expect(sent.slice(3, 6)).toEqual(['G0 Z0', 'F1000', 'G1 X20 Y20']);
  });

  it('a job held before the drop gets cycle start, then resumes once Idle', () => {
    const { s, realtime } = dropAfter(5);
    s.connectionRestored();
    s.handleLine('<Hold:0|MPos:20,15,0|FS:0,0>');
    s.resume();
    expect(realtime).toEqual(['~']);
    expect(s.progress.state).toBe('resyncing');
    s.handleLine('<Run|MPos:20,18,0|FS:1000,0>');
    s.handleLine(idleAt(10, 10));
    expect(s.progress).toMatchObject({ state: 'running', acked: 8 });
  });

  it('a job that finished during the drop is marked done without Resume', () => {
    const { s } = dropAfter(10);
    expect(s.progress.state).toBe('reconnecting');
    s.connectionRestored();
    s.handleLine('<Run|MPos:5,5,5|FS:6000,0>');
    expect(s.progress.state).toBe('interrupted');
    s.handleLine(idleAt(0, 0, 5));
    expect(s.progress.state).toBe('done');
  });

  it('refuses to resume when the position fits no line (restart or lost steps)', () => {
    const { s, sent } = dropAfter(5);
    s.connectionRestored();
    s.handleLine(idleAt(0, 0));
    sent.length = 0;
    s.resume();
    expect(s.progress.state).toBe('failed');
    expect(s.progress.error).toMatch(/X0\.00 Y0\.00.*lines 6–8/);
    expect(sent).toEqual([]);
  });

  it('refuses to resume from Alarm, and fails if the controller restarted', () => {
    const a = dropAfter(5);
    a.s.connectionRestored();
    a.s.handleLine('<Alarm|MPos:20,20,0|FS:0,0>');
    a.s.resume();
    expect(a.s.progress.state).toBe('failed');
    expect(a.s.progress.error).toMatch(/Alarm/);

    const b = dropAfter(5);
    b.s.connectionRestored();
    b.s.handleLine("Grbl 3.9 [FluidNC v4.1.1 (wifi) '$' for help]");
    expect(b.s.progress.state).toBe('failed');
  });

  it('uses the work offset to compare positions', () => {
    const { s } = dropAfter(5);
    s.connectionRestored();
    s.handleLine('<Idle|MPos:120,70,0|FS:0,0|WCO:100,50,0>');
    s.resume();
    expect(s.progress).toMatchObject({ state: 'running', acked: 6 });
  });

  it('a second drop while resuming goes back to reconnecting', () => {
    const { s } = dropAfter(5);
    s.connectionRestored();
    s.handleLine('<Run|MPos:20,15,0|FS:1000,0>');
    s.resume();
    s.connectionLost();
    expect(s.progress.state).toBe('reconnecting');
    s.connectionRestored();
    s.handleLine(idleAt(20, 20));
    s.resume();
    expect(s.progress).toMatchObject({ state: 'running', acked: 6 });
  });

  it('Stop while the link is down gives up without sending; with the link up it soft-resets', () => {
    const a = dropAfter(5);
    a.s.stop();
    expect(a.s.progress.state).toBe('stopped');
    expect(a.realtime).toEqual([]);
    vi.advanceTimersByTime(60000);
    expect(a.s.progress.state).toBe('stopped');

    const b = dropAfter(5);
    b.s.connectionRestored();
    b.s.stop();
    expect(b.realtime).toEqual(['\x18']);
    b.s.handleLine("Grbl 3.9 [FluidNC v4.1.1 (wifi) '$' for help]");
    expect(b.s.progress.state).toBe('stopped');
    expect(b.sent.slice(-2)).toEqual(['$X', 'G21 G90 G0 Z5']);
  });
});
