import { blurGrid } from './contour';
import { clampPoint, type Point, type Polyline, type Rect } from './geometry';
import { dedupe, simplifyRDP } from './simplify';
import type { ElevationGrid } from './terrain';
import { filterFragments } from './topo';

// Elevation grid -> stacked horizontal elevation profiles ("Unknown Pleasures"
// style) in paper mm, with hidden lines removed so no two profiles cross.

export interface RidgeOptions {
  /** Number of profiles, north edge to south edge. */
  lines: number;
  /** The highest point in the area rises this many line gaps above its baseline. */
  height: number;
  /** Fade each profile to its flat baseline near the left and right edges. */
  baseline: boolean;
  /** Blur passes over the elevation grid first. 0 keeps the raw data. */
  smoothing: number;
  /** Ramer-Douglas-Peucker tolerance on the paper, mm. */
  simplify: number;
  /** Visible pieces shorter than this on the paper are dropped, mm. */
  minLength: number;
}

export const DEFAULT_RIDGE_OPTIONS: RidgeOptions = { lines: 60, height: 10, baseline: false, smoothing: 2, simplify: 0.1, minLength: 1 };
export const MAX_RIDGE_LINES = 300;
export const MAX_RIDGE_HEIGHT = 100;
/** Share of the width each side over which the flat baseline style fades the profile out. */
export const EDGE_FADE = 0.15;

export function sanitizeRidgeOptions(o: Partial<RidgeOptions> | null | undefined): RidgeOptions {
  const d = DEFAULT_RIDGE_OPTIONS;
  const num = (v: unknown, fallback: number, min: number, max = Infinity) => {
    const n = Number(v);
    return v !== '' && v !== null && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    lines: Math.round(num(o?.lines, d.lines, 2, MAX_RIDGE_LINES)),
    height: num(o?.height, d.height, 0, MAX_RIDGE_HEIGHT),
    baseline: o?.baseline === true,
    smoothing: Math.round(num(o?.smoothing, d.smoothing, 0, 20)),
    simplify: num(o?.simplify, d.simplify, 0, 10),
    minLength: num(o?.minLength, d.minLength, 0, 1000),
  };
}

/** Where the profiles land on paper. Rows run from `top` (the back, north) to `bottom` (the front, south). */
export interface RidgeLayout {
  x: number;
  width: number;
  /** Baseline of the back row. */
  top: number;
  /** Baseline of the front row. */
  bottom: number;
  /** Paper mm the highest point rises above its baseline. */
  peak: number;
}

/**
 * Fit the box's footprint (ground width × depth at one scale, so the
 * horizontal axis keeps the geographic proportions) plus the headroom the back
 * row's peaks need above it, inside `area`, centred.
 */
export function fitRidges(ground: { width: number; height: number }, area: Rect, lines: number, height: number): RidgeLayout {
  const aw = area.maxX - area.minX;
  const ah = area.maxY - area.minY;
  const n = Math.max(2, lines);
  // Peak headroom is `height` gaps, and the depth is (n - 1) gaps.
  const grow = 1 + height / (n - 1);
  const scale = Math.min(aw / ground.width, ah / (ground.height * grow));
  const width = ground.width * scale;
  const depth = ground.height * scale;
  const peak = (depth * height) / (n - 1);
  const x = area.minX + (aw - width) / 2;
  const top = area.minY + (ah - depth - peak) / 2 + peak;
  return { x, width, top, bottom: top + depth, peak };
}

/** Weight 0 at the left and right edges rising smoothly to 1 at `fade` of the way in. `t` runs 0..1. */
export function edgeFade(t: number, fade = EDGE_FADE): number {
  if (fade <= 0) return 1;
  const s = Math.min(1, Math.min(t, 1 - t) / fade);
  return s <= 0 ? 0 : s * s * (3 - 2 * s);
}

/**
 * Elevation along one row at fractional grid row `gy`, one sample per grid
 * column, interpolated between the two nearest rows.
 */
export function sampleRow(values: ArrayLike<number>, nx: number, ny: number, gy: number): Float64Array {
  const y = Math.max(0, Math.min(ny - 1, gy));
  const j0 = Math.floor(y);
  const j1 = Math.min(ny - 1, j0 + 1);
  const f = y - j0;
  const out = new Float64Array(nx);
  for (let i = 0; i < nx; i++) out[i] = values[j0 * nx + i] * (1 - f) + values[j1 * nx + i] * f;
  return out;
}

/**
 * Hidden-line removal against a running skyline. `ys` are the profile's paper
 * Y values at fixed sample positions `xs`; `sky` holds, at the same positions,
 * the highest (smallest Y) point drawn so far by the rows in front, and is
 * updated in place. Returns the pieces of the profile strictly above the
 * skyline, split where it dips behind. Between samples the skyline is taken as
 * the straight chord, which never sits below the true skyline there, so a
 * visible piece can touch the rows in front but never cross them.
 */
export function clipToSkyline(xs: ArrayLike<number>, ys: ArrayLike<number>, sky: Float64Array): Polyline[] {
  const pieces: Polyline[] = [];
  let piece: Polyline | undefined;
  const n = xs.length;
  // Positive where the profile is above the skyline.
  const gap = (i: number) => sky[i] - ys[i];
  for (let i = 0; i < n; i++) {
    const d = gap(i);
    const visible = d > 0;
    if (i > 0) {
      const prev = gap(i - 1);
      const was = prev > 0;
      if (was !== visible && Number.isFinite(prev) && Number.isFinite(d)) {
        // The crossing, where the profile meets the skyline chord.
        const t = prev / (prev - d);
        const p: Point = { x: xs[i - 1] + (xs[i] - xs[i - 1]) * t, y: ys[i - 1] + (ys[i] - ys[i - 1]) * t };
        if (was) {
          piece!.push(p);
          pieces.push(piece!);
          piece = undefined;
        } else {
          piece = [p];
        }
      }
    }
    if (visible) {
      piece ??= [];
      piece.push({ x: xs[i], y: ys[i] });
    }
  }
  if (piece) pieces.push(piece);
  for (let i = 0; i < n; i++) if (ys[i] < sky[i]) sky[i] = ys[i];
  return pieces.filter((p) => p.length >= 2);
}

export interface RidgeResult {
  lines: Polyline[];
  /** Rows drawn (some may be hidden entirely). */
  rows: number;
  /** Visible pieces dropped for being shorter than minLength. */
  dropped: number;
  layout: RidgeLayout;
  /** Lowest and highest elevation after smoothing, metres. */
  min: number;
  max: number;
  /**
   * Vertical scale over horizontal scale: how much taller the profiles are
   * than the real ground at the map's horizontal scale. 0 for flat ground.
   */
  exaggeration: number;
}

/** `ground` is the box's ground size in metres, for the layout and the exaggeration figure. */
export function buildRidges(grid: ElevationGrid, ground: { width: number; height: number }, area: Rect, opts: RidgeOptions): RidgeResult {
  const { nx, ny } = grid;
  const values = opts.smoothing > 0 ? blurGrid(grid.values, nx, ny, Math.round(opts.smoothing)) : grid.values;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const rows = Math.max(2, Math.round(opts.lines));
  const layout = fitRidges(ground, area, rows, opts.height);
  const relief = max - min;
  const mmPerMetre = relief > 0 ? layout.peak / relief : 0;
  const xs = new Float64Array(nx);
  const fade = new Float64Array(nx);
  for (let i = 0; i < nx; i++) {
    const t = i / (nx - 1);
    xs[i] = layout.x + t * layout.width;
    fade[i] = opts.baseline ? edgeFade(t) : 1;
  }
  const sky = new Float64Array(nx).fill(Infinity);
  const ys = new Float64Array(nx);
  const pieces: Polyline[] = [];
  const gapMm = (layout.bottom - layout.top) / (rows - 1);
  // Front (south, bottom of the page) to back, so each row is clipped by the ones before it.
  for (let k = rows - 1; k >= 0; k--) {
    const elev = sampleRow(values, nx, ny, (k * (ny - 1)) / (rows - 1));
    const base = layout.top + k * gapMm;
    for (let i = 0; i < nx; i++) ys[i] = base - (elev[i] - min) * mmPerMetre * fade[i];
    for (const p of clipToSkyline(xs, ys, sky)) {
      // Clamp guards against float error putting an edge point a hair outside the margin.
      pieces.push(simplifyRDP(dedupe(p.map((q) => clampPoint(q, area))), opts.simplify));
    }
  }
  const { kept, dropped } = filterFragments(pieces, opts.minLength);
  const horizontal = layout.width / ground.width;
  return { lines: kept, rows, dropped, layout, min, max, exaggeration: horizontal > 0 ? mmPerMetre / horizontal : 0 };
}
