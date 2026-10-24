import { describe, expect, it } from 'vitest';
import type { Point } from '../src/geometry';
import { nearestNeighbourTour, orderLines, rng, stipple, tourLength, tspPath, twoOptTour } from '../src/stipple';
import type { ToneGrid } from '../src/tone';

function grid(w: number, h: number, f: (x: number, y: number) => number): ToneGrid {
  const values = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) values[j * w + i] = f(i, j);
  return { width: w, height: h, values };
}

const isPermutation = (order: ArrayLike<number>, n: number) => [...Array.from(order)].sort((a, b) => a - b).every((v, i) => v === i) && order.length === n;

describe('rng', () => {
  it('is deterministic per seed and in [0, 1)', () => {
    const a = rng(7);
    const b = rng(7);
    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(rng(8)()).not.toBe(xs[0]);
  });
});

describe('stipple', () => {
  it('puts points only where there is ink, denser where darker', () => {
    // Left third white, middle grey, right third black.
    const g = grid(30, 20, (x) => (x < 10 ? 0 : x < 20 ? 0.25 : 1));
    const pts = stipple(g, 500, { seed: 3, iterations: 10 });
    expect(pts).toHaveLength(500);
    const white = pts.filter((p) => p.x < 10).length;
    const grey = pts.filter((p) => p.x >= 10 && p.x < 20).length;
    const black = pts.filter((p) => p.x >= 20).length;
    expect(white).toBe(0);
    expect(black).toBeGreaterThan(grey * 2.5);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(30);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(20);
    }
  });

  it('relaxation spreads points evenly on a flat tone', () => {
    const g = grid(40, 40, () => 1);
    const minGap = (pts: Point[]) => {
      let m = Infinity;
      for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) m = Math.min(m, Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y));
      return m;
    };
    const raw = stipple(g, 100, { seed: 1, iterations: 0 });
    const relaxed = stipple(g, 100, { seed: 1, iterations: 30 });
    expect(minGap(relaxed)).toBeGreaterThan(minGap(raw) * 3);
  });

  it('returns nothing for a white image or zero points', () => {
    expect(stipple(grid(10, 10, () => 0), 100)).toEqual([]);
    expect(stipple(grid(10, 10, () => 1), 0)).toEqual([]);
  });
});

describe('tour', () => {
  // Points around a circle, in scrambled order: the best open tour walks the circle.
  const n = 60;
  const rand = rng(11);
  const circle: Point[] = Array.from({ length: n }, (_, k) => ({ x: 50 + 40 * Math.cos((2 * Math.PI * k) / n), y: 50 + 40 * Math.sin((2 * Math.PI * k) / n) }));
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [circle[i], circle[j]] = [circle[j], circle[i]];
  }
  const step = 2 * 40 * Math.sin(Math.PI / n);
  const optimal = step * (n - 1);

  it('nearest neighbour visits every point once', () => {
    const order = nearestNeighbourTour(circle);
    expect(isPermutation(order, n)).toBe(true);
  });

  it('2-opt untangles a random order to the near-optimal circle walk', () => {
    const order = Int32Array.from({ length: n }, (_, i) => i);
    const before = tourLength(circle, order);
    expect(twoOptTour(circle, order)).toBe(false);
    expect(isPermutation(order, n)).toBe(true);
    const after = tourLength(circle, order);
    expect(after).toBeLessThan(before / 5);
    expect(after).toBeLessThan(optimal * 1.1);
  });

  it('2-opt never makes a nearest-neighbour tour longer', () => {
    const r = rng(5);
    const pts = Array.from({ length: 400 }, () => ({ x: r() * 100, y: r() * 100 }));
    const order = nearestNeighbourTour(pts);
    const nn = tourLength(pts, order);
    twoOptTour(pts, order);
    expect(isPermutation(order, pts.length)).toBe(true);
    expect(tourLength(pts, order)).toBeLessThan(nn);
  });

  it('stops at the deadline', () => {
    const r = rng(9);
    const pts = Array.from({ length: 2000 }, () => ({ x: r() * 100, y: r() * 100 }));
    const { path, timedOut } = tspPath(pts, performance.now() - 1);
    expect(timedOut).toBe(true);
    expect(path).toHaveLength(2000);
  });
});

describe('orderLines', () => {
  it('chains lines end to end, reversing where that is shorter', () => {
    const a = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const b = [
      { x: 30, y: 0 },
      { x: 20, y: 0 },
    ];
    const c = [
      { x: 11, y: 0 },
      { x: 19, y: 0 },
    ];
    const out = orderLines([b, a, c]);
    expect(out).toEqual([a, c, b.slice().reverse()]);
  });
});
