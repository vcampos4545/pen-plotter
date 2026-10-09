import { describe, expect, it } from 'vitest';
import type { Polyline } from '../src/geometry';
import { greedyOrder, mergeStrokes, penUpDistance, planStrokes, twoOpt } from '../src/planner';

const seg = (x1: number, y1: number, x2: number, y2: number): Polyline => [
  { x: x1, y: y1 },
  { x: x2, y: y2 },
];

describe('penUpDistance', () => {
  it('counts origin -> strokes -> origin', () => {
    // origin -> (10,0), draw to (20,0), -> (20,10), draw to (30,10), -> origin
    const d = penUpDistance([seg(10, 0, 20, 0), seg(20, 10, 30, 10)]);
    expect(d).toBeCloseTo(10 + 10 + Math.hypot(30, 10));
  });

  it('is zero for nothing', () => {
    expect(penUpDistance([])).toBe(0);
  });
});

describe('mergeStrokes', () => {
  it('joins strokes that touch end to start', () => {
    const merged = mergeStrokes([seg(0, 0, 10, 0), seg(10, 0, 10, 10)], 0.05);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });

  it('reverses a stroke to make the join (end to end, start to start)', () => {
    const endToEnd = mergeStrokes([seg(0, 0, 10, 0), seg(10, 10, 10, 0)], 0.05);
    expect(endToEnd).toHaveLength(1);
    expect(endToEnd[0].map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);

    const startToStart = mergeStrokes([seg(0, 0, 10, 0), seg(0, 0, 0, 10)], 0.05);
    expect(startToStart).toHaveLength(1);
    expect(startToStart[0]).toHaveLength(3);
  });

  it('respects the tolerance', () => {
    expect(mergeStrokes([seg(0, 0, 10, 0), seg(10.04, 0, 20, 0)], 0.05)).toHaveLength(1);
    expect(mergeStrokes([seg(0, 0, 10, 0), seg(10.5, 0, 20, 0)], 0.05)).toHaveLength(2);
  });

  it('chains many pieces in any input order', () => {
    // A square split into four sides, shuffled and partly reversed.
    const merged = mergeStrokes([seg(10, 10, 0, 10), seg(0, 0, 10, 0), seg(0, 10, 0, 0), seg(10, 10, 10, 0)], 0.01);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toHaveLength(5);
  });

  it('does not mutate its input', () => {
    const a = seg(0, 0, 10, 0);
    const b = seg(10, 10, 10, 0);
    mergeStrokes([a, b], 0.05);
    expect(a).toEqual(seg(0, 0, 10, 0));
    expect(b).toEqual(seg(10, 10, 10, 0));
  });
});

describe('ordering', () => {
  // Four horizontal lines laid out far -> near, alternating direction badly.
  const badOrder: Polyline[] = [
    seg(100, 30, 0, 30),
    seg(0, 0, 100, 0),
    seg(100, 20, 0, 20),
    seg(0, 10, 100, 10),
  ];

  it('greedy nearest neighbor reduces travel on a known case', () => {
    const before = penUpDistance(badOrder);
    const after = penUpDistance(greedyOrder(badOrder));
    expect(after).toBeLessThan(before);
    // Boustrophedon: origin -> (0,0) -> (100,10)... ends at (0,30), returns 30.
    expect(after).toBeCloseTo(10 + 10 + 10 + 30);
  });

  it('allows drawing a stroke in reverse', () => {
    // A single stroke whose end is at the origin should be drawn backwards.
    const out = greedyOrder([seg(50, 50, 0, 0)]);
    expect(out[0][0]).toEqual({ x: 0, y: 0 });
    expect(out[0][1]).toEqual({ x: 50, y: 50 });
  });

  it('2-opt flips a single stroke when that is shorter', () => {
    // In this fixed order the middle stroke is backwards.
    const order = [seg(0, 0, 10, 0), seg(20, 0, 10.5, 0), seg(21, 0, 30, 0)];
    const { strokes } = twoOpt(order);
    expect(strokes[1][0].x).toBeCloseTo(10.5);
    expect(penUpDistance(strokes)).toBeLessThan(penUpDistance(order));
  });

  it('2-opt untangles a crossing that greedy leaves behind', () => {
    const order = [seg(0, 0, 0, 10), seg(10, 0, 10, 10), seg(0, 20, 0, 30), seg(10, 20, 10, 30)];
    const { strokes, timedOut } = twoOpt(order);
    expect(timedOut).toBe(false);
    expect(penUpDistance(strokes)).toBeLessThan(penUpDistance(order));
  });

  it('never makes the greedy result worse and keeps every stroke', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 300;
    const strokes = Array.from({ length: 200 }, () => seg(rand(), rand(), rand(), rand()));
    const greedy = greedyOrder(strokes);
    const { strokes: opt } = twoOpt(greedy);
    expect(penUpDistance(opt)).toBeLessThanOrEqual(penUpDistance(greedy) + 1e-9);
    expect(opt).toHaveLength(200);
    // Same set of segments, ignoring direction.
    const key = (s: Polyline) =>
      [s[0], s[s.length - 1]]
        .map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`)
        .sort()
        .join('|');
    expect(opt.map(key).sort()).toEqual(strokes.map(key).sort());
  });

  it('stops at the time limit', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 300;
    const strokes = Array.from({ length: 1500 }, () => seg(rand(), rand(), rand(), rand()));
    const started = performance.now();
    const plan = planStrokes(strokes, { timeLimitMs: 30, mergeTolerance: 0 });
    // Greedy is uncapped (O(n^2)); 2-opt must honor its deadline.
    expect(plan.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(plan.travelAfter).toBeLessThan(plan.travelBefore);
  });
});

describe('planStrokes', () => {
  it('merges, orders and reports before/after travel', () => {
    const plan = planStrokes([seg(100, 30, 0, 30), seg(0, 0, 100, 0), seg(100, 0, 100, 10), seg(0, 10, 100, 10)], {
      mergeTolerance: 0.05,
    });
    expect(plan.inputCount).toBe(4);
    expect(plan.mergedCount).toBe(2); // the vertical joins the two lower horizontals
    expect(plan.travelAfter).toBeLessThan(plan.travelBefore);
    expect(plan.drawLength).toBeCloseTo(100 * 3 + 10);
  });

  it('handles empty input and dots', () => {
    expect(planStrokes([]).strokes).toEqual([]);
    const plan = planStrokes([[{ x: 5, y: 5 }]]);
    expect(plan.strokes).toHaveLength(1);
    expect(plan.travelAfter).toBeCloseTo(2 * Math.hypot(5, 5));
  });
});
