import { describe, expect, it } from 'vitest';
import { fractal2, perlin2 } from '../src/noise';

describe('perlin2', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = perlin2(5);
    const b = perlin2(5);
    const c = perlin2(6);
    const pts = Array.from({ length: 50 }, (_, i) => [i * 0.37 + 0.1, i * 0.61 + 0.2]);
    expect(pts.map(([x, y]) => a(x, y))).toEqual(pts.map(([x, y]) => b(x, y)));
    expect(pts.some(([x, y]) => Math.abs(a(x, y) - c(x, y)) > 0.05)).toBe(true);
  });

  it('is zero on the lattice, stays in -1..1 and varies smoothly', () => {
    const n = perlin2(1);
    expect(n(3, 7)).toBeCloseTo(0, 12);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 20_000; i++) {
      const x = (i % 200) * 0.0513;
      const y = Math.floor(i / 200) * 0.0729;
      const v = n(x, y);
      min = Math.min(min, v);
      max = Math.max(max, v);
      // Gradient is bounded, so a tiny move gives a tiny change.
      expect(Math.abs(n(x + 1e-4, y) - v)).toBeLessThan(1e-3);
    }
    expect(min).toBeGreaterThanOrEqual(-1);
    expect(max).toBeLessThanOrEqual(1);
    expect(max - min).toBeGreaterThan(1);
  });

  it('fractal noise is deterministic and stays in range', () => {
    const f = fractal2(9, 3);
    const g = fractal2(9, 3);
    for (let i = 0; i < 1000; i++) {
      const v = f(i * 0.13, i * 0.07);
      expect(v).toBe(g(i * 0.13, i * 0.07));
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });
});
