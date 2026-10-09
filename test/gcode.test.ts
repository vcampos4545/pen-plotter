import { describe, expect, it } from 'vitest';
import { drawableRect, type Polyline } from '../src/geometry';
import { checkBounds, fmt, fromMachine, generateGcode, OutOfBoundsError, toMachine } from '../src/gcode';
import { buildJob } from '../src/job';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { Stroke } from '../src/drawing';

const opts = {
  drawFeed: 3000,
  travelFeed: 6000,
  travelUseG1: false,
  penUpZ: 5,
  penDownZ: 0,
  penDwell: 0.15,
};

const square: Polyline = [
  { x: 10, y: 10 },
  { x: 20, y: 10 },
  { x: 20, y: 20 },
];

describe('fmt', () => {
  it('trims zeros and avoids -0', () => {
    expect(fmt(1)).toBe('1');
    expect(fmt(1.5)).toBe('1.5');
    expect(fmt(1.23456)).toBe('1.235');
    expect(fmt(-0.0001)).toBe('0');
    expect(fmt(0.15)).toBe('0.15');
  });
});

describe('generateGcode', () => {
  it('has the expected structure', () => {
    const g = generateGcode([square], opts);
    expect(g).toEqual([
      'G21 G90',
      'G0 Z5',
      'G4 P0.15',
      'G0 X10 Y10',
      'G0 Z0',
      'G4 P0.15',
      'G1 X20 Y10 F3000',
      'G1 X20 Y20',
      'G0 Z5',
      'G4 P0.15',
      'G0 X0 Y0',
    ]);
  });

  it('starts pen up, ends pen up at the origin', () => {
    const g = generateGcode([square, [{ x: 30, y: 30 }, { x: 40, y: 40 }]], opts);
    expect(g[0]).toBe('G21 G90');
    const firstZ = g.find((l) => l.includes('Z'));
    expect(firstZ).toBe('G0 Z5');
    const zLines = g.filter((l) => / Z/.test(l) || l.startsWith('G0 Z'));
    expect(zLines[zLines.length - 1]).toBe('G0 Z5');
    expect(g[g.length - 1]).toBe('G0 X0 Y0');
    // Every pen change is followed by a dwell.
    g.forEach((l, i) => {
      if (/^G0 Z/.test(l)) expect(g[i + 1]).toBe('G4 P0.15');
    });
    // Pen-down moves are G1, travel is G0.
    expect(g.filter((l) => l.startsWith('G1'))).toHaveLength(3);
    expect(g.filter((l) => /^G0 X/.test(l))).toHaveLength(3);
  });

  it('uses configured pen Z values, feeds and dwell', () => {
    const g = generateGcode([square], { ...opts, penUpZ: 3.5, penDownZ: -1, penDwell: 0, drawFeed: 1200 });
    expect(g).toContain('G0 Z3.5');
    expect(g).toContain('G0 Z-1');
    expect(g.some((l) => l.startsWith('G4'))).toBe(false);
    expect(g).toContain('G1 X20 Y10 F1200');
  });

  it('can emit travel as G1 at the travel feed', () => {
    const g = generateGcode([square], { ...opts, travelUseG1: true });
    expect(g).toContain('G1 X10 Y10 F6000');
    expect(g[g.length - 1]).toBe('G1 X0 Y0 F6000');
    expect(g.some((l) => /^G0 X/.test(l))).toBe(false);
  });

  it('writes header comments', () => {
    const g = generateGcode([square], { ...opts, header: ['hello\nworld'] });
    expect(g[0]).toBe('; hello world');
  });

  it('refuses out-of-bounds points', () => {
    const bounds = drawableRect(400, 400, 10);
    expect(() => generateGcode([square], { ...opts, bounds })).not.toThrow();
    expect(() => generateGcode([[{ x: 5, y: 50 }, { x: 50, y: 50 }]], { ...opts, bounds })).toThrow(OutOfBoundsError);
    expect(() => generateGcode([[{ x: 50, y: 395 }]], { ...opts, bounds })).toThrow(OutOfBoundsError);
    expect(() => generateGcode([[{ x: NaN, y: 50 }]], { ...opts, bounds })).toThrow(OutOfBoundsError);
  });
});

describe('checkBounds', () => {
  it('counts offending points and strokes', () => {
    const r = checkBounds(
      [
        [
          { x: 0, y: 0 },
          { x: 50, y: 50 },
          { x: 500, y: 50 },
        ],
        square,
      ],
      drawableRect(400, 400, 10),
    );
    expect(r).toEqual({ ok: false, outside: 2, strokes: 1 });
  });
});

describe('machine transform', () => {
  it('flips Y for a bottom-left origin and is its own inverse', () => {
    const s = { paperHeight: 400, originCorner: 'bottom-left' as const };
    expect(toMachine({ x: 10, y: 30 }, s)).toEqual({ x: 10, y: 370 });
    expect(fromMachine(toMachine({ x: 10, y: 30 }, s), s)).toEqual({ x: 10, y: 30 });
    expect(toMachine({ x: 10, y: 30 }, { paperHeight: 400, originCorner: 'top-left' })).toEqual({ x: 10, y: 30 });
  });
});

describe('buildJob', () => {
  const stroke = (points: Array<[number, number]>, kind: Stroke['kind'] = 'line'): Stroke => ({
    id: Math.random().toString(36),
    kind,
    points: points.map(([x, y]) => ({ x, y })),
  });

  it('runs flatten -> simplify -> optimize -> gcode in machine space', () => {
    // A noisy, nearly straight freehand stroke collapses to its endpoints.
    const noisy = Array.from({ length: 101 }, (_, i): [number, number] => [20 + i, 50 + (i % 2 ? 0.05 : -0.05)]);
    const job = buildJob([stroke(noisy, 'freehand'), stroke([[200, 200], [250, 200]])], DEFAULT_SETTINGS);
    expect(job.bounds.ok).toBe(true);
    expect(job.pointCount).toBe(4);
    expect(job.gcode[0]).toMatch(/^; /);
    expect(job.gcode).toContain('G21 G90');
    // Paper y=50 is machine y=350 with the default bottom-left origin.
    expect(job.gcode.some((l) => / Y349\.95| Y350\.05/.test(l))).toBe(true);
    expect(job.gcode[job.gcode.length - 1]).toBe('G0 X0 Y0');
  });

  it('produces no G-code when anything is out of bounds', () => {
    const job = buildJob([stroke([[2, 2], [50, 50]])], DEFAULT_SETTINGS);
    expect(job.bounds.ok).toBe(false);
    expect(job.gcode).toEqual([]);
  });
});
