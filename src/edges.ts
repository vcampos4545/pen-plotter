import { blurGrid } from './contour';
import type { Point, Polyline } from './geometry';
import type { ToneGrid } from './tone';

// Edge detection (Canny-style) and tracing of edge pixels into polylines.
// Coordinates out are pixel centres in grid units: x = column + 0.5.

export interface EdgeOptions {
  /** Blur passes before the gradient. More passes keep only the bigger shapes. */
  blur: number;
  /**
   * 0..1. An edge pixel needs a gradient at least this fraction of the image's
   * strong-edge level; weaker pixels are kept only when they continue a strong edge.
   */
  threshold: number;
}

/** Sobel gradient magnitude and direction. Edges clamp. */
export function sobel(values: ArrayLike<number>, w: number, h: number): { mag: Float32Array; gx: Float32Array; gy: Float32Array } {
  const mag = new Float32Array(w * h);
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const v = (i: number, j: number) => values[Math.min(h - 1, Math.max(0, j)) * w + Math.min(w - 1, Math.max(0, i))];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x =
        v(i + 1, j - 1) + 2 * v(i + 1, j) + v(i + 1, j + 1) - v(i - 1, j - 1) - 2 * v(i - 1, j) - v(i - 1, j + 1);
      const y =
        v(i - 1, j + 1) + 2 * v(i, j + 1) + v(i + 1, j + 1) - v(i - 1, j - 1) - 2 * v(i, j - 1) - v(i + 1, j - 1);
      const k = j * w + i;
      gx[k] = x;
      gy[k] = y;
      mag[k] = Math.hypot(x, y);
    }
  }
  return { mag, gx, gy };
}

/**
 * The gradient level treated as a "strong" edge: the 99th percentile of the
 * non-zero magnitudes, so one very hard edge does not wash out the rest.
 */
function strongLevel(mag: Float32Array): number {
  const nz = mag.filter((m) => m > 1e-6);
  if (nz.length === 0) return 0;
  nz.sort();
  return nz[Math.min(nz.length - 1, Math.floor(nz.length * 0.99))];
}

/** Thin edge mask: blur, Sobel, non-maximum suppression, hysteresis. 1 marks an edge pixel. */
export function detectEdges(grid: ToneGrid, o: EdgeOptions): Uint8Array {
  const { width: w, height: h } = grid;
  const values = o.blur > 0 ? blurGrid(grid.values, w, h, Math.round(o.blur)) : grid.values;
  const { mag, gx, gy } = sobel(values, w, h);
  const level = strongLevel(mag);
  const out = new Uint8Array(w * h);
  if (level === 0) return out;
  const high = Math.max(1e-6, o.threshold * level);
  const low = high / 2;

  // Non-maximum suppression: keep a pixel only if it peaks across the edge.
  const thin = new Float32Array(w * h);
  const m = (i: number, j: number) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : mag[j * w + i]);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (mag[k] < low) continue;
      const angle = ((Math.atan2(gy[k], gx[k]) * 180) / Math.PI + 180) % 180;
      let dx: number, dy: number;
      if (angle < 22.5 || angle >= 157.5) [dx, dy] = [1, 0];
      else if (angle < 67.5) [dx, dy] = [1, 1];
      else if (angle < 112.5) [dx, dy] = [0, 1];
      else [dx, dy] = [-1, 1];
      // Ties go to one side only, so a plateau still leaves a 1-pixel line.
      if (mag[k] >= m(i + dx, j + dy) && mag[k] > m(i - dx, j - dy)) thin[k] = mag[k];
    }
  }

  // Hysteresis: grow from strong pixels through connected weak ones.
  const stack: number[] = [];
  for (let k = 0; k < w * h; k++) {
    if (thin[k] >= high) {
      out[k] = 1;
      stack.push(k);
    }
  }
  while (stack.length > 0) {
    const k = stack.pop()!;
    const i = k % w;
    const j = (k - i) / w;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const n = nj * w + ni;
        if (!out[n] && thin[n] >= low) {
          out[n] = 1;
          stack.push(n);
        }
      }
    }
  }
  return out;
}

// 4-neighbours first so a chain follows the straight path before cutting corners.
const STEPS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1],
];

/**
 * Chains of 8-connected mask pixels as polylines through pixel centres. Chains
 * start at loose ends where possible; closed loops end on their first point.
 */
export function traceEdges(mask: Uint8Array, w: number, h: number): Polyline[] {
  const used = new Uint8Array(w * h);
  const isEdge = (i: number, j: number) => i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i] === 1;
  const next = (k: number): number => {
    const i = k % w;
    const j = (k - i) / w;
    for (const [di, dj] of STEPS) {
      if (isEdge(i + di, j + dj) && !used[(j + dj) * w + i + di]) return (j + dj) * w + i + di;
    }
    return -1;
  };
  const neighbours = (k: number): number => {
    const i = k % w;
    const j = (k - i) / w;
    let n = 0;
    for (const [di, dj] of STEPS) if (isEdge(i + di, j + dj)) n++;
    return n;
  };
  const centre = (k: number): Point => {
    const i = k % w;
    return { x: i + 0.5, y: (k - i) / w + 0.5 };
  };
  const walk = (start: number): number[] => {
    const chain = [start];
    used[start] = 1;
    for (let k = next(start); k >= 0; k = next(k)) {
      used[k] = 1;
      chain.push(k);
    }
    return chain;
  };
  const touches = (a: number, b: number) => {
    const ai = a % w;
    const bi = b % w;
    return Math.abs(ai - bi) <= 1 && Math.abs((a - ai) / w - (b - bi) / w) <= 1;
  };

  const lines: Polyline[] = [];
  // Loose ends first, so open curves come out whole.
  for (let k = 0; k < w * h; k++) {
    if (mask[k] && !used[k] && neighbours(k) === 1) lines.push(walk(k).map(centre));
  }
  // What is left is loops, or pieces cut off by junctions.
  for (let k = 0; k < w * h; k++) {
    if (!mask[k] || used[k]) continue;
    const forward = walk(k);
    // Extend backwards from the start too, in case it was mid-chain.
    used[k] = 1;
    const back: number[] = [];
    for (let b = next(k); b >= 0; b = next(b)) {
      used[b] = 1;
      back.push(b);
    }
    const chain = back.reverse().concat(forward);
    if (chain.length > 2 && touches(chain[0], chain[chain.length - 1])) chain.push(chain[0]);
    lines.push(chain.map(centre));
  }
  return lines;
}
