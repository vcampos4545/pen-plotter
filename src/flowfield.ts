import type { Point, Polyline, Rect } from './geometry';
import { fractal2 } from './noise';
import { rng } from './stipple';

// Evenly spaced streamlines through a noise flow field (after Jobard and
// Lefer, 1997). Each line is traced both ways from a seed and stops at the
// edge, at its maximum length, or when it comes within half the spacing of
// another line (or of itself). New seeds are tried one spacing to either side
// of every finished line, then on a shuffled grid to fill any holes left.
// Coordinates are paper mm.

export interface FlowOptions {
  seed: number;
  /** Size of the swirls: distance over which the direction changes a lot, mm. */
  scale: number;
  /** How far the direction turns over the noise range, in half turns. Higher curls more. */
  curl: number;
  /** Gap between neighbouring lines, mm. */
  spacing: number;
  /** Integration step, mm. */
  step: number;
  /** Longest line, mm. */
  maxLength: number;
  /** Lines shorter than this are not drawn, mm. */
  minLength: number;
}

/** Lines stop when this fraction of `spacing` from another line. */
export const FLOW_STOP = 0.5;

/** Direction of the field at a point, radians. */
export function flowAngle(o: Pick<FlowOptions, 'seed' | 'scale' | 'curl'>): (x: number, y: number) => number {
  const noise = fractal2(o.seed, 2);
  return (x, y) => noise(x / o.scale, y / o.scale) * Math.PI * o.curl;
}

/** Uniform grid of accepted line points, for "is anything within r" queries with r ≤ cell. */
class Occupancy {
  /** Sparse, since a line's own grid holds only that line. */
  private readonly cells = new Map<number, Array<{ x: number; y: number; line: number; index: number }>>();
  private readonly area: Rect;
  private readonly cell: number;
  private readonly cols: number;
  private readonly rows: number;

  constructor(area: Rect, cell: number) {
    this.area = area;
    this.cell = cell;
    this.cols = Math.max(1, Math.ceil((area.maxX - area.minX) / cell));
    this.rows = Math.max(1, Math.ceil((area.maxY - area.minY) / cell));
  }

  private key(x: number, y: number): [number, number] {
    const i = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.area.minX) / this.cell)));
    const j = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.area.minY) / this.cell)));
    return [i, j];
  }

  add(p: Point, line: number, index: number): void {
    const [i, j] = this.key(p.x, p.y);
    const k = j * this.cols + i;
    const list = this.cells.get(k);
    if (list) list.push({ x: p.x, y: p.y, line, index });
    else this.cells.set(k, [{ x: p.x, y: p.y, line, index }]);
  }

  /**
   * True when a point closer than r exists, ignoring points of `line` whose
   * index is within `skip` of `index` (the line's own recent points).
   */
  near(p: Point, r: number, line = -1, index = 0, skip = 0): boolean {
    const [ci, cj] = this.key(p.x, p.y);
    const r2 = r * r;
    for (let j = Math.max(0, cj - 1); j <= Math.min(this.rows - 1, cj + 1); j++) {
      for (let i = Math.max(0, ci - 1); i <= Math.min(this.cols - 1, ci + 1); i++) {
        for (const q of this.cells.get(j * this.cols + i) ?? []) {
          if (q.line === line && Math.abs(q.index - index) <= skip) continue;
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          if (dx * dx + dy * dy < r2) return true;
        }
      }
    }
    return false;
  }
}

const inside = (p: Point, r: Rect) => p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;

export function flowField(area: Rect, o: FlowOptions): Polyline[] {
  const angle = flowAngle(o);
  const sep = o.spacing;
  const stop = sep * FLOW_STOP;
  const h = Math.min(o.step, stop);
  const grid = new Occupancy(area, sep);
  const maxSteps = Math.ceil(o.maxLength / h);
  // A line may not come back within `stop` of itself, except for the points
  // just behind the pen, which are always that close.
  const skip = Math.ceil(stop / h) + 2;

  /** Midpoint (RK2) step along the field, forwards or backwards. */
  const advance = (p: Point, dir: number): Point => {
    const a = angle(p.x, p.y);
    const mx = p.x + Math.cos(a) * h * 0.5 * dir;
    const my = p.y + Math.sin(a) * h * 0.5 * dir;
    const b = angle(mx, my);
    return { x: p.x + Math.cos(b) * h * dir, y: p.y + Math.sin(b) * h * dir };
  };

  const trace = (seed: Point, id: number): Polyline => {
    // Own points so far, indexed along the line (backwards half negative).
    const own = new Occupancy(area, sep);
    own.add(seed, id, 0);
    const halves: Polyline[] = [];
    let steps = 0;
    for (const dir of [1, -1]) {
      const half: Polyline = [];
      let p = seed;
      for (let k = 1; steps < maxSteps; k++, steps++) {
        const q = advance(p, dir);
        const index = dir * k;
        if (!inside(q, area) || grid.near(q, stop) || own.near(q, stop, id, index, skip)) break;
        own.add(q, id, index);
        half.push(q);
        p = q;
      }
      halves.push(half);
    }
    return [...halves[1].reverse(), seed, ...halves[0]];
  };

  const lines: Polyline[] = [];
  const length = (l: Polyline) => (l.length - 1) * h;
  const tryAt = (p: Point): Polyline | undefined => {
    if (!inside(p, area) || grid.near(p, sep)) return undefined;
    const line = trace(p, lines.length);
    if (length(line) < Math.max(o.minLength, h)) return undefined;
    line.forEach((q, i) => grid.add(q, lines.length, i));
    lines.push(line);
    return line;
  };

  // Seeds along finished lines first: that is what spaces the lines evenly.
  const fromLines = (start: number) => {
    for (let n = start; n < lines.length; n++) {
      const line = lines[n];
      for (let i = 0; i < line.length; i++) {
        const a = line[Math.max(0, i - 1)];
        const b = line[Math.min(line.length - 1, i + 1)];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const nx = (-(b.y - a.y) / len) * sep;
        const ny = ((b.x - a.x) / len) * sep;
        tryAt({ x: line[i].x + nx, y: line[i].y + ny });
        tryAt({ x: line[i].x - nx, y: line[i].y - ny });
      }
    }
  };

  // Then a jittered grid in seeded random order, to start lines in regions the
  // first lines never reached (and to start the first line at all).
  const rand = rng(o.seed);
  const cols = Math.max(1, Math.floor((area.maxX - area.minX) / sep));
  const rows = Math.max(1, Math.floor((area.maxY - area.minY) / sep));
  const candidates: Point[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      candidates.push({ x: area.minX + (i + rand()) * sep, y: area.minY + (j + rand()) * sep });
    }
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const k = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[k]] = [candidates[k], candidates[i]];
  }
  for (const c of candidates) {
    const before = lines.length;
    if (tryAt(c)) fromLines(before);
  }
  return lines;
}
