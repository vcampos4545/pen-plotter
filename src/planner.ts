import { dist, type Point, type Polyline } from './geometry';

// Path planning: merge touching strokes, then order and orient them so the pen
// travels as little as possible while lifted. The tour starts at `origin` and
// returns there, matching the generated G-code.

export interface PlanOptions {
  origin?: Point;
  /** Endpoints closer than this (mm) are joined into one stroke. */
  mergeTolerance?: number;
  /** Wall-clock budget for the 2-opt improvement pass, in ms. */
  timeLimitMs?: number;
}

export interface PlanResult {
  strokes: Polyline[];
  /** Pen-up travel of the input, in input order and direction. */
  travelBefore: number;
  /** Pen-up travel after merging and optimization. */
  travelAfter: number;
  drawLength: number;
  inputCount: number;
  mergedCount: number;
  /** True when 2-opt stopped because it ran out of time, not because it converged. */
  timedOut: boolean;
  elapsedMs: number;
}

const ORIGIN: Point = { x: 0, y: 0 };

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Total pen-up distance: origin -> each stroke in order -> back to origin. */
export function penUpDistance(strokes: Polyline[], origin: Point = ORIGIN): number {
  let total = 0;
  let pos = origin;
  for (const s of strokes) {
    if (s.length === 0) continue;
    total += dist(pos, s[0]);
    pos = s[s.length - 1];
  }
  return total + dist(pos, origin);
}

export function drawDistance(strokes: Polyline[]): number {
  let total = 0;
  for (const s of strokes) for (let i = 1; i < s.length; i++) total += dist(s[i - 1], s[i]);
  return total;
}

/**
 * Join strokes whose endpoints coincide within `tolerance` so the pen stays
 * down across them. Strokes may be reversed to make the join. A spatial grid
 * keeps lookups near constant time.
 */
export function mergeStrokes(strokes: Polyline[], tolerance = 0.05): Polyline[] {
  const list = strokes.filter((s) => s.length > 0);
  const n = list.length;
  if (n <= 1 || tolerance <= 0) return list.map((s) => s.slice());

  const cell = tolerance;
  const grid = new Map<string, number[]>(); // cell -> endpoint ids (stroke * 2 + end)
  const key = (p: Point) => `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
  const endpoint = (id: number) => {
    const s = list[id >> 1];
    return id & 1 ? s[s.length - 1] : s[0];
  };
  for (let id = 0; id < n * 2; id++) {
    const k = key(endpoint(id));
    const bucket = grid.get(k);
    if (bucket) bucket.push(id);
    else grid.set(k, [id]);
  }

  const used = new Uint8Array(n);
  // Find an unused stroke with an endpoint within tolerance of p.
  const findNear = (p: Point): number => {
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const id of bucket) {
          if (!used[id >> 1] && dist(endpoint(id), p) <= tolerance) return id;
        }
      }
    }
    return -1;
  };

  const out: Polyline[] = [];
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let chain = list[i].slice();

    // Grow forward from the chain's end.
    for (;;) {
      const id = findNear(chain[chain.length - 1]);
      if (id < 0) break;
      used[id >> 1] = 1;
      const s = list[id >> 1];
      const next = id & 1 ? s.slice().reverse() : s;
      for (let k = 1; k < next.length; k++) chain.push(next[k]);
    }
    // Grow backward from the chain's start.
    for (;;) {
      const id = findNear(chain[0]);
      if (id < 0) break;
      used[id >> 1] = 1;
      const s = list[id >> 1];
      const prev = id & 1 ? s : s.slice().reverse();
      chain = prev.slice(0, -1).concat(chain);
    }
    out.push(chain);
  }
  return out;
}

/** Greedy nearest neighbor: repeatedly draw the stroke whose nearer end is closest. */
export function greedyOrder(strokes: Polyline[], origin: Point = ORIGIN): Polyline[] {
  const n = strokes.length;
  const used = new Uint8Array(n);
  const out: Polyline[] = [];
  let pos = origin;
  for (let step = 0; step < n; step++) {
    let best = -1;
    let bestDist = Infinity;
    let bestReversed = false;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const s = strokes[i];
      const dStart = dist(pos, s[0]);
      if (dStart < bestDist) {
        bestDist = dStart;
        best = i;
        bestReversed = false;
      }
      const dEnd = dist(pos, s[s.length - 1]);
      if (dEnd < bestDist) {
        bestDist = dEnd;
        best = i;
        bestReversed = true;
      }
    }
    used[best] = 1;
    const chosen = bestReversed ? strokes[best].slice().reverse() : strokes[best];
    out.push(chosen);
    pos = chosen[chosen.length - 1];
  }
  return out;
}

/**
 * 2-opt over oriented strokes. Reversing positions i..j reverses their order
 * and flips each stroke, which only changes the two boundary travel moves.
 * With i === j this is a single-stroke flip. Runs until no move improves the
 * tour or `deadline` (a performance.now() timestamp) passes.
 */
export function twoOpt(
  strokes: Polyline[],
  origin: Point = ORIGIN,
  deadline = Infinity,
): { strokes: Polyline[]; timedOut: boolean } {
  const n = strokes.length;
  if (n === 0) return { strokes: [], timedOut: false };

  // Per position: stroke index, whether flipped, and cached start/end coords.
  const idx = Array.from({ length: n }, (_, i) => i);
  const flip = new Uint8Array(n);
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const ex = new Float64Array(n);
  const ey = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const s = strokes[k];
    sx[k] = s[0].x;
    sy[k] = s[0].y;
    ex[k] = s[s.length - 1].x;
    ey[k] = s[s.length - 1].y;
  }
  const ox = origin.x;
  const oy = origin.y;
  const d = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

  let improved = true;
  let timedOut = false;
  while (improved && !timedOut) {
    improved = false;
    for (let i = 0; i < n && !timedOut; i++) {
      if (now() > deadline) {
        timedOut = true;
        break;
      }
      // End of the stroke before position i (origin when i === 0).
      const px = i === 0 ? ox : ex[i - 1];
      const py = i === 0 ? oy : ey[i - 1];
      for (let j = i; j < n; j++) {
        // Start of the stroke after position j (origin when j is last).
        const qx = j === n - 1 ? ox : sx[j + 1];
        const qy = j === n - 1 ? oy : sy[j + 1];
        const before = d(px, py, sx[i], sy[i]) + d(ex[j], ey[j], qx, qy);
        const after = d(px, py, ex[j], ey[j]) + d(sx[i], sy[i], qx, qy);
        if (after < before - 1e-9) {
          // Reverse positions i..j and flip every stroke in the range.
          for (let a = i, b = j; a <= b; a++, b--) {
            const ia = idx[a], fa = flip[a], sxa = sx[a], sya = sy[a], exa = ex[a], eya = ey[a];
            const ib = idx[b], fb = flip[b], sxb = sx[b], syb = sy[b], exb = ex[b], eyb = ey[b];
            idx[a] = ib;
            flip[a] = fb ^ 1;
            sx[a] = exb;
            sy[a] = eyb;
            ex[a] = sxb;
            ey[a] = syb;
            idx[b] = ia;
            flip[b] = fa ^ 1;
            sx[b] = exa;
            sy[b] = eya;
            ex[b] = sxa;
            ey[b] = sya;
          }
          improved = true;
        }
      }
    }
  }

  const out = idx.map((s, k) => (flip[k] ? strokes[s].slice().reverse() : strokes[s]));
  return { strokes: out, timedOut };
}

/** Full planning pass: merge -> greedy nearest neighbor -> 2-opt (time capped). */
export function planStrokes(input: Polyline[], options: PlanOptions = {}): PlanResult {
  const origin = options.origin ?? ORIGIN;
  const started = now();
  const strokes = input.filter((s) => s.length > 0);
  const merged = mergeStrokes(strokes, options.mergeTolerance ?? 0.05);
  const greedy = greedyOrder(merged, origin);
  const { strokes: optimized, timedOut } = twoOpt(greedy, origin, started + (options.timeLimitMs ?? 1000));
  return {
    strokes: optimized,
    travelBefore: penUpDistance(strokes, origin),
    travelAfter: penUpDistance(optimized, origin),
    drawLength: drawDistance(optimized),
    inputCount: strokes.length,
    mergedCount: merged.length,
    timedOut,
    elapsedMs: now() - started,
  };
}
