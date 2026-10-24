import { describe, expect, it } from 'vitest';
import { detectEdges, sobel, traceEdges } from '../src/edges';
import type { ToneGrid } from '../src/tone';

function grid(w: number, h: number, f: (x: number, y: number) => number): ToneGrid {
  const values = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) values[j * w + i] = f(i, j);
  return { width: w, height: h, values };
}

describe('sobel', () => {
  it('is zero on a flat image and points across a vertical step', () => {
    expect(Math.max(...sobel(new Float32Array(25).fill(0.4), 5, 5).mag)).toBe(0);
    const { mag, gx, gy } = sobel(grid(6, 3, (x) => (x < 3 ? 0 : 1)).values, 6, 3);
    expect(mag[1 * 6 + 2]).toBe(4);
    expect(gx[1 * 6 + 2]).toBe(4);
    expect(gy[1 * 6 + 2]).toBe(0);
    expect(mag[1 * 6 + 0]).toBe(0);
  });
});

describe('detectEdges', () => {
  it('finds nothing in a flat image', () => {
    const mask = detectEdges(grid(20, 20, () => 0.5), { blur: 1, threshold: 0.3 });
    expect(mask.every((m) => m === 0)).toBe(true);
  });

  it('marks a thin line along a vertical step', () => {
    const w = 20;
    const h = 10;
    const mask = detectEdges(grid(w, h, (x) => (x < 10 ? 0 : 1)), { blur: 1, threshold: 0.3 });
    for (let j = 1; j < h - 1; j++) {
      const row = Array.from(mask.slice(j * w, (j + 1) * w));
      expect(row.reduce((a, b) => a + b, 0)).toBe(1);
      expect(Math.abs(row.indexOf(1) - 9.5)).toBeLessThanOrEqual(1);
    }
  });
});

describe('traceEdges', () => {
  it('follows an open diagonal-and-straight chain from one end to the other', () => {
    const w = 6;
    const mask = new Uint8Array(w * 4);
    for (const [i, j] of [
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 3],
    ])
      mask[j * w + i] = 1;
    const lines = traceEdges(mask, w, 4);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(6);
    expect(lines[0][0]).toEqual({ x: 0.5, y: 0.5 });
    expect(lines[0][5]).toEqual({ x: 5.5, y: 3.5 });
  });

  it('closes a ring into a loop', () => {
    const w = 5;
    const mask = new Uint8Array(w * w);
    for (let k = 1; k <= 3; k++) {
      mask[1 * w + k] = 1;
      mask[3 * w + k] = 1;
      mask[k * w + 1] = 1;
      mask[k * w + 3] = 1;
    }
    const lines = traceEdges(mask, w, w);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(9);
    expect(lines[0][0]).toEqual(lines[0][8]);
  });

  it('traces a dark square on white as one closed outline', () => {
    const w = 30;
    const g = grid(w, w, (x, y) => (x >= 8 && x < 22 && y >= 8 && y < 22 ? 1 : 0));
    const lines = traceEdges(detectEdges(g, { blur: 1, threshold: 0.3 }), w, w);
    const longest = lines.reduce((a, b) => (b.length > a.length ? b : a));
    // About the perimeter of a 14-pixel square.
    expect(longest.length).toBeGreaterThan(45);
    expect(longest.length).toBeLessThan(65);
    for (const p of longest) {
      const onEdge = Math.min(Math.abs(p.x - 8), Math.abs(p.x - 22), Math.abs(p.y - 8), Math.abs(p.y - 22));
      expect(onEdge).toBeLessThanOrEqual(1.5);
    }
  });
});
