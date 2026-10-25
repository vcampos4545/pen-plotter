import { describe, expect, it } from 'vitest';
import { drawableRect, insideRect, polylineLength, type Point, type Polyline } from '../src/geometry';
import type { OsmLine } from '../src/osm';
import {
  buildStreets,
  clipPolyline,
  DEFAULT_STREETS_OPTIONS,
  describeCounts,
  joinLines,
  offsetPolyline,
  placeBox,
  projector,
  sanitizeStreetsOptions,
  type StreetsOptions,
} from '../src/streets';
import { groundSize } from '../src/terrain';

const P = (x: number, y: number): Point => ({ x, y });
const area = drawableRect(400, 300, 10);
const rect = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

describe('projector', () => {
  it('maps the box corners to the placement, north up', () => {
    const box = { west: 10, south: 60, east: 10.2, north: 60.1 };
    const place = placeBox(box, area);
    const project = projector(box, place);
    expect(project({ lon: 10, lat: 60.1 })).toEqual({ x: place.x, y: place.y });
    const se = project({ lon: 10.2, lat: 60 });
    expect(se.x).toBeCloseTo(place.x + place.width, 9);
    expect(se.y).toBeCloseTo(place.y + place.height, 9);
  });

  it('keeps ground proportions: a degree of longitude is shorter far from the equator', () => {
    const box = { west: 10, south: 59.95, east: 10.2, north: 60.05 };
    const place = placeBox(box, area);
    const g = groundSize(box);
    expect(place.width / place.height).toBeCloseTo(g.width / g.height, 9);
    // At 60° a degree of longitude is half a degree of latitude, so 0.2° × 0.1° is square.
    expect(place.width / place.height).toBeCloseTo(1, 2);
  });
});

describe('clipPolyline', () => {
  it('keeps a line that is inside', () => {
    const l = [P(1, 1), P(5, 5), P(9, 1)];
    expect(clipPolyline(l, rect)).toEqual([l]);
  });

  it('cuts a line at the edges', () => {
    expect(clipPolyline([P(-5, 5), P(15, 5)], rect)).toEqual([[P(0, 5), P(10, 5)]]);
  });

  it('splits a line that leaves and comes back', () => {
    const parts = clipPolyline([P(2, 2), P(2, 20), P(8, 20), P(8, 2)], rect);
    expect(parts).toEqual([
      [P(2, 2), P(2, 10)],
      [P(8, 10), P(8, 2)],
    ]);
  });

  it('drops a line that misses', () => {
    expect(clipPolyline([P(-5, -5), P(-1, 20)], rect)).toEqual([]);
  });
});

describe('joinLines', () => {
  it('joins ways that share endpoints, whichever way round they are', () => {
    const joined = joinLines([
      [P(0, 0), P(1, 0)],
      [P(2, 0), P(1, 0)],
      [P(2, 0), P(3, 0)],
    ]);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toEqual([P(0, 0), P(1, 0), P(2, 0), P(3, 0)]);
  });

  it('continues along the straightest line at a junction', () => {
    const joined = joinLines([
      [P(0, 0), P(1, 0)],
      [P(1, 0), P(1, 1)],
      [P(1, 0), P(2, 0)],
    ]);
    expect(joined).toHaveLength(2);
    expect(joined).toContainEqual([P(0, 0), P(1, 0), P(2, 0)]);
    expect(joined).toContainEqual([P(1, 0), P(1, 1)]);
  });

  it('closes a ring from its pieces and leaves closed rings alone', () => {
    const square = [P(0, 0), P(1, 0), P(1, 1), P(0, 1), P(0, 0)];
    expect(joinLines([square, [P(0, 0), P(-1, 0)]])).toEqual([square, [P(0, 0), P(-1, 0)]]);
    const ring = joinLines([
      [P(0, 0), P(1, 0), P(1, 1)],
      [P(1, 1), P(0, 1), P(0, 0)],
    ]);
    expect(ring).toHaveLength(1);
    expect(ring[0][0]).toEqual(ring[0][ring[0].length - 1]);
    expect(ring[0]).toHaveLength(5);
  });
});

describe('offsetPolyline', () => {
  it('moves a straight line sideways', () => {
    const l = offsetPolyline([P(0, 0), P(10, 0)], 1);
    expect(l[0].x).toBeCloseTo(0);
    expect(Math.abs(l[0].y)).toBeCloseTo(1);
    expect(l[1].y).toBeCloseTo(l[0].y);
  });

  it('miters a right angle so both legs stay the same distance away', () => {
    const [a, b] = [offsetPolyline([P(0, 0), P(10, 0), P(10, 10)], 1), offsetPolyline([P(0, 0), P(10, 0), P(10, 10)], -1)];
    // One side's corner is inside the turn, the other's outside; both at (10 ∓ 1, ±1).
    const corners = [a[1], b[1]].map((p) => [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6]);
    expect(corners).toContainEqual([9, 1]);
    expect(corners).toContainEqual([11, -1]);
  });

  it('keeps a closed ring closed', () => {
    const l = offsetPolyline([P(0, 0), P(10, 0), P(10, 10), P(0, 10), P(0, 0)], 1);
    expect(l[0].x).toBeCloseTo(l[4].x, 9);
    expect(l[0].y).toBeCloseTo(l[4].y, 9);
  });
});

describe('sanitizeStreetsOptions', () => {
  it('fills gaps and clamps', () => {
    expect(sanitizeStreetsOptions(null)).toEqual(DEFAULT_STREETS_OPTIONS);
    const o = sanitizeStreetsOptions({ layers: { buildings: true, major: 'x' }, doubleGap: 99, minLength: -1, simplify: '' });
    expect(o.layers.buildings).toBe(true);
    expect(o.layers.major).toBe(true);
    expect(o.doubleGap).toBe(5);
    expect(o.minLength).toBe(0);
    expect(o.simplify).toBe(DEFAULT_STREETS_OPTIONS.simplify);
  });
});

describe('buildStreets', () => {
  const box = { west: 0, south: 0, east: 0.01, north: 0.01 };
  const opts = (o: Partial<StreetsOptions> = {}): StreetsOptions => ({ ...DEFAULT_STREETS_OPTIONS, simplify: 0, minLength: 0, ...o });
  const line = (layer: OsmLine['layer'], ...pts: Array<[number, number]>): OsmLine => ({
    layer,
    points: pts.map(([lon, lat]) => ({ lon, lat })),
  });
  const features: OsmLine[] = [
    // A road crossing the whole box in two ways, running past both edges.
    line('major', [-0.005, 0.005], [0.005, 0.005]),
    line('major', [0.005, 0.005], [0.015, 0.005]),
    line('minor', [0.002, 0.002], [0.002, 0.008]),
    line('minor', [0.0021, 0.0021], [0.00211, 0.00211]),
    line('buildings', [0.003, 0.003], [0.004, 0.003], [0.004, 0.004], [0.003, 0.003]),
  ];

  it('joins, clips to the box and keeps only enabled layers', () => {
    const r = buildStreets(features, box, area, opts());
    const place = placeBox(box, area);
    const clip = { minX: place.x, minY: place.y, maxX: place.x + place.width, maxY: place.y + place.height };
    expect(r.counts).toEqual({ major: 1, minor: 2 });
    for (const l of r.lines) for (const p of l) expect(insideRect(p, clip)).toBe(true);
    // The joined road spans the whole box.
    const longest = Math.max(...r.lines.map(polylineLength));
    expect(longest).toBeCloseTo(place.width, 6);
  });

  it('drops short fragments', () => {
    const r = buildStreets(features, box, area, opts({ minLength: 1 }));
    expect(r.counts).toEqual({ major: 1, minor: 1 });
    expect(r.dropped).toBe(1);
  });

  it('draws major roads twice when asked, still inside the box', () => {
    const r = buildStreets(features, box, area, opts({ doubleMajor: true, doubleGap: 2, layers: { ...DEFAULT_STREETS_OPTIONS.layers, minor: false } }));
    expect(r.counts).toEqual({ major: 2 });
    const ys = r.lines.map((l: Polyline) => l[0].y).sort((a, b) => a - b);
    expect(ys[1] - ys[0]).toBeCloseTo(2, 6);
  });

  it('includes building outlines when that layer is on', () => {
    const r = buildStreets(features, box, area, opts({ layers: { ...DEFAULT_STREETS_OPTIONS.layers, buildings: true } }));
    expect(r.counts.buildings).toBe(1);
    expect(describeCounts(r.counts)).toBe('Major roads 1 · Minor roads 2 · Buildings 1');
  });
});
