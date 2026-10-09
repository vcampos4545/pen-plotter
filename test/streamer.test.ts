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

  it('connection loss fails the job without sending', () => {
    const { s, sent } = setup(job, 3);
    s.start();
    s.connectionLost();
    expect(s.progress.state).toBe('failed');
    s.handleLine('ok');
    expect(sent).toHaveLength(3);
  });
});
