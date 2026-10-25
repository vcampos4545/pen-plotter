import { describe, expect, it } from 'vitest';
import { newId } from '../src/drawing';
import { drawableRect, insideRect, polylineLength, type Point, type Polyline } from '../src/geometry';
import { buildJob } from '../src/job';
import {
  buildRidges,
  clipToSkyline,
  DEFAULT_RIDGE_OPTIONS,
  edgeFade,
  fitRidges,
  MAX_RIDGE_LINES,
  sampleRow,
  sanitizeRidgeOptions,
  type RidgeOptions,
} from '../src/ridgeline';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { ElevationGrid } from '../src/terrain';

function grid(nx: number, ny: number, f: (x: number, y: number) => number): ElevationGrid {
  const values = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) values[j * nx + i] = f(i, j);
  return { nx, ny, values, min: Math.min(...values), max: Math.max(...values) };
}

const area = drawableRect(400, 300, 10);
const ground = { width: 40000, height: 30000 };
const opts = (o: Partial<RidgeOptions> = {}): RidgeOptions => ({ ...DEFAULT_RIDGE_OPTIONS, smoothing: 0, simplify: 0, minLength: 0, ...o });
/** A round mountain in the middle of an 80 × 60 grid, 0 to 2000 m. */
const mountain = grid(80, 60, (x, y) => 2000 * Math.exp(-((x - 40) ** 2 + (y - 30) ** 2) / 120));

/** True when segments a-b and c-d cross. Touching (a clip point on the skyline) does not count. */
function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const orient = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const eps = 1e-6;
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

function anyCrossing(lines: Polyline[]): boolean {
  for (let p = 0; p < lines.length; p++) {
    for (let q = p + 1; q < lines.length; q++) {
      const a = lines[p];
      const b = lines[q];
      for (let i = 1; i < a.length; i++) {
        for (let j = 1; j < b.length; j++) if (crosses(a[i - 1], a[i], b[j - 1], b[j])) return true;
      }
    }
  }
  return false;
}

describe('options', () => {
  it('fills defaults and clamps', () => {
    expect(sanitizeRidgeOptions(null)).toEqual(DEFAULT_RIDGE_OPTIONS);
    const o = sanitizeRidgeOptions({ lines: 9999, height: -3, baseline: 'yes' as unknown as boolean, smoothing: 2.6, simplify: 50, minLength: Number.NaN });
    expect(o).toEqual({ lines: MAX_RIDGE_LINES, height: 0, baseline: false, smoothing: 3, simplify: 10, minLength: DEFAULT_RIDGE_OPTIONS.minLength });
    expect(sanitizeRidgeOptions({ lines: 1 }).lines).toBe(2);
    expect(sanitizeRidgeOptions({ baseline: true }).baseline).toBe(true);
  });
});

describe('layout', () => {
  it('keeps the ground proportions and leaves headroom for the back row', () => {
    const l = fitRidges(ground, area, 61, 6);
    expect(l.width / (l.bottom - l.top)).toBeCloseTo(ground.width / ground.height, 9);
    // 6 of the 60 gaps above the back row.
    expect(l.peak).toBeCloseTo((l.bottom - l.top) / 10, 9);
    expect(l.top - l.peak).toBeGreaterThanOrEqual(area.minY - 1e-9);
    expect(l.bottom).toBeLessThanOrEqual(area.maxY + 1e-9);
    expect(l.x).toBeGreaterThanOrEqual(area.minX - 1e-9);
    expect(l.x + l.width).toBeLessThanOrEqual(area.maxX + 1e-9);
    // Height-limited here, so it fills the height and centres horizontally.
    expect(l.bottom - (l.top - l.peak)).toBeCloseTo(area.maxY - area.minY, 9);
    expect(l.x - area.minX).toBeCloseTo(area.maxX - (l.x + l.width), 9);
  });

  it('fills the width for a wide box', () => {
    const l = fitRidges({ width: 10, height: 1 }, area, 20, 4);
    expect(l.x).toBeCloseTo(area.minX, 9);
    expect(l.width).toBeCloseTo(area.maxX - area.minX, 9);
  });

  it('fades to zero at the edges and is flat in the middle', () => {
    expect(edgeFade(0)).toBe(0);
    expect(edgeFade(1)).toBe(0);
    expect(edgeFade(0.5)).toBe(1);
    expect(edgeFade(0.2)).toBe(1);
    expect(edgeFade(0.075)).toBeCloseTo(0.5, 9);
    let prev = -1;
    for (let t = 0; t <= 0.5; t += 0.01) {
      expect(edgeFade(t)).toBeGreaterThanOrEqual(prev);
      prev = edgeFade(t);
    }
  });

  it('interpolates between grid rows', () => {
    const g = grid(3, 3, (x, y) => 10 * y + x);
    expect(Array.from(sampleRow(g.values, 3, 3, 0))).toEqual([0, 1, 2]);
    expect(Array.from(sampleRow(g.values, 3, 3, 1.5))).toEqual([15, 16, 17]);
    expect(Array.from(sampleRow(g.values, 3, 3, 2))).toEqual([20, 21, 22]);
  });
});

describe('clipToSkyline', () => {
  const xs = [0, 1, 2, 3, 4];

  it('keeps the first row whole and raises the skyline to it', () => {
    const sky = new Float64Array(5).fill(Infinity);
    const pieces = clipToSkyline(xs, [10, 9, 8, 9, 10], sky);
    expect(pieces).toEqual([xs.map((x, i) => ({ x, y: [10, 9, 8, 9, 10][i] }))]);
    expect(Array.from(sky)).toEqual([10, 9, 8, 9, 10]);
  });

  it('hides a row entirely behind the one in front', () => {
    const sky = Float64Array.from([5, 5, 5, 5, 5]);
    expect(clipToSkyline(xs, [6, 6, 5, 7, 6], sky)).toEqual([]);
    expect(Array.from(sky)).toEqual([5, 5, 5, 5, 5]);
  });

  it('splits a row where it passes behind, ending exactly on the skyline', () => {
    const sky = Float64Array.from([10, 10, 10, 10, 10]);
    // Above, dips behind in the middle, above again.
    const pieces = clipToSkyline(xs, [8, 8, 12, 8, 8], sky);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toEqual([
      { x: 0, y: 8 },
      { x: 1, y: 8 },
      { x: 1.5, y: 10 },
    ]);
    expect(pieces[1]).toEqual([
      { x: 2.5, y: 10 },
      { x: 3, y: 8 },
      { x: 4, y: 8 },
    ]);
    expect(Array.from(sky)).toEqual([8, 8, 10, 8, 8]);
  });

  it('starts a piece where a row climbs out from behind', () => {
    const sky = Float64Array.from([10, 10, 10, 10, 10]);
    const pieces = clipToSkyline(xs, [12, 12, 12, 10, 6], sky);
    expect(pieces).toEqual([
      [
        { x: 3, y: 10 },
        { x: 4, y: 6 },
      ],
    ]);
  });
});

describe('buildRidges', () => {
  it('draws flat ground as evenly spaced straight lines', () => {
    const r = buildRidges(grid(30, 20, () => 500), ground, area, opts({ lines: 11 }));
    expect(r.lines).toHaveLength(11);
    expect(r.exaggeration).toBe(0);
    const ys = r.lines.map((l) => l[0].y).sort((a, b) => a - b);
    for (const l of r.lines) for (const p of l) expect(p.y).toBeCloseTo(l[0].y, 9);
    for (let k = 1; k < ys.length; k++) expect(ys[k] - ys[k - 1]).toBeCloseTo((r.layout.bottom - r.layout.top) / 10, 9);
    expect(ys[0]).toBeCloseTo(r.layout.top, 9);
    expect(ys[10]).toBeCloseTo(r.layout.bottom, 9);
  });

  it('lifts the peak by the chosen number of line gaps and stays inside the margin', () => {
    const r = buildRidges(mountain, ground, area, opts({ lines: 30, height: 8 }));
    const gap = (r.layout.bottom - r.layout.top) / 29;
    expect(r.layout.peak).toBeCloseTo(8 * gap, 9);
    const top = Math.min(...r.lines.flat().map((p) => p.y));
    // The middle row passes over the summit; the summit is the highest ink on the page.
    expect(top).toBeGreaterThan(r.layout.top - r.layout.peak - 1e-6);
    for (const l of r.lines) for (const p of l) expect(insideRect(p, area)).toBe(true);
    // 2000 m over 8 gaps at 30 km of depth across the paper.
    const horizontal = r.layout.width / ground.width;
    expect(r.exaggeration).toBeCloseTo(r.layout.peak / (r.max - r.min) / horizontal, 9);
    expect(r.exaggeration).toBeGreaterThan(1);
  });

  it('removes hidden lines so no two profiles cross', () => {
    const r = buildRidges(mountain, ground, area, opts({ lines: 25, height: 10 }));
    // Rows behind the mountain are split into pieces either side of it.
    expect(r.lines.length).toBeGreaterThan(25);
    expect(anyCrossing(r.lines)).toBe(false);
    // Without clipping the same profiles would cross.
    const g = mountain;
    const raw: Polyline[] = [];
    for (let k = 0; k < 25; k++) {
      const elev = sampleRow(g.values, g.nx, g.ny, (k * (g.ny - 1)) / 24);
      const base = r.layout.top + (k * (r.layout.bottom - r.layout.top)) / 24;
      raw.push(Array.from(elev, (e, i) => ({ x: r.layout.x + (i / (g.nx - 1)) * r.layout.width, y: base - ((e - r.min) * r.layout.peak) / (r.max - r.min) })));
    }
    expect(anyCrossing(raw)).toBe(true);
  });

  it('flat baseline fades each profile to its baseline at the edges', () => {
    const ramp = grid(40, 20, (x) => 100 * x);
    const pure = buildRidges(ramp, ground, area, opts({ lines: 5, height: 1 }));
    const flat = buildRidges(ramp, ground, area, opts({ lines: 5, height: 1, baseline: true }));
    // A ramp rising east: pure profiles end high on the right, faded ones on their baseline.
    const front = (ls: Polyline[]) => ls.find((l) => Math.abs(l[0].y - pure.layout.bottom) < 1e-6)!;
    expect(front(pure.lines).at(-1)!.y).toBeLessThan(pure.layout.bottom - 1);
    expect(front(flat.lines).at(-1)!.y).toBeCloseTo(flat.layout.bottom, 9);
    expect(front(flat.lines)[0].y).toBeCloseTo(flat.layout.bottom, 9);
    expect(anyCrossing(flat.lines)).toBe(false);
  });

  it('drops short pieces, simplifies and smooths', () => {
    const raw = buildRidges(mountain, ground, area, opts({ lines: 40, height: 15 }));
    const filtered = buildRidges(mountain, ground, area, opts({ lines: 40, height: 15, minLength: 150 }));
    expect(filtered.dropped).toBeGreaterThan(0);
    expect(filtered.lines.length).toBe(raw.lines.length - filtered.dropped);
    for (const l of filtered.lines) expect(polylineLength(l)).toBeGreaterThanOrEqual(150);
    const points = (ls: Polyline[]) => ls.reduce((n, l) => n + l.length, 0);
    const simple = buildRidges(mountain, ground, area, opts({ lines: 40, height: 15, simplify: 0.5 }));
    expect(points(simple.lines)).toBeLessThan(points(raw.lines) / 2);
    const smooth = buildRidges(mountain, ground, area, opts({ lines: 40, height: 15, smoothing: 4 }));
    expect(smooth.max).toBeLessThan(raw.max);
    expect(anyCrossing(smooth.lines)).toBe(false);
  });

  it('goes through the Send pipeline as ordinary strokes', () => {
    const settings = { ...DEFAULT_SETTINGS, paperWidth: 400, paperHeight: 300, margin: 10, optimizeTimeMs: 50 };
    const r = buildRidges(mountain, ground, area, DEFAULT_RIDGE_OPTIONS);
    const job = buildJob(
      r.lines.map((points) => ({ id: newId(), kind: 'freehand' as const, points })),
      settings,
    );
    expect(job.bounds.ok).toBe(true);
    expect(job.gcode.length).toBeGreaterThan(0);
    expect(job.plan.inputCount).toBe(r.lines.length);
  });
});
