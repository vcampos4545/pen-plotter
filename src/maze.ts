import type { Point, Polyline, Rect } from './geometry';
import { rng } from './stipple';

// Perfect grid mazes (exactly one path between any two cells) by the
// recursive backtracker, which gives long winding corridors. Walls are merged
// into maximal straight runs and the runs chained end to end, so the pen lifts
// as rarely as the wall layout allows.

/** Open sides of a cell. */
export const N = 1;
export const E = 2;
export const S = 4;
export const W = 8;

export interface Maze {
  cols: number;
  rows: number;
  /** Open sides per cell (N | E | S | W bits), row-major. Entrance: top of cell 0; exit: bottom of the last cell. */
  open: Uint8Array;
}

const STEPS: Array<[number, number, number, number]> = [
  [N, 0, -1, S],
  [E, 1, 0, W],
  [S, 0, 1, N],
  [W, -1, 0, E],
];

export function generateMaze(cols: number, rows: number, seed: number): Maze {
  const rand = rng(seed);
  const open = new Uint8Array(cols * rows);
  const seen = new Uint8Array(cols * rows);
  const stack = [Math.floor(rand() * cols * rows)];
  seen[stack[0]] = 1;
  while (stack.length) {
    const c = stack[stack.length - 1];
    const x = c % cols;
    const y = (c - x) / cols;
    const options = STEPS.filter(([, dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      return nx >= 0 && nx < cols && ny >= 0 && ny < rows && !seen[ny * cols + nx];
    });
    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const [side, dx, dy, back] = options[Math.floor(rand() * options.length)];
    const n = (y + dy) * cols + x + dx;
    open[c] |= side;
    open[n] |= back;
    seen[n] = 1;
    stack.push(n);
  }
  open[0] |= N;
  open[cols * rows - 1] |= S;
  return { cols, rows, open };
}

/** Cells from the entrance (top left) to the exit (bottom right), in order. */
export function solveMaze(m: Maze): number[] {
  const { cols, rows, open } = m;
  const from = new Int32Array(cols * rows).fill(-1);
  const goal = cols * rows - 1;
  from[0] = 0;
  const queue = [0];
  for (let q = 0; q < queue.length && from[goal] === -1; q++) {
    const c = queue[q];
    const x = c % cols;
    const y = (c - x) / cols;
    for (const [side, dx, dy] of STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!(open[c] & side) || nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const n = ny * cols + nx;
      if (from[n] !== -1) continue;
      from[n] = c;
      queue.push(n);
    }
  }
  if (from[goal] === -1) return [];
  const path = [goal];
  while (path[path.length - 1] !== 0) path.push(from[path[path.length - 1]]);
  return path.reverse();
}

export interface MazeLayout {
  cols: number;
  rows: number;
  /** Top-left corner of the maze, paper mm. */
  x: number;
  y: number;
  cell: number;
}

/** As many whole cells of `cell` mm as fit in `area`, centred. */
export function mazeLayout(area: Rect, cell: number): MazeLayout {
  const aw = area.maxX - area.minX;
  const ah = area.maxY - area.minY;
  const cols = Math.max(1, Math.floor(aw / cell + 1e-9));
  const rows = Math.max(1, Math.floor(ah / cell + 1e-9));
  return { cols, rows, cell, x: area.minX + (aw - cols * cell) / 2, y: area.minY + (ah - rows * cell) / 2 };
}

/** Lattice corner (i, j) to paper mm. */
const corner = (l: MazeLayout, i: number, j: number): Point => ({ x: l.x + i * l.cell, y: l.y + j * l.cell });

/**
 * Every wall as polylines in paper mm: straight runs merged, then runs that
 * meet chained into one line where possible.
 */
export function mazeWalls(m: Maze, l: MazeLayout): Polyline[] {
  const { cols, rows, open } = m;
  // Runs between lattice corners; corner id = j * (cols + 1) + i.
  const id = (i: number, j: number) => j * (cols + 1) + i;
  const runs: Array<[number, number]> = [];
  for (let j = 0; j <= rows; j++) {
    let start = -1;
    for (let i = 0; i <= cols; i++) {
      // Wall along the top of cell (i, j), which is the bottom of (i, j - 1).
      const wall = i < cols && (j < rows ? !(open[j * cols + i] & N) : !(open[(j - 1) * cols + i] & S));
      if (wall && start < 0) start = i;
      if (!wall && start >= 0) {
        runs.push([id(start, j), id(i, j)]);
        start = -1;
      }
    }
  }
  for (let i = 0; i <= cols; i++) {
    let start = -1;
    for (let j = 0; j <= rows; j++) {
      // Wall along the left of cell (i, j), which is the right of (i - 1, j).
      const wall = j < rows && (i < cols ? !(open[j * cols + i] & W) : !(open[j * cols + i - 1] & E));
      if (wall && start < 0) start = j;
      if (!wall && start >= 0) {
        runs.push([id(i, start), id(i, j)]);
        start = -1;
      }
    }
  }

  // Chain runs into trails. Starting at odd-degree corners first leaves the
  // fewest loose ends, like an Euler path split at the unavoidable breaks.
  const adj = new Map<number, number[]>();
  runs.forEach(([a, b], r) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(r);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(r);
  });
  const used = new Uint8Array(runs.length);
  const free = (v: number) => (adj.get(v) ?? []).some((r) => !used[r]);
  const trail = (v: number): number[] => {
    const out = [v];
    for (;;) {
      const r = (adj.get(v) ?? []).find((e) => !used[e]);
      if (r === undefined) return out;
      used[r] = 1;
      v = runs[r][0] === v ? runs[r][1] : runs[r][0];
      out.push(v);
    }
  };
  const starts = [...adj.keys()].sort((a, b) => (adj.get(b)!.length % 2) - (adj.get(a)!.length % 2) || a - b);
  const lines: Polyline[] = [];
  for (const v of starts) {
    while (free(v)) {
      const t = trail(v);
      lines.push(t.map((c) => corner(l, c % (cols + 1), Math.floor(c / (cols + 1)))));
    }
  }
  return lines;
}

/** The solution through cell centres, from the gap in the top wall to the gap in the bottom wall, with straight runs merged. */
export function mazeSolution(m: Maze, l: MazeLayout): Polyline {
  const path = solveMaze(m);
  if (path.length === 0) return [];
  const centre = (c: number): Point => {
    const x = c % m.cols;
    return { x: l.x + (x + 0.5) * l.cell, y: l.y + ((c - x) / m.cols + 0.5) * l.cell };
  };
  const pts = [{ x: l.x + 0.5 * l.cell, y: l.y }, ...path.map(centre)];
  const end = centre(m.cols * m.rows - 1);
  pts.push({ x: end.x, y: end.y + 0.5 * l.cell });
  const out: Polyline = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    // Keep only the corners.
    if (Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) > 1e-9) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
