import { blurGrid, isolines, levelsByCount, levelsByInterval } from './contour';
import { clampPoint, polylineLength, type Point, type Polyline, type Rect } from './geometry';
import { dedupe, simplifyRDP } from './simplify';
import type { ElevationGrid } from './terrain';

// Elevation grid -> contour strokes in paper mm, fitted inside the drawable area.

export interface TopoOptions {
  /** 'interval': a contour every `value` metres. 'count': `value` evenly spaced levels. */
  mode: 'interval' | 'count';
  value: number;
  /** Blur passes over the elevation grid before contouring. 0 keeps the raw data. */
  smoothing: number;
  /** Ramer-Douglas-Peucker tolerance on the paper, mm. */
  simplify: number;
  /** Lines shorter than this on the paper are dropped, mm. */
  minLength: number;
}

export const DEFAULT_TOPO_OPTIONS: TopoOptions = { mode: 'interval', value: 100, smoothing: 2, simplify: 0.1, minLength: 3 };

/** More levels than this would take seconds and bury the paper in ink. */
export const MAX_LEVELS = 250;

export interface TopoResult {
  lines: Polyline[];
  levels: number[];
  /** Lines dropped for being shorter than minLength. */
  dropped: number;
  /** True when the options asked for more than MAX_LEVELS and the levels were thinned. */
  capped: boolean;
}

/** Where a grid of nx × ny samples lands on paper: scaled uniformly and centred in `area`. */
export interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Fit a box of ground size `ground` (any unit) inside `area`, preserving its
 * aspect ratio, centred.
 */
export function fitToArea(ground: { width: number; height: number }, area: Rect): Placement {
  const aw = area.maxX - area.minX;
  const ah = area.maxY - area.minY;
  const scale = Math.min(aw / ground.width, ah / ground.height);
  const width = ground.width * scale;
  const height = ground.height * scale;
  return { x: area.minX + (aw - width) / 2, y: area.minY + (ah - height) / 2, width, height };
}

/** Grid coordinates (column, row; row 0 north) to paper mm (Y down, so north is up the sheet). */
export function gridToPaper(p: Point, nx: number, ny: number, place: Placement): Point {
  return { x: place.x + (p.x / (nx - 1)) * place.width, y: place.y + (p.y / (ny - 1)) * place.height };
}

/** Split lines into those at least `minLength` long and a count of the rest. */
export function filterFragments(lines: Polyline[], minLength: number): { kept: Polyline[]; dropped: number } {
  const kept = lines.filter((l) => l.length >= 2 && polylineLength(l) >= minLength);
  return { kept, dropped: lines.length - kept.length };
}

export function topoLevels(min: number, max: number, opts: TopoOptions): { levels: number[]; capped: boolean } {
  const levels = opts.mode === 'count' ? levelsByCount(min, max, Math.min(opts.value, MAX_LEVELS)) : levelsByInterval(min, max, opts.value);
  if (levels.length <= MAX_LEVELS) return { levels, capped: opts.mode === 'count' && opts.value > MAX_LEVELS };
  const step = Math.ceil(levels.length / MAX_LEVELS);
  return { levels: levels.filter((_, k) => k % step === 0), capped: true };
}

export function buildTopo(grid: ElevationGrid, place: Placement, area: Rect, opts: TopoOptions): TopoResult {
  const values = opts.smoothing > 0 ? blurGrid(grid.values, grid.nx, grid.ny, Math.round(opts.smoothing)) : grid.values;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const { levels, capped } = topoLevels(min, max, opts);
  const lines: Polyline[] = [];
  for (const level of levels) {
    for (const line of isolines(values, grid.nx, grid.ny, level)) {
      // Clamp guards against float error putting an edge point a hair outside the margin.
      const paper = line.map((p) => clampPoint(gridToPaper(p, grid.nx, grid.ny, place), area));
      lines.push(simplifyRDP(dedupe(paper), opts.simplify));
    }
  }
  const { kept, dropped } = filterFragments(lines, opts.minLength);
  return { lines: kept, levels, dropped, capped };
}
