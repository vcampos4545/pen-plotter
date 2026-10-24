import { describe, expect, it } from 'vitest';
import { blurGrid, isolines, levelsByCount, levelsByInterval, niceInterval } from '../src/contour';

/** nx × ny grid of f(x, y). */
function grid(nx: number, ny: number, f: (x: number, y: number) => number): Float32Array {
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) out[j * nx + i] = f(i, j);
  return out;
}

/** Value at a contour point by linear interpolation along the grid edge it lies on. */
function edgeValue(values: Float32Array, nx: number, p: { x: number; y: number }): number {
  const i = Math.floor(p.x);
  const j = Math.floor(p.y);
  const v = (a: number, b: number) => values[b * nx + a];
  if (p.x === i) return v(i, j) + (v(i, Math.min(j + 1, values.length / nx - 1)) - v(i, j)) * (p.y - j);
  return v(i, j) + (v(Math.min(i + 1, nx - 1), j) - v(i, j)) * (p.x - i);
}

describe('isolines', () => {
  it('rings a peak with one closed loop per level', () => {
    const n = 41;
    const cone = grid(n, n, (x, y) => 100 - Math.hypot(x - 20, y - 20));
    const lines = isolines(cone, n, n, 90);
    expect(lines).toHaveLength(1);
    const ring = lines[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const p of ring) expect(Math.hypot(p.x - 20, p.y - 20)).toBeCloseTo(10, 0);
  });

  it('runs an open line from edge to edge on a slope', () => {
    const ramp = grid(10, 6, (x) => x * 10);
    const lines = isolines(ramp, 10, 6, 35);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(6);
    for (const p of lines[0]) expect(p.x).toBeCloseTo(3.5, 9);
    const ys = lines[0].map((p) => p.y).sort((a, b) => a - b);
    expect(ys).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('resolves saddles by the cell average', () => {
    // Centre average 0.5 counts as above, so the high corners connect and the low ones are cut off.
    const lines = isolines(Float32Array.from([1, 0, 0, 1]), 2, 2, 0.5);
    expect(lines).toHaveLength(2);
    const cutCorners = lines.map((l) => l.map((p) => `${p.x},${p.y}`).sort().join(' ')).sort();
    expect(cutCorners).toEqual(['0,0.5 0.5,1', '0.5,0 1,0.5']);
  });

  it('skips cells with missing data', () => {
    const ramp = grid(4, 3, (x) => x);
    ramp[0] = NaN;
    const lines = isolines(ramp, 4, 3, 0.5);
    expect(lines.flat().every((p) => p.y >= 1)).toBe(true);
  });

  it('produces only points on the level, fully stitched', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 100;
    const nx = 30;
    const ny = 20;
    const values = blurGrid(grid(nx, ny, () => rand()), nx, ny, 3);
    for (const level of [30, 50, 70]) {
      const lines = isolines(values, nx, ny, level);
      expect(lines.length).toBeGreaterThan(0);
      const ends = new Set<string>();
      for (const l of lines) {
        for (const p of l) expect(edgeValue(values, nx, p)).toBeCloseTo(level, 3);
        const a = l[0];
        const b = l[l.length - 1];
        if (a.x === b.x && a.y === b.y) continue;
        // Open lines must end on the border, never mid-grid next to another fragment.
        for (const p of [a, b]) {
          expect(p.x === 0 || p.y === 0 || p.x === nx - 1 || p.y === ny - 1).toBe(true);
          const key = `${p.x},${p.y}`;
          expect(ends.has(key)).toBe(false);
          ends.add(key);
        }
      }
    }
  });

  it('finds nothing on a flat grid or outside the range', () => {
    const flat = grid(5, 5, () => 10);
    expect(isolines(flat, 5, 5, 20)).toEqual([]);
    expect(isolines(flat, 5, 5, 5)).toEqual([]);
  });
});

describe('blurGrid', () => {
  it('keeps flat data flat and softens spikes', () => {
    expect(Array.from(blurGrid(new Float32Array(12).fill(3), 4, 3, 2))).toEqual(new Array(12).fill(3));
    const spike = new Float32Array(25);
    spike[12] = 16;
    const out = blurGrid(spike, 5, 5, 1);
    expect(out[12]).toBe(4);
    expect(out[11]).toBe(2);
    expect(out[6]).toBe(1);
    expect(spike[12]).toBe(16); // input untouched
    expect(blurGrid(spike, 5, 5, 0)).not.toBe(spike);
  });
});

describe('levels', () => {
  it('places levels on multiples of the interval inside the range', () => {
    expect(levelsByInterval(0, 500, 100)).toEqual([100, 200, 300, 400]);
    expect(levelsByInterval(-50, 250, 100)).toEqual([0, 100, 200]);
    expect(levelsByInterval(1203, 1450, 50)).toEqual([1250, 1300, 1350, 1400]);
    expect(levelsByInterval(0, 100, 0)).toEqual([]);
    expect(levelsByInterval(5, 5, 1)).toEqual([]);
  });

  it('spaces a count of levels evenly', () => {
    expect(levelsByCount(0, 100, 4)).toEqual([20, 40, 60, 80]);
    expect(levelsByCount(0, 0, 4)).toEqual([]);
  });

  it('rounds intervals to 1, 2 or 5 steps', () => {
    expect(niceInterval(0, 1000, 20)).toBe(50);
    expect(niceInterval(1200, 4400, 20)).toBe(200);
    expect(niceInterval(0, 33, 20)).toBe(2);
    expect(niceInterval(5, 5)).toBe(10);
  });
});
