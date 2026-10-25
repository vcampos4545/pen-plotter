import type { Point, Polyline } from './geometry';

// Strange attractors. Lorenz is a 3D flow, integrated with RK4 and projected
// at a chosen view angle. Clifford and De Jong are 2D maps whose orbits jump
// across the whole shape on every step, so the orbit itself is no use to a
// pen: joining the dots draws random chords, and dotting needs a pen lift per
// point. Instead a tiny segment on the attractor is pushed through the map
// again and again. The map is smooth, so each image is still one continuous
// curve, and it is stretched and folded along the attractor's filaments until
// it traces the familiar shape as a single line. Output is in the attractor's
// own units with y up; the caller fits it to the paper.

export interface LorenzOptions {
  sigma: number;
  rho: number;
  beta: number;
  /** RK4 steps of 0.005 time units each. */
  steps: number;
  /** View: turn about the vertical (z) axis, degrees. 0 looks along y. */
  yaw: number;
  /** View: tilt down from horizontal, degrees. */
  pitch: number;
}

export const LORENZ_DT = 0.005;
/** Steps run before drawing, so the line starts on the attractor rather than at the start point. */
const LORENZ_SETTLE = 400;

export function lorenz(o: LorenzOptions): Polyline {
  let x = 1;
  let y = 1;
  let z = 1;
  const f = (x: number, y: number, z: number) => [o.sigma * (y - x), x * (o.rho - z) - y, x * y - o.beta * z];
  const h = LORENZ_DT;
  const yaw = (o.yaw * Math.PI) / 180;
  const pitch = (o.pitch * Math.PI) / 180;
  const [cy, sy, cp, sp] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)];
  const out: Polyline = [];
  for (let i = 0; i < LORENZ_SETTLE + o.steps; i++) {
    const k1 = f(x, y, z);
    const k2 = f(x + (h / 2) * k1[0], y + (h / 2) * k1[1], z + (h / 2) * k1[2]);
    const k3 = f(x + (h / 2) * k2[0], y + (h / 2) * k2[1], z + (h / 2) * k2[2]);
    const k4 = f(x + h * k3[0], y + h * k3[1], z + h * k3[2]);
    x += (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
    y += (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    z += (h / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
    if (!Number.isFinite(x + y + z)) break;
    if (i < LORENZ_SETTLE) continue;
    // Turn about z, then tilt the view; screen x is the turned x, screen up is the tilted z.
    const rx = x * cy - y * sy;
    const ry = x * sy + y * cy;
    out.push({ x: rx, y: z * cp - ry * sp });
  }
  return out;
}

export type MapKind = 'clifford' | 'dejong';

export interface MapParams {
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface MapOptions extends MapParams {
  /** Length of line to draw, in multiples of the attractor's diagonal. More gives a denser drawing. */
  density: number;
}

/** Most passes through the map; a slowly stretching attractor stops here. */
const MAX_PASSES = 400;

/** Parameter sets known to give a full, interesting attractor. */
export const MAP_PRESETS: Record<MapKind, Array<{ name: string } & MapParams>> = {
  clifford: [
    { name: 'Wings', a: -1.4, b: 1.6, c: 1.0, d: 0.7 },
    { name: 'Shell', a: 1.7, b: 1.7, c: 0.6, d: 1.2 },
    { name: 'Ribbon', a: -1.7, b: 1.3, c: -0.1, d: -1.2 },
    { name: 'Moth', a: -1.8, b: -2.0, c: -0.5, d: -0.9 },
    { name: 'Lace', a: 1.5, b: -1.8, c: 1.6, d: 0.9 },
  ],
  dejong: [
    { name: 'Bloom', a: 1.4, b: -2.3, c: 2.4, d: -2.1 },
    { name: 'Smoke', a: 2.01, b: -2.53, c: 1.61, d: -0.33 },
    { name: 'Swirl', a: -2.7, b: -0.09, c: -0.86, d: -2.2 },
    { name: 'Veil', a: -0.827, b: -1.637, c: 1.659, d: -0.943 },
    { name: 'Drift', a: -2.24, b: 0.43, c: -0.65, d: -2.43 },
  ],
};

export function mapStep(kind: MapKind, p: MapParams): (x: number, y: number) => Point {
  const { a, b, c, d } = p;
  return kind === 'clifford'
    ? (x, y) => ({ x: Math.sin(a * y) + c * Math.cos(a * x), y: Math.sin(b * x) + d * Math.cos(b * y) })
    : (x, y) => ({ x: Math.sin(a * y) - Math.cos(b * x), y: Math.sin(c * x) - Math.cos(d * y) });
}

export interface OrbitStats {
  /** Largest Lyapunov exponent per step: > 0 means chaotic. */
  lyapunov: number;
  /** Bounding box of the orbit after settling. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** A point on the attractor. */
  start: Point;
}

/** Run the orbit and a tangent vector alongside it to measure the attractor. */
export function orbitStats(kind: MapKind, p: MapParams, steps = 4000): OrbitStats {
  const f = mapStep(kind, p);
  let q: Point = { x: 0.1, y: 0.1 };
  for (let i = 0; i < 500; i++) q = f(q.x, q.y);
  const start = q;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  // Tangent vector pushed through the Jacobian by finite differences.
  let vx = 1e-7;
  let vy = 0;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const next = f(q.x, q.y);
    const moved = f(q.x + vx, q.y + vy);
    vx = moved.x - next.x;
    vy = moved.y - next.y;
    const len = Math.hypot(vx, vy) || 1e-300;
    sum += Math.log(len / 1e-7);
    vx = (vx / len) * 1e-7;
    vy = (vy / len) * 1e-7;
    q = next;
    minX = Math.min(minX, q.x);
    minY = Math.min(minY, q.y);
    maxX = Math.max(maxX, q.x);
    maxY = Math.max(maxY, q.y);
  }
  return { lyapunov: sum / steps, minX, minY, maxX, maxY, start };
}

/** Chaotic and big enough to be worth drawing. */
export function isInteresting(s: OrbitStats): boolean {
  return s.lyapunov > 0.1 && Math.min(s.maxX - s.minX, s.maxY - s.minY) > 0.5;
}

/** Look for chaotic parameters with `rand`; falls back to the first preset. */
export function randomMapParams(kind: MapKind, rand: () => number): MapParams {
  const r = () => Math.round((rand() * 6 - 3) * 100) / 100;
  for (let tries = 0; tries < 500; tries++) {
    const p = { a: r(), b: r(), c: r(), d: r() };
    if (isInteresting(orbitStats(kind, p, 2000))) return p;
  }
  const { name: _, ...fallback } = MAP_PRESETS[kind][0];
  return fallback;
}

export interface MapCurve {
  line: Polyline;
  /** Line length reached, in multiples of the attractor's diagonal. Short of `density` when the point budget ran out. */
  density: number;
  /** False when the parameters settle to a point or a short cycle. */
  chaotic: boolean;
}

/**
 * The image of a tiny segment on the attractor, pushed through the map until
 * the line is `density` attractor diagonals long, as one polyline. Gaps wider than 1/`resolution` of the
 * attractor's size are filled by mapping more points of the segment, so the
 * line stays continuous however much it has been stretched.
 */
export function mapCurve(kind: MapKind, o: MapOptions, maxPoints = 150_000, resolution = 1000): MapCurve {
  const f = mapStep(kind, o);
  const stats = orbitStats(kind, o);
  const chaotic = isInteresting(stats);
  const diag = Math.hypot(stats.maxX - stats.minX, stats.maxY - stats.minY) || 1;
  const eps = diag / resolution;
  let line: Polyline = [stats.start, { x: stats.start.x + eps, y: stats.start.y + eps * 0.6 }];
  let length = 0;
  for (let pass = 0; pass < MAX_PASSES && length < o.density * diag; pass++) {
    const mapped = line.map((q) => f(q.x, q.y));
    const next: Polyline = [mapped[0]];
    for (let i = 1; i < line.length && next.length <= maxPoints; i++) {
      // Where the map stretched a gap past eps, refill it by mapping points
      // between the two samples on the previous line, which was finer than eps.
      const stack: Array<[Point, Point, Point, Point, number]> = [[line[i - 1], mapped[i - 1], line[i], mapped[i], 0]];
      while (stack.length) {
        const [a, fa, b, fb, depth] = stack.pop()!;
        if (Math.hypot(fb.x - fa.x, fb.y - fa.y) > eps && depth < 40) {
          const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const fm = f(m.x, m.y);
          // Right half pushed first so the left half is finished first.
          stack.push([m, fm, b, fb, depth + 1], [a, fa, m, fm, depth + 1]);
          continue;
        }
        // Where the map shrinks the line, samples bunch up: skip those within
        // a fraction of a gap of the last one kept (always keep the end).
        const last = next[next.length - 1];
        if (Math.hypot(fb.x - last.x, fb.y - last.y) >= eps / 4 || (i === line.length - 1 && stack.length === 0)) next.push(fb);
      }
    }
    if (next.length > maxPoints) break;
    line = next;
    length = 0;
    for (let i = 1; i < line.length; i++) length += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
  }
  return { line, density: length / diag, chaotic };
}
