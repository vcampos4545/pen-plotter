import type { Point } from './geometry';
import type { Placement } from './topo';

export type { Placement };

// Greyscale photo data for the Photo tool. A ToneGrid holds darkness, 0 for
// white paper and 1 for full ink, row-major with row 0 at the top.

export interface ToneGrid {
  width: number;
  height: number;
  values: Float32Array;
}

export interface ToneOptions {
  /** -100..100, added to the luminance. */
  brightness: number;
  /** -100..100, stretches (positive) or flattens (negative) around mid-grey. */
  contrast: number;
  /** 0.2..5. Above 1 lifts the mid-tones (lighter), below 1 darkens them. */
  gamma: number;
  invert: boolean;
}

export const DEFAULT_TONE: ToneOptions = { brightness: 0, contrast: 0, gamma: 1, invert: false };

/** Rec. 709 luminance (0 black .. 1 white) of RGBA pixels, transparent pixels composited on white. */
export function luminance(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const y = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
    out[i] = y * a + (1 - a);
  }
  return out;
}

/** Brightness, contrast and gamma on luminance, then optional invert. Returns darkness. */
export function adjustTone(lum: ArrayLike<number>, width: number, height: number, o: ToneOptions): ToneGrid {
  const c = Math.max(-100, Math.min(95, o.contrast)) / 100;
  const factor = (1 + c) / (1 - c);
  const b = o.brightness / 100;
  const g = Math.max(0.05, o.gamma);
  const values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i++) {
    let v = (lum[i] + b - 0.5) * factor + 0.5;
    v = Math.min(1, Math.max(0, v)) ** (1 / g);
    values[i] = o.invert ? v : 1 - v;
  }
  return { width, height, values };
}

/**
 * Darkness at a paper point, bilinear between pixel centres. Outside the
 * placement the paper is white (0).
 */
export function sampler(grid: ToneGrid, place: Placement): (p: Point) => number {
  const { width: w, height: h, values } = grid;
  const sx = w / place.width;
  const sy = h / place.height;
  return (p) => {
    const gx = (p.x - place.x) * sx;
    const gy = (p.y - place.y) * sy;
    if (!(gx >= 0 && gx <= w && gy >= 0 && gy <= h)) return 0;
    const u = Math.min(w - 1, Math.max(0, gx - 0.5));
    const v = Math.min(h - 1, Math.max(0, gy - 0.5));
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    // A 1-pixel-wide or -tall grid has no neighbour to blend with on that axis.
    const i1 = Math.min(w - 1, i0 + 1);
    const j1 = Math.min(h - 1, j0 + 1);
    const fu = u - i0;
    const fv = v - j0;
    const top = values[j0 * w + i0] * (1 - fu) + values[j0 * w + i1] * fu;
    const bottom = values[j1 * w + i0] * (1 - fu) + values[j1 * w + i1] * fu;
    return top * (1 - fv) + bottom * fv;
  };
}

/** Grid coordinates (pixel units, 0 at the top-left corner of pixel 0) to paper mm. */
export function gridToPlace(p: Point, grid: ToneGrid, place: Placement): Point {
  return { x: place.x + (p.x / grid.width) * place.width, y: place.y + (p.y / grid.height) * place.height };
}
