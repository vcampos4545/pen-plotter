import { describe, expect, it } from 'vitest';
import { distToPolyline, polylineLength } from '../src/geometry';
import { constrainAngle, constrainSquare, ellipseShape, rectShape } from '../src/shapes';
import { dedupe, simplifyRDP } from '../src/simplify';

describe('simplifyRDP', () => {
  it('drops points within tolerance and keeps endpoints', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ x: i * 0.1, y: Math.sin(i) * 0.05 }));
    const out = simplifyRDP(pts, 0.2);
    expect(out.length).toBe(2);
    expect(out[0]).toBe(pts[0]);
    expect(out[1]).toBe(pts[999]);
  });

  it('keeps real corners', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 0.01 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 10, y: 10 },
    ];
    expect(simplifyRDP(pts, 0.2)).toEqual([pts[0], pts[2], pts[4]]);
  });

  it('every dropped point stays within tolerance of the result', () => {
    const pts = Array.from({ length: 300 }, (_, i) => ({ x: Math.cos(i / 30) * 50, y: Math.sin(i / 20) * 40 }));
    const out = simplifyRDP(pts, 0.2);
    expect(out.length).toBeLessThan(pts.length / 2);
    for (const p of pts) expect(distToPolyline(p, out)).toBeLessThanOrEqual(0.2 + 1e-9);
  });

  it('handles tiny inputs', () => {
    expect(simplifyRDP([], 0.2)).toEqual([]);
    expect(simplifyRDP([{ x: 1, y: 1 }], 0.2)).toEqual([{ x: 1, y: 1 }]);
  });
});

describe('dedupe', () => {
  it('removes repeated points', () => {
    expect(
      dedupe([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
  });
});

describe('shapes', () => {
  it('rectangle is closed with 5 points', () => {
    const r = rectShape({ x: 20, y: 30 }, { x: 10, y: 10 });
    expect(r).toHaveLength(5);
    expect(r[0]).toEqual({ x: 10, y: 10 });
    expect(r[4]).toEqual(r[0]);
    expect(polylineLength(r)).toBeCloseTo(60);
  });

  it('circle is closed, within chord tolerance, and the right length', () => {
    const c = ellipseShape({ x: 0, y: 0 }, { x: 100, y: 100 }, 0.05);
    expect(c[c.length - 1]).toEqual(c[0]);
    expect(polylineLength(c)).toBeCloseTo(Math.PI * 100, 0);
    // Mid-chord points must be within 0.05 mm of the true circle.
    for (let i = 1; i < c.length; i++) {
      const mx = (c[i - 1].x + c[i].x) / 2;
      const my = (c[i - 1].y + c[i].y) / 2;
      expect(50 - Math.hypot(mx - 50, my - 50)).toBeLessThanOrEqual(0.0501);
    }
  });

  it('shift constraints', () => {
    expect(constrainSquare({ x: 0, y: 0 }, { x: 10, y: -4 })).toEqual({ x: 10, y: -10 });
    const p = constrainAngle({ x: 0, y: 0 }, { x: 10, y: 1 });
    expect(p.y).toBeCloseTo(0);
    expect(p.x).toBeCloseTo(Math.hypot(10, 1));
  });
});
