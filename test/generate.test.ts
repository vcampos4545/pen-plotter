import { describe, expect, it } from 'vitest';
import { newId } from '../src/drawing';
import { FLOW_STOP } from '../src/flowfield';
import {
  buildGenerate,
  DEFAULT_GENERATE_OPTIONS,
  fitLines,
  GEN_STYLES,
  randomizeOptions,
  sanitizeGenerateOptions,
  sizedArea,
  type GenerateOptions,
} from '../src/generate';
import { dist, drawableRect, insideRect, type Polyline } from '../src/geometry';
import { buildJob } from '../src/job';
import { DEFAULT_SETTINGS } from '../src/settings';
import { rng } from '../src/stipple';

const area = drawableRect(200, 150, 10);
const opts = (style: GenerateOptions['style'], extra: Partial<GenerateOptions> = {}): GenerateOptions => ({
  ...DEFAULT_GENERATE_OPTIONS,
  // Lighter than the defaults so the suite stays quick.
  lorenz: { ...DEFAULT_GENERATE_OPTIONS.lorenz, steps: 3000 },
  clifford: { ...DEFAULT_GENERATE_OPTIONS.clifford, density: 10 },
  dejong: { ...DEFAULT_GENERATE_OPTIONS.dejong, density: 10 },
  flow: { ...DEFAULT_GENERATE_OPTIONS.flow, spacing: 6 },
  ...extra,
  style,
});

function bbox(lines: Polyline[]) {
  const pts = lines.flat();
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxX: Math.max(...pts.map((p) => p.x)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
}

describe('sanitizeGenerateOptions', () => {
  it('fills defaults from nothing', () => {
    expect(sanitizeGenerateOptions(null)).toEqual(DEFAULT_GENERATE_OPTIONS);
    expect(sanitizeGenerateOptions({ style: 'nope', size: 'x' })).toEqual(DEFAULT_GENERATE_OPTIONS);
  });

  it('reads form strings and clamps', () => {
    const o = sanitizeGenerateOptions({
      style: 'maze',
      size: '500',
      maze: { seed: '12.4', cell: '0', solution: true },
      spirograph: { ring: '50', wheel: '80', outside: false },
    });
    expect(o.style).toBe('maze');
    expect(o.size).toBe(100);
    expect(o.maze).toEqual({ seed: 12, cell: 1, solution: true });
    // Inside the ring the wheel must be smaller than it.
    expect(o.spirograph.wheel).toBe(49);
    expect(sanitizeGenerateOptions({ spirograph: { ring: 50, wheel: 80, outside: true } }).spirograph.wheel).toBe(80);
  });
});

describe('fitting', () => {
  it('sizedArea shrinks about the centre', () => {
    expect(sizedArea(area, 100)).toEqual(area);
    expect(sizedArea(area, 50)).toEqual({ minX: 55, minY: 42.5, maxX: 145, maxY: 107.5 });
  });

  it('fitLines scales uniformly, centres and flips y', () => {
    const fitted = fitLines([[{ x: 0, y: 0 }, { x: 2, y: 1 }]], area);
    // 2:1 box into 180 × 130: width-limited, scale 90.
    expect(fitted[0][0]).toEqual({ x: 10, y: 75 + 45 });
    expect(fitted[0][1]).toEqual({ x: 190, y: 75 - 45 });
    expect(fitLines([], area)).toEqual([]);
  });
});

describe('buildGenerate', () => {
  it.each(GEN_STYLES)('%s fits inside the drawable area and repeats exactly', (style) => {
    const o = opts(style);
    const r = buildGenerate(area, o);
    expect(r.lines.length).toBeGreaterThan(0);
    for (const l of r.lines) {
      expect(l.length).toBeGreaterThanOrEqual(2);
      for (const p of l) expect(insideRect(p, area)).toBe(true);
    }
    expect(buildGenerate(area, o)).toEqual(r);
  });

  it.each(['spirograph', 'harmonograph', 'lorenz', 'clifford', 'dejong'] as const)('%s fills the area to the margin on one axis', (style) => {
    const b = bbox(buildGenerate(area, opts(style)).lines);
    const fillsX = b.minX - area.minX < 0.05 && area.maxX - b.maxX < 0.05;
    const fillsY = b.minY - area.minY < 0.05 && area.maxY - b.maxY < 0.05;
    expect(fillsX || fillsY).toBe(true);
  });

  it('size shrinks the drawing about the centre', () => {
    const b = bbox(buildGenerate(area, opts('spirograph', { size: 50 })).lines);
    const inner = sizedArea(area, 50);
    expect(b.minY).toBeGreaterThanOrEqual(inner.minY - 0.01);
    expect(b.maxY).toBeLessThanOrEqual(inner.maxY + 0.01);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(100, 1);
  });

  it('a spirograph is one closed stroke', () => {
    const r = buildGenerate(area, opts('spirograph'));
    expect(r.lines).toHaveLength(1);
    const l = r.lines[0];
    expect(dist(l[0], l[l.length - 1])).toBeLessThan(0.02);
    expect(r.notes[0]).toMatch(/13 trips/);
  });

  it('attractors are one continuous stroke each', () => {
    for (const style of ['lorenz', 'clifford', 'dejong'] as const) expect(buildGenerate(area, opts(style)).lines).toHaveLength(1);
  });

  it('keeps flow lines apart after rounding', () => {
    const o = opts('flow');
    const lines = buildGenerate(area, o).lines;
    // Simplification only drops points, so check the kept points of different lines.
    let best = Infinity;
    for (let a = 0; a < lines.length; a++) {
      for (let b = a + 1; b < lines.length; b++) {
        for (const p of lines[a]) for (const q of lines[b]) best = Math.min(best, dist(p, q));
      }
    }
    expect(best).toBeGreaterThanOrEqual(o.flow.spacing * FLOW_STOP - 0.015);
  });

  it('adds the maze solution as its own stroke', () => {
    const without = buildGenerate(area, opts('maze'));
    const withSol = buildGenerate(area, opts('maze', { maze: { ...DEFAULT_GENERATE_OPTIONS.maze, solution: true } }));
    expect(withSol.lines).toHaveLength(without.lines.length + 1);
    expect(withSol.lines.slice(0, -1)).toEqual(without.lines);
  });

  it('says so when the maze cells are too big', () => {
    const r = buildGenerate(area, opts('maze', { maze: { ...DEFAULT_GENERATE_OPTIONS.maze, cell: 100 } }));
    expect(r.lines).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/too big/);
  });

  it('flags attractor parameters that are not chaotic', () => {
    const r = buildGenerate(area, opts('clifford', { clifford: { a: 0.1, b: 0.1, c: 0.1, d: 0.1, density: 5 } }));
    expect(r.notes.join(' ')).toMatch(/not a strange attractor/);
  });

  it('turns into a job that stays inside the margin', () => {
    const lines = buildGenerate(area, opts('maze', { maze: { seed: 2, cell: 10, solution: true } })).lines;
    const job = buildJob(
      lines.map((points) => ({ id: newId(), kind: 'freehand' as const, points })),
      { ...DEFAULT_SETTINGS, paperWidth: 200, paperHeight: 150, margin: 10 },
    );
    expect(job.bounds.ok).toBe(true);
    expect(job.gcode.length).toBeGreaterThan(0);
    // The planner joins walls that still meet end to end.
    expect(job.plan.strokes.length).toBeLessThanOrEqual(lines.length);
  });
});

describe('randomizeOptions', () => {
  it.each(GEN_STYLES)('%s changes only its own style and repeats for a seed', (style) => {
    const o = opts(style);
    const a = randomizeOptions(o, rng(1));
    expect(randomizeOptions(o, rng(1))).toEqual(a);
    expect(a[style]).not.toEqual(o[style]);
    for (const other of GEN_STYLES) if (other !== style) expect(a[other]).toEqual(o[other]);
    expect(sanitizeGenerateOptions(a)).toEqual(a);
  });
});
