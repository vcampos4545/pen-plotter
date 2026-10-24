import type { Point, Polyline } from './geometry';
import type { ToneGrid } from './tone';

// TSP art: weighted stippling (Lloyd relaxation on a darkness-weighted
// Voronoi diagram, sampled on the pixel grid), then one tour through every
// stipple. Coordinates are grid units (pixel 0 spans 0..1).

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Small, fast, seedable PRNG (mulberry32) so a given photo always stipples the same. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform-bucket spatial index over points, rebuilt per use. */
export class PointGrid {
  readonly cell: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly start: Int32Array;
  /** End of each cell's live items; shrinks as points are removed. */
  private readonly end: Int32Array;
  private readonly items: Int32Array;
  private readonly slot: Int32Array;
  private readonly cellOf: Int32Array;

  constructor(
    private readonly xs: Float64Array,
    private readonly ys: Float64Array,
    width: number,
    height: number,
    count = xs.length,
  ) {
    // About two points per cell.
    this.cell = Math.max(1e-6, Math.sqrt((width * height * 2) / Math.max(1, count)));
    this.cols = Math.max(1, Math.ceil(width / this.cell));
    this.rows = Math.max(1, Math.ceil(height / this.cell));
    const counts = new Int32Array(this.cols * this.rows + 1);
    const cellOf = new Int32Array(count);
    for (let p = 0; p < count; p++) {
      cellOf[p] = this.cellIndex(xs[p], ys[p]);
      counts[cellOf[p] + 1]++;
    }
    for (let c = 0; c < this.cols * this.rows; c++) counts[c + 1] += counts[c];
    this.start = counts.slice();
    this.items = new Int32Array(count);
    this.slot = new Int32Array(count);
    this.cellOf = cellOf;
    const fill = counts.slice();
    for (let p = 0; p < count; p++) {
      this.slot[p] = fill[cellOf[p]];
      this.items[fill[cellOf[p]]++] = p;
    }
    this.end = fill;
  }

  /** Take a point out of the index. */
  remove(p: number): void {
    const c = this.cellOf[p];
    const last = --this.end[c];
    const q = this.items[last];
    this.items[this.slot[p]] = q;
    this.slot[q] = this.slot[p];
    this.items[last] = p;
    this.slot[p] = last;
  }

  private cellIndex(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)));
    return cy * this.cols + cx;
  }

  /** Nearest point to (x, y) for which `ok` holds, or -1. Searches outward ring by ring. */
  nearest(x: number, y: number, ok: (p: number) => boolean = () => true): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)));
    let best = -1;
    let bestD = Infinity;
    const maxRing = Math.max(this.cols, this.rows);
    for (let ring = 0; ring <= maxRing; ring++) {
      // Every point in this ring is at least (ring - 1) cells away.
      const minD = (ring - 1) * this.cell;
      if (best >= 0 && minD > 0 && minD * minD > bestD) break;
      for (let gy = cy - ring; gy <= cy + ring; gy++) {
        if (gy < 0 || gy >= this.rows) continue;
        const edgeRow = gy === cy - ring || gy === cy + ring;
        for (let gx = cx - ring; gx <= cx + ring; gx += edgeRow ? 1 : 2 * ring || 1) {
          if (gx < 0 || gx >= this.cols) continue;
          const c = gy * this.cols + gx;
          for (let s = this.start[c]; s < this.end[c]; s++) {
            const p = this.items[s];
            const dx = this.xs[p] - x;
            const dy = this.ys[p] - y;
            const d = dx * dx + dy * dy;
            if (d < bestD && ok(p)) {
              bestD = d;
              best = p;
            }
          }
        }
      }
    }
    return best;
  }
}

/**
 * `count` stipples whose density follows darkness. Starts from random samples
 * drawn in proportion to darkness, then moves each point to the darkness-weighted
 * centroid of its Voronoi cell until `deadline` or `iterations` passes.
 */
export function stipple(grid: ToneGrid, count: number, opts: { seed?: number; iterations?: number; deadline?: number } = {}): Point[] {
  const { width: w, height: h, values } = grid;
  const n = Math.max(0, Math.round(count));
  // Cumulative darkness, for sampling pixels in proportion to it.
  const cdf = new Float64Array(w * h);
  let total = 0;
  for (let k = 0; k < w * h; k++) {
    total += Math.max(0, values[k]);
    cdf[k] = total;
  }
  if (n === 0 || total <= 0) return [];
  const rand = rng(opts.seed ?? 1);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    const target = rand() * total;
    let lo = 0;
    let hi = w * h - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    xs[p] = (lo % w) + rand();
    ys[p] = Math.floor(lo / w) + rand();
  }

  const iterations = opts.iterations ?? 50;
  const deadline = opts.deadline ?? Infinity;
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const sw = new Float64Array(n);
  for (let it = 0; it < iterations && now() < deadline; it++) {
    const index = new PointGrid(xs, ys, w, h);
    sx.fill(0);
    sy.fill(0);
    sw.fill(0);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const d = values[j * w + i];
        if (d <= 0) continue;
        const p = index.nearest(i + 0.5, j + 0.5);
        sx[p] += d * (i + 0.5);
        sy[p] += d * (j + 0.5);
        sw[p] += d;
      }
    }
    let moved = 0;
    for (let p = 0; p < n; p++) {
      if (sw[p] <= 0) continue;
      const nx = sx[p] / sw[p];
      const ny = sy[p] / sw[p];
      moved = Math.max(moved, Math.abs(nx - xs[p]) + Math.abs(ny - ys[p]));
      xs[p] = nx;
      ys[p] = ny;
    }
    // Settled to a fraction of a pixel: more passes change nothing visible.
    if (moved < 0.01) break;
  }
  return Array.from({ length: n }, (_, p) => ({ x: xs[p], y: ys[p] }));
}

/** Length of the open path through `points` in `order`. */
export function tourLength(points: Point[], order: ArrayLike<number>): number {
  let total = 0;
  for (let k = 1; k < order.length; k++) {
    const a = points[order[k - 1]];
    const b = points[order[k]];
    total += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return total;
}

/**
 * Greedy nearest-neighbour order for separate lines: from `start`, repeatedly
 * draw the line with the nearest free end, reversing it when that end is its last
 * point. A cheap first pass; the planner still optimizes the result.
 */
export function orderLines(lines: Polyline[], start: Point = { x: 0, y: 0 }): Polyline[] {
  const n = lines.length;
  if (n <= 1) return lines.slice();
  // Endpoint e belongs to line e >> 1; odd e is the line's last point.
  const xs = new Float64Array(2 * n);
  const ys = new Float64Array(2 * n);
  let maxX = 0;
  let maxY = 0;
  for (let i = 0; i < n; i++) {
    const l = lines[i];
    xs[2 * i] = l[0].x;
    ys[2 * i] = l[0].y;
    xs[2 * i + 1] = l[l.length - 1].x;
    ys[2 * i + 1] = l[l.length - 1].y;
  }
  for (let e = 0; e < 2 * n; e++) {
    maxX = Math.max(maxX, xs[e]);
    maxY = Math.max(maxY, ys[e]);
  }
  const index = new PointGrid(xs, ys, maxX + 1e-6, maxY + 1e-6);
  const out: Polyline[] = [];
  let x = start.x;
  let y = start.y;
  for (let k = 0; k < n; k++) {
    const e = index.nearest(x, y);
    index.remove(e);
    index.remove(e ^ 1);
    const l = e & 1 ? lines[e >> 1].slice().reverse() : lines[e >> 1];
    out.push(l);
    x = l[l.length - 1].x;
    y = l[l.length - 1].y;
  }
  return out;
}

/** Greedy nearest-neighbour open tour, starting from the point nearest (0, 0). */
export function nearestNeighbourTour(points: Point[]): Int32Array {
  const n = points.length;
  const order = new Int32Array(n);
  if (n === 0) return order;
  const xs = Float64Array.from(points, (p) => p.x);
  const ys = Float64Array.from(points, (p) => p.y);
  let maxX = 0;
  let maxY = 0;
  for (let p = 0; p < n; p++) {
    maxX = Math.max(maxX, xs[p]);
    maxY = Math.max(maxY, ys[p]);
  }
  const index = new PointGrid(xs, ys, maxX + 1e-6, maxY + 1e-6);
  let at = index.nearest(0, 0);
  for (let k = 0; k < n; k++) {
    order[k] = at;
    index.remove(at);
    if (k < n - 1) at = index.nearest(xs[at], ys[at]);
  }
  return order;
}

/**
 * 2-opt on an open path, using each point's nearest neighbours as candidates
 * and don't-look bits. Improves `order` in place until no move helps or
 * `deadline` passes. Returns whether it stopped on time rather than converging.
 */
export function twoOptTour(points: Point[], order: Int32Array, deadline = Infinity, neighbours = 8): boolean {
  const n = order.length;
  if (n < 4) return false;
  const xs = Float64Array.from(points, (p) => p.x);
  const ys = Float64Array.from(points, (p) => p.y);
  const d = (a: number, b: number) => Math.hypot(xs[a] - xs[b], ys[a] - ys[b]);

  // Candidate lists: the k nearest points of each point.
  let maxX = 0;
  let maxY = 0;
  for (let p = 0; p < n; p++) {
    maxX = Math.max(maxX, xs[p]);
    maxY = Math.max(maxY, ys[p]);
  }
  const index = new PointGrid(xs, ys, maxX + 1e-6, maxY + 1e-6);
  const k = Math.min(neighbours, n - 1);
  const near = new Int32Array(n * k);
  const taken = new Set<number>();
  for (let p = 0; p < n; p++) {
    taken.clear();
    taken.add(p);
    const ok = (q: number) => !taken.has(q);
    for (let c = 0; c < k; c++) {
      const q = index.nearest(xs[p], ys[p], ok);
      near[p * k + c] = q;
      taken.add(q);
    }
    if (now() > deadline) return true;
  }

  const pos = new Int32Array(n);
  for (let i = 0; i < n; i++) pos[order[i]] = i;
  const reverse = (i: number, j: number) => {
    for (; i < j; i++, j--) {
      const a = order[i];
      const b = order[j];
      order[i] = b;
      order[j] = a;
      pos[b] = i;
      pos[a] = j;
    }
  };

  // Don't-look bits as a queue of points worth re-examining.
  const queued = new Uint8Array(n).fill(1);
  const queue: number[] = Array.from(order);
  let checks = 0;
  while (queue.length > 0) {
    if ((++checks & 63) === 0 && now() > deadline) return true;
    const a = queue.pop()!;
    queued[a] = 0;
    const touch = (...ps: number[]) => {
      for (const p of ps) {
        if (p >= 0 && !queued[p]) {
          queued[p] = 1;
          queue.push(p);
        }
      }
    };
    let improved = false;
    for (let c = 0; c < k && !improved; c++) {
      const b = near[a * k + c];
      const i = pos[a];
      const j = pos[b];
      // Successor move: edges (a, a+) and (b, b+) become (a, b) and (a+, b+).
      // At the path's end a missing successor is free to drop.
      {
        const lo = Math.min(i, j);
        const hi = Math.max(i, j);
        const p = order[lo];
        const q = order[lo + 1];
        const r = order[hi];
        const s = hi + 1 < n ? order[hi + 1] : -1;
        const gain = d(p, q) + (s >= 0 ? d(r, s) : 0) - d(p, r) - (s >= 0 ? d(q, s) : 0);
        if (hi > lo + 1 && gain > 1e-9) {
          reverse(lo + 1, hi);
          touch(p, q, r, s);
          improved = true;
          continue;
        }
      }
      // Predecessor move: edges (a-, a) and (b-, b) become (a-, b-) and (a, b).
      {
        const lo = Math.min(i, j);
        const hi = Math.max(i, j);
        const p = lo > 0 ? order[lo - 1] : -1;
        const q = order[lo];
        const r = order[hi - 1];
        const s = order[hi];
        const gain = (p >= 0 ? d(p, q) : 0) + d(r, s) - (p >= 0 ? d(p, r) : 0) - d(q, s);
        if (hi > lo + 1 && gain > 1e-9) {
          reverse(lo, hi - 1);
          touch(p, q, r, s);
          improved = true;
        }
      }
    }
    if (improved) touch(a);
  }
  return false;
}

/** One continuous path through every stipple: nearest-neighbour tour, then 2-opt until `deadline`. */
export function tspPath(points: Point[], deadline = Infinity): { path: Polyline; timedOut: boolean } {
  const order = nearestNeighbourTour(points);
  const timedOut = twoOptTour(points, order, deadline);
  return { path: Array.from(order, (p) => points[p]), timedOut };
}
