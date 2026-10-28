import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeOrigin, OFFSET_ORIGIN_LINE, OriginSetter, SET_ORIGIN_LINES, type OriginProgress } from '../src/origin';

function setup() {
  const sent: string[] = [];
  const updates: OriginProgress[] = [];
  const o = new OriginSetter((l) => sent.push(l), { timeoutMs: 1000, onUpdate: (p) => updates.push(p) });
  return { o, sent, updates };
}

/** Ack every line sent so far that has not been acked yet. */
function ackAll(o: OriginSetter, sent: string[], acked: { n: number }) {
  while (acked.n < sent.length) {
    acked.n++;
    o.handleLine('ok');
  }
}

describe('OriginSetter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('zeroes the work offsets, then sets MPos with $H, one line per ok', () => {
    const { o, sent } = setup();
    o.start();
    expect(sent).toEqual(['G10 L2 P0 X0 Y0']);
    // Status reports and messages do not release the next line.
    o.handleLine('<Idle|MPos:120.000,80.000,5.000|FS:0,0>');
    o.handleLine('[MSG:INFO: hello]');
    expect(sent).toHaveLength(1);
    o.handleLine('ok');
    o.handleLine('ok');
    expect(sent).toEqual([...SET_ORIGIN_LINES]);
    expect(o.active).toBe(true);
  });

  it('finishes in machine mode when the next status shows MPos X0 Y0', () => {
    const { o, sent } = setup();
    const acked = { n: 0 };
    o.start();
    for (let i = 0; i < 3; i++) ackAll(o, sent, acked);
    expect(o.progress.state).toBe('verifying');
    o.handleLine('<Idle|MPos:0.000,0.000,5.000|FS:0,0>');
    expect(o.progress).toEqual({ state: 'done', result: { mode: 'machine' } });
    expect(o.active).toBe(false);
    expect(sent).toEqual([...SET_ORIGIN_LINES]);
  });

  it('falls back to a work offset when $H leaves MPos alone (old config.yaml)', () => {
    const { o, sent } = setup();
    const acked = { n: 0 };
    o.start();
    for (let i = 0; i < 3; i++) ackAll(o, sent, acked);
    o.handleLine('<Idle|MPos:120.000,80.000,5.000|FS:0,0>');
    expect(sent.at(-1)).toBe(OFFSET_ORIGIN_LINE);
    expect(o.progress.state).toBe('fallback');
    o.handleLine('ok');
    const p = o.progress;
    expect(p.state).toBe('done');
    expect(p.result).toMatchObject({ mode: 'offset', offset: { x: 120, y: 80 } });
  });

  it('falls back when $H is refused, using the last reported position', () => {
    const { o, sent } = setup();
    o.start();
    o.handleLine('<Idle|MPos:30.000,40.000,0.000|FS:0,0>');
    o.handleLine('ok');
    o.handleLine('ok');
    o.handleLine('error:7');
    expect(sent.at(-1)).toBe(OFFSET_ORIGIN_LINE);
    o.handleLine('ok');
    expect(o.progress.result).toMatchObject({ mode: 'offset', offset: { x: 30, y: 40 }, reason: '$H was refused (error:7)' });
  });

  it('fails on an error before $H, on alarms, on silence and on a lost connection', () => {
    let s = setup();
    s.o.start();
    s.o.handleLine('error:9');
    expect(s.o.progress).toMatchObject({ state: 'failed', error: 'error:9 after G10 L2 P0 X0 Y0' });
    expect(s.sent).toHaveLength(1);

    s = setup();
    s.o.start();
    s.o.handleLine('ALARM:2');
    expect(s.o.progress).toMatchObject({ state: 'failed', error: 'ALARM:2' });

    s = setup();
    s.o.start();
    vi.advanceTimersByTime(1001);
    expect(s.o.progress).toMatchObject({ state: 'failed', error: 'No reply from the controller to G10 L2 P0 X0 Y0' });

    s = setup();
    s.o.start();
    s.o.connectionLost();
    expect(s.o.progress.state).toBe('failed');
  });

  it('ignores everything once finished', () => {
    const { o, sent, updates } = setup();
    o.start();
    o.handleLine('error:9');
    const n = updates.length;
    o.handleLine('ok');
    o.handleLine('<Idle|MPos:0,0,0>');
    o.start();
    expect(updates).toHaveLength(n);
    expect(sent).toHaveLength(1);
  });
});

describe('describeOrigin', () => {
  it('explains the limit window that is left after a work-offset-only origin', () => {
    expect(describeOrigin({ mode: 'machine' })).toMatch(/limits now count from here/);
    const msg = describeOrigin({ mode: 'offset', offset: { x: 120, y: 80 }, reason: 'old config' });
    expect(msg).toContain('X -120 to 280, Y -80 to 320');
    expect(msg).toContain('firmware/config.yaml');
    expect(describeOrigin({ mode: 'offset', reason: 'x' })).not.toContain('Reachable');
  });
});
