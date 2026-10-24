import type { Point, Polyline } from './geometry';

// Contour lines from a regular grid of values (marching squares). Coordinates
// in and out are grid units: x is the column, y the row.

/** Separable [1 2 1] / 4 blur, repeated `passes` times. Edges clamp. Returns a new array. */
export function blurGrid(values: ArrayLike<number>, nx: number, ny: number, passes: number): Float32Array {
  let src = Float32Array.from(values);
  let tmp = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const l = src[row + Math.max(0, i - 1)];
        const r = src[row + Math.min(nx - 1, i + 1)];
        tmp[row + i] = (l + 2 * src[row + i] + r) / 4;
      }
    }
    for (let j = 0; j < ny; j++) {
      const up = Math.max(0, j - 1) * nx;
      const down = Math.min(ny - 1, j + 1) * nx;
      for (let i = 0; i < nx; i++) src[j * nx + i] = (tmp[up + i] + 2 * tmp[j * nx + i] + tmp[down + i]) / 4;
    }
  }
  return src;
}

/** Every multiple of `interval` strictly inside (min, max). */
export function levelsByInterval(min: number, max: number, interval: number): number[] {
  if (!(interval > 0) || !(max > min)) return [];
  const out: number[] = [];
  const first = Math.floor(min / interval) + 1;
  for (let k = first; k * interval < max; k++) out.push(k * interval);
  return out;
}

/** `count` levels evenly spaced strictly inside (min, max). */
export function levelsByCount(min: number, max: number, count: number): number[] {
  if (!(max > min) || count < 1) return [];
  return Array.from({ length: Math.floor(count) }, (_, k) => min + ((max - min) * (k + 1)) / (Math.floor(count) + 1));
}

/** A round interval (1, 2 or 5 × 10^k) giving roughly `target` contours over the range. */
export function niceInterval(min: number, max: number, target = 20): number {
  const raw = (max - min) / Math.max(1, target);
  if (!(raw > 0)) return 10;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].find((m) => m * mag >= raw)!;
  return step * mag;
}

// Cell corners: tl = 8, tr = 4, br = 2, bl = 1 (bit set when the corner is at
// or above the level). Edges: 0 top, 1 right, 2 bottom, 3 left.
const SEGMENTS: number[][] = [
  [],
  [3, 2],
  [2, 1],
  [3, 1],
  [0, 1],
  [], // saddle, resolved below
  [0, 2],
  [3, 0],
  [3, 0],
  [0, 2],
  [], // saddle
  [0, 1],
  [3, 1],
  [2, 1],
  [3, 2],
  [],
];

/**
 * Isolines of one level. Lines that reach the grid edge are open; the rest are
 * closed loops whose last point repeats the first. Saddle cells are resolved
 * by the cell's average value. Cells touching a NaN are skipped.
 */
export function isolines(values: ArrayLike<number>, nx: number, ny: number, level: number): Polyline[] {
  // Every crossing lies on a grid edge. Key each edge so the two cells sharing
  // it produce the very same point and the segments stitch exactly.
  const hKey = (i: number, j: number) => 2 * (j * nx + i);
  const vKey = (i: number, j: number) => 2 * (j * nx + i) + 1;

  const segA: number[] = [];
  const segB: number[] = [];
  const v = (i: number, j: number) => values[j * nx + i];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const tl = v(i, j);
      const tr = v(i + 1, j);
      const br = v(i + 1, j + 1);
      const bl = v(i, j + 1);
      if (Number.isNaN(tl + tr + br + bl)) continue;
      const c = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const edge = [hKey(i, j), vKey(i + 1, j), hKey(i, j + 1), vKey(i, j)];
      let pairs = SEGMENTS[c];
      if (c === 5 || c === 10) {
        const centreAbove = (tl + tr + br + bl) / 4 >= level;
        // Above corners joined through the centre: cut off the two below corners instead.
        const cutTlBr = c === 5 ? centreAbove : !centreAbove;
        pairs = cutTlBr ? [3, 0, 2, 1] : [0, 1, 3, 2];
      }
      for (let k = 0; k < pairs.length; k += 2) {
        segA.push(edge[pairs[k]]);
        segB.push(edge[pairs[k + 1]]);
      }
    }
  }

  // Each edge carries at most one crossing, shared by at most two segments.
  const byEdge = new Map<number, number[]>();
  const link = (key: number, s: number) => {
    const list = byEdge.get(key);
    if (list) list.push(s);
    else byEdge.set(key, [s]);
  };
  for (let s = 0; s < segA.length; s++) {
    link(segA[s], s);
    link(segB[s], s);
  }

  const point = (key: number): Point => {
    const vertical = key & 1;
    const idx = key >> 1;
    const i = idx % nx;
    const j = (idx - i) / nx;
    const a = v(i, j);
    const b = vertical ? v(i, j + 1) : v(i + 1, j);
    const t = (level - a) / (b - a);
    return vertical ? { x: i, y: j + t } : { x: i + t, y: j };
  };

  const used = new Uint8Array(segA.length);
  const lines: Polyline[] = [];
  const walk = (start: number, fromKey: number) => {
    const keys = [fromKey];
    let s = start;
    let at = fromKey;
    while (s !== -1 && !used[s]) {
      used[s] = 1;
      at = segA[s] === at ? segB[s] : segA[s];
      keys.push(at);
      s = byEdge.get(at)!.find((n) => !used[n]) ?? -1;
    }
    lines.push(keys.map(point));
  };
  // Open lines first, starting from an edge only one segment touches (the grid border).
  for (const [key, segs] of byEdge) {
    if (segs.length === 1 && !used[segs[0]]) walk(segs[0], key);
  }
  for (let s = 0; s < segA.length; s++) if (!used[s]) walk(s, segA[s]);
  return lines;
}
