import type { Polyline } from './geometry';

// Spirograph and harmonograph curves. Output is in the curve's own units with
// y up; the caller fits it to the paper.

/** Upper bound on raw samples per curve; simplification after fitting removes most. */
const MAX_SAMPLES = 300_000;
/** A harmonograph stops when its swing has decayed to this fraction. */
export const HARMONOGRAPH_END = 0.03;

export interface SpirographOptions {
  /** Teeth on the fixed ring. */
  ring: number;
  /** Teeth on the rolling wheel. */
  wheel: number;
  /** Pen hole distance from the wheel's centre, as a fraction of the wheel radius. */
  pen: number;
  /** Roll the wheel around the outside of the ring (epitrochoid) instead of inside. */
  outside: boolean;
}

export function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Turns of the wheel's centre around the ring before the pen is back where it started. */
export function spirographLoops(o: Pick<SpirographOptions, 'ring' | 'wheel'>): number {
  return Math.round(o.wheel) / gcd(o.ring, o.wheel);
}

/**
 * Hypotrochoid (wheel inside the ring) or epitrochoid (outside). Ring and
 * wheel are whole tooth counts, so the curve closes after wheel / gcd(ring,
 * wheel) trips around the ring; the last point equals the first.
 */
export function spirograph(o: SpirographOptions, samplesPerLoop = 1440): Polyline {
  const R = Math.round(o.ring);
  const r = Math.round(o.wheel);
  const d = o.pen * r;
  const loops = spirographLoops(o);
  // The pen turns (R ± r) / r times per loop; sample so each of those turns gets enough points.
  const k = o.outside ? (R + r) / r : (R - r) / r;
  const n = Math.min(MAX_SAMPLES, Math.ceil(loops * Math.max(samplesPerLoop, 90 * Math.abs(k))));
  const c = o.outside ? R + r : R - r;
  const out: Polyline = [];
  for (let i = 0; i <= n; i++) {
    // Exact multiple of 2π at the end so the curve closes on its first point.
    const t = i === n ? 0 : (2 * Math.PI * loops * i) / n;
    const x = c * Math.cos(t) + (o.outside ? -d : d) * Math.cos(k * t);
    const y = c * Math.sin(t) - d * Math.sin(k * t);
    out.push({ x, y });
  }
  return out;
}

export interface HarmonographOptions {
  /** Swings per second of the X and Y pendulums. */
  freqX: number;
  freqY: number;
  /** Starting phase of each pendulum, degrees. */
  phaseX: number;
  phaseY: number;
  /** Swings per second of the rotary (paper) pendulum. */
  freqR: number;
  /** Size of the rotary motion relative to the X and Y swings, 0..1. */
  rotary: number;
  /** Amplitude lost per second, as a fraction (0.02 = 2 %/s). */
  damping: number;
  /** Seconds of swinging to draw. */
  duration: number;
}

/**
 * A rotary harmonograph: two lateral pendulums move the pen in X and Y, a
 * third moves the paper in a circle, and all of them die away together.
 */
export function harmonograph(o: HarmonographOptions, samplesPerSwing = 120): Polyline {
  const decay = -Math.log(Math.max(1e-6, 1 - Math.min(0.999, o.damping)));
  // Stop once the swing has died to a few percent: the rest is an ink blot in the middle.
  const duration = decay > 0 ? Math.min(o.duration, Math.log(1 / HARMONOGRAPH_END) / decay) : o.duration;
  const fMax = Math.max(Math.abs(o.freqX), Math.abs(o.freqY), Math.abs(o.freqR), 0.01);
  const n = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(duration * fMax * samplesPerSwing)));
  const px = (o.phaseX * Math.PI) / 180;
  const py = (o.phaseY * Math.PI) / 180;
  const out: Polyline = [];
  for (let i = 0; i <= n; i++) {
    const t = (duration * i) / n;
    const a = Math.exp(-decay * t);
    const w = 2 * Math.PI * t;
    out.push({
      x: a * (Math.sin(w * o.freqX + px) + o.rotary * Math.sin(w * o.freqR)),
      y: a * (Math.sin(w * o.freqY + py) + o.rotary * Math.cos(w * o.freqR)),
    });
  }
  return out;
}
