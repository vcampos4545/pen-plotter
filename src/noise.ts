import { rng } from './stipple';

// Seeded 2D Perlin noise (Ken Perlin's "improved" noise, cut down to 2D).
// Small enough that a dependency is not worth it.

/** 12 gradient directions, evenly spaced, so no axis is favoured. */
const GRAD_X = new Float64Array(12);
const GRAD_Y = new Float64Array(12);
for (let i = 0; i < 12; i++) {
  GRAD_X[i] = Math.cos((i * Math.PI) / 6);
  GRAD_Y[i] = Math.sin((i * Math.PI) / 6);
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Perlin noise for one seed. Returns roughly -1..1 (in practice about ±0.9),
 * smooth everywhere and 0 at every integer lattice point.
 */
export function perlin2(seed: number): (x: number, y: number) => number {
  const rand = rng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const corner = (ix: number, iy: number, dx: number, dy: number) => {
    const g = perm[perm[ix & 255] + (iy & 255)] % 12;
    return GRAD_X[g] * dx + GRAD_Y[g] * dy;
  };

  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const dx = x - x0;
    const dy = y - y0;
    const u = fade(dx);
    const v = fade(dy);
    const a = corner(x0, y0, dx, dy);
    const b = corner(x0 + 1, y0, dx - 1, dy);
    const c = corner(x0, y0 + 1, dx, dy - 1);
    const d = corner(x0 + 1, y0 + 1, dx - 1, dy - 1);
    const top = a + u * (b - a);
    const bottom = c + u * (d - c);
    // A unit-gradient 2D Perlin peaks at ±√0.5; scale to about ±1.
    return (top + v * (bottom - top)) * Math.SQRT2;
  };
}

/** Sum of `octaves` layers of noise, each at twice the frequency and half the weight. Still about -1..1. */
export function fractal2(seed: number, octaves: number): (x: number, y: number) => number {
  const layers = Array.from({ length: Math.max(1, octaves) }, (_, i) => perlin2(seed + i * 7919));
  let total = 0;
  for (let i = 0; i < layers.length; i++) total += 0.5 ** i;
  return (x, y) => {
    let sum = 0;
    let f = 1;
    let w = 1;
    for (const n of layers) {
      // Offset each layer so lattice zeros do not line up.
      sum += w * n(x * f + 0.31 * f, y * f + 0.17 * f);
      f *= 2;
      w *= 0.5;
    }
    return sum / total;
  };
}
