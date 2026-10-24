// Elevation data from the AWS Terrain Tiles (Terrarium PNG encoding), in Web
// Mercator XYZ tiles. Everything here is pure so it can be unit tested; the
// browser-only download and PNG decode live in terrain-fetch.ts.

export interface LatLon {
  lat: number;
  lon: number;
}

/** A lon/lat box in degrees. `west` < `east`; longitudes may run past ±180 after panning around the world. */
export interface GeoBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Web Mercator stops here; tiles do not cover the poles. */
export const MAX_LAT = 85.05112878;
export const TILE_SIZE = 256;
/** Highest zoom the terrain tiles are published at. */
export const MAX_TERRAIN_ZOOM = 15;
const EARTH_RADIUS_M = 6371008.8;
const M_PER_DEG = (Math.PI * EARTH_RADIUS_M) / 180;

export const terrariumUrl = (z: number, x: number, y: number): string => {
  const n = 2 ** z;
  const wx = ((x % n) + n) % n; // wrap across the antimeridian
  return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${wx}/${y}.png`;
};

const clampLat = (lat: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

/** Fractional tile X of a longitude at zoom z. Not wrapped. */
export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

/** Fractional tile Y of a latitude at zoom z (0 at the north edge of the world). */
export function latToTileY(lat: number, z: number): number {
  const r = (clampLat(lat) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

export interface TileRange {
  z: number;
  x0: number;
  y0: number;
  /** Inclusive. */
  x1: number;
  y1: number;
}

export function tileRange(box: GeoBox, z: number): TileRange {
  const n = 2 ** z;
  // Shave a hair off the far edges so a box ending exactly on a tile boundary
  // does not pull in a whole extra row or column.
  const eps = 1e-9;
  const yOf = (ty: number) => Math.min(n - 1, Math.max(0, Math.floor(ty)));
  const x0 = Math.floor(lonToTileX(box.west, z));
  const y0 = yOf(latToTileY(box.north, z));
  return {
    z,
    x0,
    y0,
    x1: Math.max(x0, Math.floor(lonToTileX(box.east, z) - eps)),
    y1: Math.max(y0, yOf(latToTileY(box.south, z) - eps)),
  };
}

export const tileCount = (r: TileRange) => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);

export interface ZoomOptions {
  /** Most tiles one box may download. */
  maxTiles: number;
  /** Stop zooming in once the box's longer side spans this many source pixels. */
  targetPixels: number;
  maxZoom: number;
}

export const DEFAULT_ZOOM_OPTIONS: ZoomOptions = { maxTiles: 16, targetPixels: 400, maxZoom: MAX_TERRAIN_ZOOM };

/**
 * Pick a zoom for a box: the lowest zoom whose pixels cover the box's longer
 * side with at least `targetPixels` samples, backed off until the box needs at
 * most `maxTiles` tiles. Small boxes get detailed data; huge boxes get a coarse
 * overview instead of hundreds of downloads.
 */
export function chooseZoom(box: GeoBox, opts: ZoomOptions = DEFAULT_ZOOM_OPTIONS): number {
  let z = 0;
  while (z < opts.maxZoom) {
    const w = (lonToTileX(box.east, z) - lonToTileX(box.west, z)) * TILE_SIZE;
    const h = (latToTileY(box.south, z) - latToTileY(box.north, z)) * TILE_SIZE;
    if (Math.max(w, h) >= opts.targetPixels) break;
    z++;
  }
  while (z > 0 && tileCount(tileRange(box, z)) > opts.maxTiles) z--;
  return z;
}

/** Terrarium encoding: elevation in metres = R * 256 + G + B / 256 - 32768. Input is RGBA bytes. */
export function decodeTerrarium(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    out[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
  }
  return out;
}

/** Decoded tiles stitched into one elevation image in global pixel space at zoom z. */
export interface Mosaic {
  z: number;
  /** Global pixel coordinates of the mosaic's top-left corner. */
  originX: number;
  originY: number;
  width: number;
  height: number;
  data: Float32Array;
}

export type TileLoader = (z: number, x: number, y: number) => Promise<Float32Array>;

/** Download (through `load`) every tile of the range and stitch them. `load` returns TILE_SIZE² elevations. */
export async function loadMosaic(range: TileRange, load: TileLoader, onTile?: (done: number, total: number) => void): Promise<Mosaic> {
  const cols = range.x1 - range.x0 + 1;
  const rows = range.y1 - range.y0 + 1;
  const width = cols * TILE_SIZE;
  const data = new Float32Array(width * rows * TILE_SIZE);
  let done = 0;
  const jobs: Array<Promise<void>> = [];
  for (let ty = range.y0; ty <= range.y1; ty++) {
    for (let tx = range.x0; tx <= range.x1; tx++) {
      jobs.push(
        load(range.z, tx, ty).then((tile) => {
          if (tile.length !== TILE_SIZE * TILE_SIZE) throw new Error(`Tile ${range.z}/${tx}/${ty} has the wrong size`);
          const ox = (tx - range.x0) * TILE_SIZE;
          const oy = (ty - range.y0) * TILE_SIZE;
          for (let r = 0; r < TILE_SIZE; r++) {
            data.set(tile.subarray(r * TILE_SIZE, (r + 1) * TILE_SIZE), (oy + r) * width + ox);
          }
          onTile?.(++done, jobs.length);
        }),
      );
    }
  }
  await Promise.all(jobs);
  return { z: range.z, originX: range.x0 * TILE_SIZE, originY: range.y0 * TILE_SIZE, width, height: rows * TILE_SIZE, data };
}

/** Bilinear elevation at a lon/lat. Pixel centres sit at +0.5; edges clamp to the mosaic. */
export function sampleMosaic(m: Mosaic, lon: number, lat: number): number {
  const px = lonToTileX(lon, m.z) * TILE_SIZE - m.originX - 0.5;
  const py = latToTileY(lat, m.z) * TILE_SIZE - m.originY - 0.5;
  const x = Math.max(0, Math.min(m.width - 1, px));
  const y = Math.max(0, Math.min(m.height - 1, py));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(m.width - 1, x0 + 1);
  const y1 = Math.min(m.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const d = m.data;
  const top = d[y0 * m.width + x0] * (1 - fx) + d[y0 * m.width + x1] * fx;
  const bottom = d[y1 * m.width + x0] * (1 - fx) + d[y1 * m.width + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Elevations on a regular lon/lat grid. Row-major, row 0 is the north edge, column 0 the west edge. */
export interface ElevationGrid {
  nx: number;
  ny: number;
  values: Float32Array;
  min: number;
  max: number;
}

export function resampleGrid(m: Mosaic, box: GeoBox, nx: number, ny: number): ElevationGrid {
  const values = new Float32Array(nx * ny);
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < ny; j++) {
    const lat = box.north - ((box.north - box.south) * j) / (ny - 1);
    for (let i = 0; i < nx; i++) {
      const v = sampleMosaic(m, box.west + ((box.east - box.west) * i) / (nx - 1), lat);
      values[j * nx + i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { nx, ny, values, min, max };
}

/**
 * Ground size of a box in metres. East-west distance shrinks with the cosine of
 * the latitude, taken at the box's middle (an equirectangular approximation,
 * accurate for the regional boxes contouring is useful for).
 */
export function groundSize(box: GeoBox): { width: number; height: number } {
  const midLat = (((clampLat(box.north) + clampLat(box.south)) / 2) * Math.PI) / 180;
  return {
    width: (box.east - box.west) * Math.cos(midLat) * M_PER_DEG,
    height: (clampLat(box.north) - clampLat(box.south)) * M_PER_DEG,
  };
}

/** Grid dimensions with `longSide` samples on the longer side and roughly square cells on the ground. */
export function gridDims(box: GeoBox, longSide = 300): { nx: number; ny: number } {
  const { width, height } = groundSize(box);
  const short = (a: number, b: number) => Math.max(2, Math.round((longSide * a) / b));
  return width >= height ? { nx: longSide, ny: short(height, width) } : { nx: short(width, height), ny: longSide };
}

export function boxFromCorners(a: LatLon, b: LatLon): GeoBox {
  return {
    west: Math.min(a.lon, b.lon),
    east: Math.max(a.lon, b.lon),
    south: clampLat(Math.min(a.lat, b.lat)),
    north: clampLat(Math.max(a.lat, b.lat)),
  };
}

/**
 * Move the dragged corner so the box's ground width / height equals `ratio`,
 * growing whichever side is short (like Shift on the rectangle tool) so the
 * box always reaches the cursor.
 */
export function lockAspect(anchor: LatLon, cursor: LatLon, ratio: number): LatLon {
  const dLon = cursor.lon - anchor.lon;
  let dLat = cursor.lat - anchor.lat;
  const sLon = Math.sign(dLon) || 1;
  const sLat = Math.sign(dLat) || 1;
  const cosAt = (lat: number) => Math.cos((((anchor.lat + lat) / 2) * Math.PI) / 180);
  const w = Math.abs(dLon) * cosAt(cursor.lat);
  if (w / ratio > Math.abs(dLat)) {
    // Too wide: make it taller. The middle latitude moves, so settle it in a few passes.
    let h = w / ratio;
    for (let k = 0; k < 4; k++) {
      dLat = sLat * h;
      h = (Math.abs(dLon) * cosAt(clampLat(anchor.lat + dLat))) / ratio;
    }
    return { lat: clampLat(anchor.lat + sLat * h), lon: cursor.lon };
  }
  const lat = clampLat(cursor.lat);
  return { lat, lon: anchor.lon + (sLon * Math.abs(lat - anchor.lat) * ratio) / cosAt(lat) };
}
