import { describe, expect, it } from 'vitest';
import {
  boxFromCorners,
  chooseZoom,
  decodeTerrarium,
  gridDims,
  groundSize,
  latToTileY,
  loadMosaic,
  lockAspect,
  lonToTileX,
  MAX_LAT,
  resampleGrid,
  sampleMosaic,
  terrariumUrl,
  TILE_SIZE,
  tileCount,
  tileRange,
  type GeoBox,
  type Mosaic,
} from '../src/terrain';

describe('tile math', () => {
  it('maps lon/lat to XYZ tiles', () => {
    expect(lonToTileX(-180, 3)).toBe(0);
    expect(lonToTileX(180, 3)).toBe(8);
    expect(latToTileY(0, 3)).toBeCloseTo(4, 12);
    expect(latToTileY(MAX_LAT, 3)).toBeCloseTo(0, 6);
    expect(latToTileY(-MAX_LAT, 3)).toBeCloseTo(8, 6);
    // Paris is OSM tile 10/518/352.
    expect(Math.floor(lonToTileX(2.3522, 10))).toBe(518);
    expect(Math.floor(latToTileY(48.8566, 10))).toBe(352);
  });

  it('wraps tile X in URLs across the antimeridian', () => {
    expect(terrariumUrl(2, -1, 1)).toBe('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/2/3/1.png');
    expect(terrariumUrl(2, 5, 1)).toBe('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/2/1/1.png');
  });

  it('does not pull in an extra tile for a box ending on a tile boundary', () => {
    const r = tileRange({ west: 0, east: 180, south: 0, north: MAX_LAT }, 1);
    expect(r).toEqual({ z: 1, x0: 1, x1: 1, y0: 0, y1: 0 });
    expect(tileCount(r)).toBe(1);
  });

  it('picks a detailed zoom for small boxes and a bounded one for big boxes', () => {
    const small: GeoBox = { west: 86.85, east: 87.0, south: 27.9, north: 28.05 };
    const zs = chooseZoom(small);
    expect(zs).toBeGreaterThanOrEqual(11);
    expect(tileCount(tileRange(small, zs))).toBeLessThanOrEqual(16);
    const big: GeoBox = { west: -125, east: -65, south: 25, north: 50 };
    const zb = chooseZoom(big);
    expect(zb).toBeLessThan(zs);
    expect(tileCount(tileRange(big, zb))).toBeLessThanOrEqual(16);
    // The longer side gets at least the target pixel count unless the tile cap prevented it.
    const span = (lonToTileX(big.east, zb) - lonToTileX(big.west, zb)) * TILE_SIZE;
    expect(span).toBeGreaterThanOrEqual(400);
  });

  it('stops at the highest published zoom', () => {
    const tiny: GeoBox = { west: 7.0, east: 7.0001, south: 46.0, north: 46.0001 };
    expect(chooseZoom(tiny)).toBe(15);
  });

  it('respects the tile cap', () => {
    const box: GeoBox = { west: 5, east: 15, south: 44, north: 48 };
    const z = chooseZoom(box, { maxTiles: 4, targetPixels: 4000, maxZoom: 15 });
    expect(tileCount(tileRange(box, z))).toBeLessThanOrEqual(4);
    expect(tileCount(tileRange(box, z + 1))).toBeGreaterThan(4);
  });
});

describe('decodeTerrarium', () => {
  it('decodes R*256 + G + B/256 - 32768', () => {
    const px = [128, 0, 0, 255, 0, 0, 0, 255, 128, 100, 128, 255, 140, 200, 64, 255];
    expect(Array.from(decodeTerrarium(px, 4, 1))).toEqual([0, -32768, 100.5, 12 * 256 + 200 + 0.25]);
  });
});

/** A tile whose every pixel holds `value`. */
const flatTile = (value: number) => new Float32Array(TILE_SIZE * TILE_SIZE).fill(value);

describe('loadMosaic and sampling', () => {
  it('stitches tiles in place and reports progress', async () => {
    const range = { z: 4, x0: 3, x1: 4, y0: 6, y1: 7 };
    const seen: string[] = [];
    const progress: number[] = [];
    const m = await loadMosaic(
      range,
      async (z, x, y) => {
        seen.push(`${z}/${x}/${y}`);
        return flatTile(x * 100 + y);
      },
      (done) => progress.push(done),
    );
    expect(seen.sort()).toEqual(['4/3/6', '4/3/7', '4/4/6', '4/4/7']);
    expect(progress).toEqual([1, 2, 3, 4]);
    expect(m.width).toBe(512);
    expect(m.height).toBe(512);
    expect(m.originX).toBe(3 * TILE_SIZE);
    expect(m.data[0]).toBe(306);
    expect(m.data[300]).toBe(406);
    expect(m.data[300 * 512 + 10]).toBe(307);
    expect(m.data[511 * 512 + 511]).toBe(407);
  });

  it('fails when any tile fails', async () => {
    await expect(
      loadMosaic({ z: 1, x0: 0, x1: 1, y0: 0, y1: 0 }, async (_z, x) => {
        if (x === 1) throw new Error('HTTP 503');
        return flatTile(0);
      }),
    ).rejects.toThrow('HTTP 503');
    await expect(loadMosaic({ z: 1, x0: 0, x1: 0, y0: 0, y1: 0 }, async () => new Float32Array(10))).rejects.toThrow('wrong size');
  });

  it('interpolates bilinearly between pixel centres', () => {
    // A 2 × 2 pixel mosaic at zoom 0, values rise to the east and the south.
    const m: Mosaic = { z: 8, originX: 0, originY: 0, width: 2, height: 2, data: Float32Array.from([0, 10, 100, 110]) };
    const lonAt = (px: number) => (px / (TILE_SIZE * 2 ** 8)) * 360 - 180;
    const latAt = (py: number) => {
      const n = Math.PI - (2 * Math.PI * py) / (TILE_SIZE * 2 ** 8);
      return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
    };
    expect(sampleMosaic(m, lonAt(0.5), latAt(0.5))).toBeCloseTo(0, 6);
    expect(sampleMosaic(m, lonAt(1.5), latAt(1.5))).toBeCloseTo(110, 6);
    expect(sampleMosaic(m, lonAt(1), latAt(0.5))).toBeCloseTo(5, 6);
    expect(sampleMosaic(m, lonAt(1), latAt(1))).toBeCloseTo(55, 6);
    // Outside the mosaic clamps to the edge.
    expect(sampleMosaic(m, lonAt(-5), latAt(-5))).toBeCloseTo(0, 6);
  });

  it('resamples a grid with row 0 at the north edge', async () => {
    // Elevation follows tile Y, so the south of a box is higher.
    const range = { z: 2, x0: 1, x1: 2, y0: 1, y1: 2 };
    const m = await loadMosaic(range, async (_z, _x, y) => flatTile(y * 1000));
    const box: GeoBox = { west: -60, east: 60, south: -50, north: 50 };
    const g = resampleGrid(m, box, 5, 4);
    expect(g.values.length).toBe(20);
    expect(g.values[0]).toBe(1000);
    expect(g.values[19]).toBe(2000);
    expect(g.min).toBe(1000);
    expect(g.max).toBe(2000);
  });
});

describe('ground size and aspect', () => {
  it('shrinks east-west distance with latitude', () => {
    const eq = groundSize({ west: 0, east: 1, south: -0.5, north: 0.5 });
    expect(eq.width / 1000).toBeCloseTo(111.2, 0);
    expect(eq.height / 1000).toBeCloseTo(111.2, 0);
    const north = groundSize({ west: 0, east: 1, south: 59.5, north: 60.5 });
    expect(north.width / north.height).toBeCloseTo(0.5, 2);
  });

  it('sizes the grid for square cells on the ground', () => {
    expect(gridDims({ west: 0, east: 2, south: -0.5, north: 0.5 }, 300)).toEqual({ nx: 300, ny: 150 });
    expect(gridDims({ west: 0, east: 1, south: 59, north: 61 }, 300)).toEqual({ nx: 75, ny: 300 });
  });

  it('normalises corners into a box', () => {
    expect(boxFromCorners({ lat: 10, lon: 5 }, { lat: -3, lon: -7 })).toEqual({ west: -7, east: 5, south: -3, north: 10 });
    expect(boxFromCorners({ lat: 89, lon: 0 }, { lat: 80, lon: 1 }).north).toBe(MAX_LAT);
  });

  it('locks the box to a ground aspect ratio and still reaches the cursor', () => {
    const anchor = { lat: 46, lon: 7 };
    for (const cursor of [
      { lat: 46.5, lon: 7.1 },
      { lat: 46.05, lon: 8 },
      { lat: 45.2, lon: 6.1 },
      { lat: 47, lon: 6.9 },
    ]) {
      for (const ratio of [1, 1.5, 0.6]) {
        const c = lockAspect(anchor, cursor, ratio);
        const g = groundSize(boxFromCorners(anchor, c));
        expect(g.width / g.height).toBeCloseTo(ratio, 3);
        // Same quadrant as the cursor and at least as far out.
        expect(Math.abs(c.lat - anchor.lat)).toBeGreaterThanOrEqual(Math.abs(cursor.lat - anchor.lat) - 1e-9);
        expect(Math.abs(c.lon - anchor.lon)).toBeGreaterThanOrEqual(Math.abs(cursor.lon - anchor.lon) - 1e-9);
        expect(Math.sign(c.lat - anchor.lat)).toBe(Math.sign(cursor.lat - anchor.lat));
        expect(Math.sign(c.lon - anchor.lon)).toBe(Math.sign(cursor.lon - anchor.lon));
      }
    }
  });
});
