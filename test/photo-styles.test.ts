import { describe, expect, it } from 'vitest';
import { dist, polylineLength } from '../src/geometry';
import { clipLine, hatch, hatchThresholds, spiral, squiggle } from '../src/photo-styles';
import type { ToneGrid } from '../src/tone';

/** Darkness grid from f(x, y) in 0..1 (1 black). */
function grid(w: number, h: number, f: (x: number, y: number) => number): ToneGrid {
  const values = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) values[j * w + i] = f(i, j);
  return { width: w, height: h, values };
}

const place = { x: 10, y: 10, width: 100, height: 60 };
const inside = (p: { x: number; y: number }) =>
  p.x >= place.x - 1e-9 && p.x <= place.x + place.width + 1e-9 && p.y >= place.y - 1e-9 && p.y <= place.y + place.height + 1e-9;

describe('squiggle', () => {
  // Left half white, right half black.
  const g = grid(40, 20, (x) => (x < 20 ? 0 : 1));
  const opts = { lines: 10, amplitude: 0.5, frequency: 1 };

  it('draws one row per line, alternating direction, spanning the width', () => {
    const rows = squiggle(g, place, opts);
    expect(rows).toHaveLength(10);
    expect(rows[0][0].x).toBeCloseTo(10);
    expect(rows[1][0].x).toBeCloseTo(110);
    for (const r of rows) for (const p of r) expect(inside(p)).toBe(true);
  });

  it('stays flat on white and wiggles up to the amplitude on black', () => {
    const row = squiggle(g, place, opts)[0];
    const yc = 10 + 3; // row gap is 6 mm
    const light = row.filter((p) => p.x < 50);
    const dark = row.filter((p) => p.x > 70);
    for (const p of light) expect(Math.abs(p.y - yc)).toBeLessThan(0.05);
    const peak = Math.max(...dark.map((p) => Math.abs(p.y - yc)));
    expect(peak).toBeGreaterThan(2.5);
    expect(peak).toBeLessThanOrEqual(3 + 1e-9);
    // Flat runs simplify away: far fewer points on the white half.
    expect(light.length).toBeLessThan(dark.length / 5);
  });
});

describe('spiral', () => {
  const opts = { spacing: 2, amplitude: 0.5, frequency: 0.5 };

  it('is one stroke from the centre out to the inscribed circle', () => {
    const lines = spiral(grid(10, 6, () => 0), place, opts);
    expect(lines).toHaveLength(1);
    const s = lines[0];
    const c = { x: 60, y: 40 };
    expect(dist(s[0], c)).toBeLessThan(1e-9);
    const maxR = Math.max(...s.map((p) => dist(p, c)));
    expect(maxR).toBeCloseTo(30 - 1, 1);
    // An Archimedean spiral of radius R and spacing a is about π R² / a long.
    expect(polylineLength(s)).toBeGreaterThan((Math.PI * 29 * 29) / 2 * 0.95);
  });

  it('wobbles only where the photo is dark, never past the placement', () => {
    const c = { x: 60, y: 40 };
    const flat = spiral(grid(10, 6, () => 0), place, opts)[0];
    const dark = spiral(grid(10, 6, () => 1), place, opts)[0];
    for (const p of dark) expect(inside(p)).toBe(true);
    // Wobble shows up as extra length.
    expect(polylineLength(dark)).toBeGreaterThan(polylineLength(flat) * 1.1);
    // Radius never steps backwards by more than the wobble on a flat spiral.
    for (let i = 1; i < flat.length; i++) expect(dist(flat[i], c)).toBeGreaterThanOrEqual(dist(flat[i - 1], c) - 1e-6);
  });

  it('returns nothing when the wobble does not fit', () => {
    expect(spiral(grid(2, 2, () => 1), { x: 0, y: 0, width: 1, height: 1 }, { spacing: 2, amplitude: 1, frequency: 1 })).toEqual([]);
  });
});

describe('hatching', () => {
  it('spaces thresholds evenly between white and black', () => {
    expect(hatchThresholds(1)).toEqual([0.5]);
    expect(hatchThresholds(4).map((t) => +t.toFixed(2))).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(hatchThresholds(9)).toHaveLength(4);
  });

  it('clips lines to the placement', () => {
    expect(clipLine({ x: 60, y: 40 }, { x: 1, y: 0 }, place)).toEqual([-50, 50]);
    expect(clipLine({ x: 60, y: 0 }, { x: 1, y: 0 }, place)).toBeUndefined();
    const [t0, t1] = clipLine({ x: 60, y: 40 }, { x: Math.SQRT1_2, y: Math.SQRT1_2 }, place)!;
    expect(t1 - t0).toBeCloseTo(60 * Math.SQRT2);
  });

  it('adds layers as the photo gets darker', () => {
    const count = (d: number) => hatch(grid(10, 6, () => d), place, { spacing: 2, angle: 0, layers: 4 }).length;
    expect(count(0)).toBe(0);
    expect(count(0.3)).toBeGreaterThan(0);
    expect(count(0.5)).toBeGreaterThan(count(0.3));
    expect(count(0.7)).toBeGreaterThan(count(0.5));
    expect(count(1)).toBeGreaterThan(count(0.7));
  });

  it('draws horizontal lines at the requested spacing, clipped to the dark region', () => {
    // Dark only in the left half.
    const lines = hatch(grid(20, 6, (x) => (x < 10 ? 1 : 0)), place, { spacing: 2, angle: 0, layers: 1 });
    expect(lines.length).toBeGreaterThan(25);
    for (const l of lines) {
      expect(l).toHaveLength(2);
      expect(l[0].y).toBeCloseTo(l[1].y);
      expect(Math.max(l[0].x, l[1].x)).toBeLessThanOrEqual(60.5);
      expect(Math.min(l[0].x, l[1].x)).toBeCloseTo(10, 0);
      for (const p of l) expect(inside(p)).toBe(true);
    }
    const ys = [...new Set(lines.map((l) => l[0].y.toFixed(3)))].map(Number).sort((a, b) => a - b);
    expect(ys[1] - ys[0]).toBeCloseTo(2);
  });
});
