import { describe, expect, it } from 'vitest';
import { newId } from '../src/drawing';
import { drawableRect, insideRect, polylineLength } from '../src/geometry';
import { buildJob } from '../src/job';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { ElevationGrid } from '../src/terrain';
import { buildTopo, DEFAULT_TOPO_OPTIONS, filterFragments, fitToArea, gridToPaper, MAX_LEVELS, topoLevels, type TopoOptions } from '../src/topo';

function grid(nx: number, ny: number, f: (x: number, y: number) => number): ElevationGrid {
  const values = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) values[j * nx + i] = f(i, j);
  return { nx, ny, values, min: Math.min(...values), max: Math.max(...values) };
}

const area = drawableRect(400, 300, 10);
const opts = (o: Partial<TopoOptions> = {}): TopoOptions => ({ ...DEFAULT_TOPO_OPTIONS, smoothing: 0, simplify: 0, minLength: 0, ...o });

describe('fitting', () => {
  it('fits a wide box to the width and centres it vertically', () => {
    const p = fitToArea({ width: 2000, height: 500 }, area);
    expect(p).toEqual({ x: 10, y: 10 + (280 - 95) / 2, width: 380, height: 95 });
  });

  it('fits a tall box to the height and centres it horizontally', () => {
    const p = fitToArea({ width: 1, height: 2 }, area);
    expect(p.height).toBe(280);
    expect(p.width).toBe(140);
    expect(p.x).toBe(130);
    expect(p.y).toBe(10);
  });

  it('maps grid corners to the placement corners, north at the top', () => {
    const place = { x: 10, y: 20, width: 100, height: 50 };
    expect(gridToPaper({ x: 0, y: 0 }, 11, 6, place)).toEqual({ x: 10, y: 20 });
    expect(gridToPaper({ x: 10, y: 5 }, 11, 6, place)).toEqual({ x: 110, y: 70 });
    expect(gridToPaper({ x: 5, y: 2.5 }, 11, 6, place)).toEqual({ x: 60, y: 45 });
  });
});

describe('filterFragments', () => {
  it('drops lines shorter than the minimum', () => {
    const long = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
    ];
    const short = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(filterFragments([long, short, [{ x: 3, y: 3 }]], 3)).toEqual({ kept: [long], dropped: 2 });
  });
});

describe('topoLevels', () => {
  it('thins out impossible level counts', () => {
    const r = topoLevels(0, 10000, opts({ value: 1 }));
    expect(r.capped).toBe(true);
    expect(r.levels.length).toBeLessThanOrEqual(MAX_LEVELS);
    const c = topoLevels(0, 100, opts({ mode: 'count', value: 1000 }));
    expect(c.capped).toBe(true);
    expect(c.levels).toHaveLength(MAX_LEVELS);
    expect(topoLevels(0, 100, opts({ value: 10 }))).toEqual({ levels: [10, 20, 30, 40, 50, 60, 70, 80, 90], capped: false });
  });
});

describe('buildTopo', () => {
  // A round hill rising to 1000 m, about 99 m in the grid corners, on a 60 × 40 grid.
  const hill = grid(60, 40, (x, y) => 1000 - 25 * Math.hypot(x - 30, y - 20));
  const place = fitToArea({ width: 6000, height: 4000 }, area);

  it('rings the hill once per level, inside the drawable area', () => {
    const r = buildTopo(hill, place, area, opts({ value: 100 }));
    // The low levels run off the grid edge and are open lines; the high ones are rings.
    expect(r.levels).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(r.lines.length).toBeGreaterThanOrEqual(9);
    for (const l of r.lines) for (const p of l) expect(insideRect(p, area)).toBe(true);
    // The 900 m ring has a radius of 4 cells.
    const rings = r.lines.filter((l) => l[0].x === l[l.length - 1].x && l[0].y === l[l.length - 1].y);
    const ring = rings.reduce((a, b) => (polylineLength(a) < polylineLength(b) ? a : b));
    const cx = place.x + (30 / 59) * place.width;
    const cy = place.y + (20 / 39) * place.height;
    for (const p of ring) expect(Math.hypot(p.x - cx, p.y - cy)).toBeCloseTo((4 / 59) * place.width, 0);
  });

  it('drops fragments, simplifies and smooths', () => {
    const raw = buildTopo(hill, place, area, opts({ value: 100 }));
    const filtered = buildTopo(hill, place, area, opts({ value: 100, minLength: 50 }));
    expect(filtered.dropped).toBeGreaterThan(0);
    expect(filtered.lines.length).toBe(raw.lines.length - filtered.dropped);
    for (const l of filtered.lines) expect(polylineLength(l)).toBeGreaterThanOrEqual(50);
    const simple = buildTopo(hill, place, area, opts({ value: 100, simplify: 1 }));
    const points = (ls: typeof raw.lines) => ls.reduce((n, l) => n + l.length, 0);
    expect(points(simple.lines)).toBeLessThan(points(raw.lines) / 2);
    const smooth = buildTopo(hill, place, area, opts({ value: 100, smoothing: 3 }));
    expect(smooth.lines.length).toBeGreaterThan(0);
  });

  it('returns nothing for flat ground', () => {
    const r = buildTopo(grid(20, 20, () => 42), place, area, opts({ value: 10 }));
    expect(r.lines).toEqual([]);
    expect(r.levels).toEqual([]);
  });

  it('goes through the Send pipeline as ordinary strokes', () => {
    const settings = { ...DEFAULT_SETTINGS, paperWidth: 400, paperHeight: 300, margin: 10, optimizeTimeMs: 50 };
    const r = buildTopo(hill, place, area, { ...DEFAULT_TOPO_OPTIONS, value: 100 });
    const job = buildJob(
      r.lines.map((points) => ({ id: newId(), kind: 'freehand' as const, points })),
      settings,
    );
    expect(job.bounds.ok).toBe(true);
    expect(job.gcode.length).toBeGreaterThan(0);
    expect(job.plan.inputCount).toBe(r.lines.length);
  });
});
