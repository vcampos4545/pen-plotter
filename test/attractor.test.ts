import { describe, expect, it } from 'vitest';
import { isInteresting, lorenz, MAP_PRESETS, mapCurve, orbitStats, randomMapParams, type MapKind } from '../src/attractor';
import { polylineLength } from '../src/geometry';
import { rng } from '../src/stipple';

const KINDS: MapKind[] = ['clifford', 'dejong'];

describe('lorenz', () => {
  const o = { sigma: 10, rho: 28, beta: 8 / 3, steps: 4000, yaw: 0, pitch: 0 };

  it('is deterministic and draws both wings', () => {
    const a = lorenz(o);
    expect(lorenz(o)).toEqual(a);
    expect(a).toHaveLength(4000);
    // Front view: x changes sign as the line swaps wings.
    expect(a.some((p) => p.x > 5)).toBe(true);
    expect(a.some((p) => p.x < -5)).toBe(true);
  });

  it('turning the view changes the projection, not the 3D path', () => {
    const front = lorenz(o);
    const side = lorenz({ ...o, yaw: 90 });
    expect(side[100].x).not.toBeCloseTo(front[100].x, 3);
    // With no tilt, the vertical (z) coordinate is the same from any side.
    expect(side[100].y).toBeCloseTo(front[100].y, 9);
  });
});

describe('2D map attractors', () => {
  it.each(KINDS)('every %s preset is chaotic and fills a real area', (kind) => {
    for (const p of MAP_PRESETS[kind]) expect(isInteresting(orbitStats(kind, p)), p.name).toBe(true);
  });

  it.each(KINDS)('%s draws one continuous line of the requested length', (kind) => {
    const p = { ...MAP_PRESETS[kind][0], density: 20 };
    const stats = orbitStats(kind, p);
    const diag = Math.hypot(stats.maxX - stats.minX, stats.maxY - stats.minY);
    const curve = mapCurve(kind, p);
    expect(curve.chaotic).toBe(true);
    expect(curve.density).toBeGreaterThanOrEqual(20);
    expect(polylineLength(curve.line) / diag).toBeCloseTo(curve.density, 6);
    // No gap is much wider than the refinement step: it is one line, not dots.
    for (let i = 1; i < curve.line.length; i++) {
      const a = curve.line[i - 1];
      const b = curve.line[i];
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(diag / 200);
    }
    // And it stays on the attractor.
    for (const q of curve.line) {
      expect(q.x).toBeGreaterThanOrEqual(stats.minX - diag * 0.05);
      expect(q.x).toBeLessThanOrEqual(stats.maxX + diag * 0.05);
      expect(q.y).toBeGreaterThanOrEqual(stats.minY - diag * 0.05);
      expect(q.y).toBeLessThanOrEqual(stats.maxY + diag * 0.05);
    }
    expect(mapCurve(kind, p)).toEqual(curve);
  });

  it('stops at the point budget', () => {
    const curve = mapCurve('clifford', { ...MAP_PRESETS.clifford[0], density: 1000 }, 5000);
    expect(curve.line.length).toBeLessThanOrEqual(5000);
    expect(curve.density).toBeLessThan(1000);
  });

  it('flags parameters that settle to a point', () => {
    const curve = mapCurve('clifford', { a: 0.1, b: 0.1, c: 0.1, d: 0.1, density: 10 });
    expect(curve.chaotic).toBe(false);
  });

  it.each(KINDS)('random %s parameters are chaotic and repeat for a seed', (kind) => {
    const p = randomMapParams(kind, rng(42));
    expect(randomMapParams(kind, rng(42))).toEqual(p);
    expect(isInteresting(orbitStats(kind, p))).toBe(true);
  });
});
