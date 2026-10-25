import { describe, expect, it } from 'vitest';
import { buildQuery, checkArea, classify, normalizeBox, overpassError, parseOverpass, STREET_LAYERS } from '../src/osm';

const box = { west: -0.13, south: 51.5, east: -0.11, north: 51.51 };

describe('classify', () => {
  it('sorts roads by class', () => {
    expect(classify({ highway: 'primary' }, STREET_LAYERS)).toBe('major');
    expect(classify({ highway: 'motorway_link' }, STREET_LAYERS)).toBe('major');
    expect(classify({ highway: 'residential' }, STREET_LAYERS)).toBe('minor');
    expect(classify({ highway: 'footway' }, STREET_LAYERS)).toBe('paths');
    expect(classify({ highway: 'bus_stop' }, STREET_LAYERS)).toBeUndefined();
  });

  it('recognises rail, water, buildings and parks', () => {
    expect(classify({ railway: 'rail' }, STREET_LAYERS)).toBe('rail');
    expect(classify({ railway: 'abandoned' }, STREET_LAYERS)).toBeUndefined();
    expect(classify({ railway: 'rail', service: 'yard' }, STREET_LAYERS)).toBeUndefined();
    expect(classify({ railway: 'rail', service: 'crossover' }, STREET_LAYERS)).toBe('rail');
    expect(classify({ waterway: 'river' }, STREET_LAYERS)).toBe('waterways');
    expect(classify({ natural: 'coastline' }, STREET_LAYERS)).toBe('water');
    expect(classify({ natural: 'water', water: 'lake' }, STREET_LAYERS)).toBe('water');
    expect(classify({ building: 'yes' }, STREET_LAYERS)).toBe('buildings');
    expect(classify({ building: 'no' }, STREET_LAYERS)).toBeUndefined();
    expect(classify({ leisure: 'park' }, STREET_LAYERS)).toBe('parks');
  });

  it('only answers with layers that were asked for', () => {
    expect(classify({ highway: 'primary' }, ['minor', 'rail'])).toBeUndefined();
    expect(classify(undefined, STREET_LAYERS)).toBeUndefined();
  });
});

describe('normalizeBox', () => {
  it('leaves an ordinary box alone', () => {
    expect(normalizeBox(box)).toEqual({ box, shift: 0 });
  });

  it('brings a box from a world copy back into range', () => {
    const r = normalizeBox({ ...box, west: box.west + 360, east: box.east + 360 });
    expect(r.shift).toBe(360);
    expect(r.box.west).toBeCloseTo(box.west, 9);
    expect(r.box.east).toBeCloseTo(box.east, 9);
  });

  it('refuses a box across the antimeridian', () => {
    expect(() => normalizeBox({ west: 179.9, south: -17, east: 180.1, north: -16.9 })).toThrow(/180° meridian/);
  });
});

describe('buildQuery', () => {
  it('asks for every rule of the chosen layers in one bbox-limited request', () => {
    const q = buildQuery(box, ['major', 'water']);
    expect(q).toContain('[out:json][timeout:90][bbox:51.500000,-0.130000,51.510000,-0.110000];');
    expect(q).toContain('way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"];');
    expect(q).toContain('way["natural"~"^coastline$"];');
    expect(q).toContain('relation["natural"~"^water$"]["type"="multipolygon"];');
    expect(q).not.toContain('building');
    expect(q.trim().endsWith('out geom qt;')).toBe(true);
  });

  it('leaves rail yards out of the request', () => {
    expect(buildQuery(box, ['rail'])).toContain('["service"!~"^(yard|siding|spur)$"];');
  });

  it('skips building=no', () => {
    expect(buildQuery(box, ['buildings'])).toContain('way["building"]["building"!="no"];');
  });
});

describe('checkArea', () => {
  it('limits by the densest chosen layer', () => {
    const big = { west: 0, south: 0, east: 0.1, north: 0.1 }; // about 11 km
    expect(checkArea(big, ['major', 'rail'])).toMatchObject({ ok: true, limitKm: 25 });
    expect(checkArea(big, ['major', 'buildings'])).toMatchObject({ ok: false, limitKm: 3, limitedBy: 'buildings' });
    expect(checkArea(big, ['major']).spanKm).toBeCloseTo(11.1, 0);
  });
});

describe('parseOverpass', () => {
  const way = (id: number, tags: Record<string, string>, pts: Array<[number, number]>) => ({
    type: 'way',
    id,
    tags,
    geometry: pts.map(([lat, lon]) => ({ lat, lon })),
  });

  it('turns ways into lon/lat lines with their layer', () => {
    const lines = parseOverpass(
      {
        elements: [
          way(1, { highway: 'primary' }, [
            [51.5, -0.12],
            [51.505, -0.115],
          ]),
          way(2, { highway: 'residential' }, [
            [51.5, -0.12],
            [51.501, -0.121],
          ]),
        ],
      },
      ['major'],
    );
    expect(lines).toEqual([
      {
        layer: 'major',
        points: [
          { lat: 51.5, lon: -0.12 },
          { lat: 51.505, lon: -0.115 },
        ],
      },
    ]);
  });

  it('takes member ways from relations, once each, and skips missing nodes', () => {
    const lines = parseOverpass(
      {
        elements: [
          way(7, { natural: 'water' }, [
            [0, 0],
            [0, 1],
            [1, 1],
          ]),
          {
            type: 'relation',
            id: 9,
            tags: { natural: 'water', type: 'multipolygon' },
            members: [
              { type: 'way', ref: 7, role: 'outer', geometry: [] },
              { type: 'way', ref: 8, role: 'inner', geometry: [{ lat: 2, lon: 2 }, null, { lat: 3, lon: 3 }] },
              { type: 'node', ref: 5, role: 'label' },
            ],
          },
        ],
      },
      ['water'],
      360,
    );
    expect(lines).toHaveLength(2);
    expect(lines[1].points).toEqual([
      { lat: 2, lon: 362 },
      { lat: 3, lon: 363 },
    ]);
  });

  it('rejects replies that are not map data and server-side failures', () => {
    expect(() => parseOverpass('<html>', ['major'])).toThrow(/not map data/);
    expect(() => parseOverpass({ elements: [], remark: 'runtime error: Query timed out in "query" at line 3' }, ['major'])).toThrow(
      /gave up.*timed out.*smaller area/,
    );
  });
});

describe('overpassError', () => {
  it('explains rate limits and busy servers, and offers a retry', () => {
    const e429 = overpassError(429);
    expect(e429.message).toMatch(/HTTP 429.*Retry/);
    expect(e429.retry).toBe(true);
    const e504 = overpassError(504);
    expect(e504.message).toMatch(/busy.*HTTP 504/);
    expect(e504.retry).toBe(true);
  });

  it('pulls the error line out of a 400 page', () => {
    const e = overpassError(400, '<p><strong>Error</strong>: line 2: parse error: unexpected token</p>\n');
    expect(e.message).toBe('The Overpass server rejected the request (HTTP 400): Error : line 2: parse error: unexpected token');
    expect(e.retry).toBe(false);
  });
});
