import { describe, expect, it } from 'vitest';
import { gcd, harmonograph, HARMONOGRAPH_END, spirograph, spirographLoops } from '../src/curves';
import { dist } from '../src/geometry';

describe('spirograph', () => {
  it('computes loops from the gcd of the tooth counts', () => {
    expect(gcd(96, 52)).toBe(4);
    expect(spirographLoops({ ring: 96, wheel: 52 })).toBe(13);
    expect(spirographLoops({ ring: 100, wheel: 25 })).toBe(1);
    expect(spirographLoops({ ring: 101, wheel: 30 })).toBe(30);
  });

  it.each([
    { ring: 96, wheel: 52, pen: 0.8, outside: false },
    { ring: 101, wheel: 30, pen: 1.2, outside: false },
    { ring: 60, wheel: 45, pen: 0.5, outside: true },
    { ring: 57, wheel: 63, pen: 1, outside: true },
  ])('closes exactly and never closes early: %o', (o) => {
    const line = spirograph(o);
    const start = line[0];
    expect(dist(line[line.length - 1], start)).toBeLessThan(1e-9);
    // Before the last loop the pen does not return to the start with the same heading.
    const loops = spirographLoops(o);
    const perLoop = (line.length - 1) / loops;
    for (let k = 1; k < loops; k++) {
      const i = Math.round(k * perLoop);
      expect(dist(line[i], start)).toBeGreaterThan(1e-6);
    }
  });

  it('stays within ring ± wheel + pen', () => {
    const o = { ring: 80, wheel: 30, pen: 1.5, outside: false };
    const bound = o.ring - o.wheel + o.pen * o.wheel + 1e-9;
    for (const p of spirograph(o)) expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(bound);
  });
});

describe('harmonograph', () => {
  const o = { freqX: 3, freqY: 2, phaseX: 0, phaseY: 90, freqR: 1.003, rotary: 0.4, damping: 0.03, duration: 60 };

  it('is deterministic and decays', () => {
    const a = harmonograph(o);
    expect(harmonograph(o)).toEqual(a);
    const r = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);
    const head = Math.max(...a.slice(0, 200).map(r));
    const tail = Math.max(...a.slice(-200).map(r));
    expect(tail).toBeLessThan(head * 0.5);
  });

  it('stops once the swing has died down', () => {
    const long = harmonograph({ ...o, duration: 1000 });
    const r = Math.max(...long.slice(-50).map((p) => Math.hypot(p.x, p.y)));
    // Amplitude of each axis is at most 1 + rotary.
    expect(r).toBeLessThanOrEqual(HARMONOGRAPH_END * (1 + o.rotary) * Math.SQRT2 + 1e-9);
    expect(long.length).toBeLessThan(harmonograph({ ...o, damping: 0, duration: 1000 }).length);
  });
});
