import type { Point, Polyline } from './geometry';
import { simplifyRDP } from './simplify';
import { sampler, type Placement, type ToneGrid } from './tone';

// Line styles that sweep a path over the photo and modulate it by darkness.
// All output is paper mm inside `place`.

/** RDP tolerance for generated waves: well under the pen width, drops points on flat runs. */
const WAVE_TOLERANCE = 0.05;

/** Wave frequency at darkness d, as a fraction of the maximum: light areas wiggle slower. */
const freqScale = (d: number) => 0.25 + 0.75 * d;

/** Step along a wave so each full wave gets at least 8 points. */
const waveStep = (frequency: number) => Math.min(0.5, 1 / (Math.max(0.01, frequency) * 8));

export interface SquiggleOptions {
  /** Number of rows across the height. */
  lines: number;
  /** Peak amplitude at full darkness, as a fraction of the row gap. 0.5 lets neighbouring peaks touch. */
  amplitude: number;
  /** Waves per mm at full darkness. */
  frequency: number;
}

/** Horizontal rows whose sine wiggle grows taller and tighter where the photo is darker. */
export function squiggle(grid: ToneGrid, place: Placement, o: SquiggleOptions): Polyline[] {
  const rows = Math.max(1, Math.round(o.lines));
  const gap = place.height / rows;
  const dark = sampler(grid, place);
  const step = waveStep(o.frequency);
  const n = Math.max(1, Math.ceil(place.width / step));
  const amp = o.amplitude * gap;
  const out: Polyline[] = [];
  for (let r = 0; r < rows; r++) {
    const yc = place.y + (r + 0.5) * gap;
    const pts: Polyline = [];
    let phase = 0;
    for (let k = 0; k <= n; k++) {
      const x = place.x + (k / n) * place.width;
      // Average across the row's band so thin features between rows still count.
      const d = (dark({ x, y: yc - gap / 3 }) + dark({ x, y: yc }) + dark({ x, y: yc + gap / 3 })) / 3;
      if (k > 0) phase += 2 * Math.PI * o.frequency * freqScale(d) * (place.width / n);
      const y = yc + amp * d * Math.sin(phase);
      pts.push({ x, y: Math.min(place.y + place.height, Math.max(place.y, y)) });
    }
    // Alternate direction so consecutive rows start where the last one ended.
    if (r % 2 === 1) pts.reverse();
    out.push(simplifyRDP(pts, WAVE_TOLERANCE));
  }
  return out;
}

export interface SpiralOptions {
  /** Distance between turns, mm. */
  spacing: number;
  /** Peak radial wobble at full darkness, as a fraction of the spacing. */
  amplitude: number;
  /** Waves per mm along the spiral at full darkness. */
  frequency: number;
}

/**
 * One Archimedean spiral from the centre of `place` out to its inscribed
 * circle, wobbling radially where the photo is dark. A single stroke: the pen
 * never lifts.
 */
export function spiral(grid: ToneGrid, place: Placement, o: SpiralOptions): Polyline[] {
  const spacing = Math.max(0.1, o.spacing);
  const amp = o.amplitude * spacing;
  const cx = place.x + place.width / 2;
  const cy = place.y + place.height / 2;
  // Keep the outermost wobble inside the placement.
  const maxR = Math.min(place.width, place.height) / 2 - amp;
  if (maxR <= 0) return [];
  const dark = sampler(grid, place);
  const step = waveStep(o.frequency);
  const pts: Polyline = [];
  let theta = 0;
  let phase = 0;
  for (;;) {
    const r = Math.min(maxR, (spacing * theta) / (2 * Math.PI));
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const d = dark({ x: cx + r * c, y: cy + r * s });
    // Fade the wobble in over the first turn so the centre does not scribble.
    const rr = r + amp * d * Math.min(1, r / spacing) * Math.sin(phase);
    pts.push({ x: cx + rr * c, y: cy + rr * s });
    if (r >= maxR) break;
    // A fixed step along the curve, not a fixed angle, so the outer turns stay smooth.
    theta += step / Math.max(r, spacing / 2);
    phase += 2 * Math.PI * o.frequency * freqScale(d) * step;
  }
  return [simplifyRDP(pts, WAVE_TOLERANCE)];
}

export interface HatchOptions {
  /** Distance between parallel lines, mm. */
  spacing: number;
  /** Direction of the first layer, degrees (0 is horizontal). */
  angle: number;
  /** 1..4. Each layer adds a direction, drawn only where the photo is darker than its threshold. */
  layers: number;
}

/** Layer k of n is drawn where darkness reaches (k + 1) / (n + 1). */
export function hatchThresholds(layers: number): number[] {
  const n = Math.max(1, Math.min(4, Math.round(layers)));
  return Array.from({ length: n }, (_, k) => (k + 1) / (n + 1));
}

const HATCH_TURNS = [0, 90, 45, -45];
/** Sample step along a hatch line, mm. */
const HATCH_STEP = 0.25;
/** Runs shorter than this are dots, not hatching, mm. */
const HATCH_MIN_RUN = 0.75;

/** The part of the line `origin + t·dir` inside `place`, as [t0, t1], or undefined if it misses. */
export function clipLine(origin: Point, dir: Point, place: Placement): [number, number] | undefined {
  let t0 = -Infinity;
  let t1 = Infinity;
  const axes: Array<[number, number, number, number]> = [
    [origin.x, dir.x, place.x, place.x + place.width],
    [origin.y, dir.y, place.y, place.y + place.height],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return undefined;
      continue;
    }
    const a = (lo - o) / d;
    const b = (hi - o) / d;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t1 > t0 ? [t0, t1] : undefined;
}

/** Parallel lines in light areas, crossed by more directions as the photo gets darker. */
export function hatch(grid: ToneGrid, place: Placement, o: HatchOptions): Polyline[] {
  const spacing = Math.max(0.1, o.spacing);
  const dark = sampler(grid, place);
  const cx = place.x + place.width / 2;
  const cy = place.y + place.height / 2;
  const half = Math.hypot(place.width, place.height) / 2;
  const out: Polyline[] = [];
  hatchThresholds(o.layers).forEach((threshold, layer) => {
    const a = ((o.angle + HATCH_TURNS[layer]) * Math.PI) / 180;
    const dir = { x: Math.cos(a), y: Math.sin(a) };
    const normal = { x: -dir.y, y: dir.x };
    const count = Math.floor((2 * half) / spacing);
    // Centre the set of lines on the placement.
    const first = -((count - 1) * spacing) / 2;
    for (let k = 0; k < count; k++) {
      const off = first + k * spacing;
      const origin = { x: cx + normal.x * off, y: cy + normal.y * off };
      const span = clipLine(origin, dir, place);
      if (!span) continue;
      const at = (t: number): Point => ({ x: origin.x + dir.x * t, y: origin.y + dir.y * t });
      const n = Math.max(1, Math.ceil((span[1] - span[0]) / HATCH_STEP));
      let start: number | undefined;
      for (let i = 0; i <= n + 1; i++) {
        const t = span[0] + ((span[1] - span[0]) * i) / n;
        const on = i <= n && dark(at(t)) >= threshold;
        if (on && start === undefined) start = t;
        if (!on && start !== undefined) {
          const end = span[0] + ((span[1] - span[0]) * (i - 1)) / n;
          if (end - start >= HATCH_MIN_RUN) out.push([at(start), at(end)]);
          start = undefined;
        }
      }
    }
  });
  return out;
}
