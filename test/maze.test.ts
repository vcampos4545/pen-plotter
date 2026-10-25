import { describe, expect, it } from 'vitest';
import { insideRect } from '../src/geometry';
import { E, generateMaze, mazeLayout, mazeSolution, mazeWalls, N, S, solveMaze, W, type Maze } from '../src/maze';

/** Open passages between neighbouring cells, each counted once. */
function passages(m: Maze): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let c = 0; c < m.cols * m.rows; c++) {
    const x = c % m.cols;
    const y = Math.floor(c / m.cols);
    if (m.open[c] & E && x + 1 < m.cols) out.push([c, c + 1]);
    if (m.open[c] & S && y + 1 < m.rows) out.push([c, c + m.cols]);
  }
  return out;
}

describe('generateMaze', () => {
  const m = generateMaze(23, 17, 7);

  it('is deterministic for a seed', () => {
    expect(generateMaze(23, 17, 7)).toEqual(m);
    expect(generateMaze(23, 17, 8).open).not.toEqual(m.open);
  });

  it('opens sides in matching pairs', () => {
    for (let c = 0; c < m.cols * m.rows; c++) {
      const x = c % m.cols;
      const y = Math.floor(c / m.cols);
      if (x + 1 < m.cols) expect(!!(m.open[c] & E)).toBe(!!(m.open[c + 1] & W));
      if (y + 1 < m.rows) expect(!!(m.open[c] & S)).toBe(!!(m.open[c + m.cols] & N));
      // Outer walls are closed except the entrance and exit.
      if (x === 0) expect(m.open[c] & W).toBe(0);
      if (x === m.cols - 1) expect(m.open[c] & E).toBe(0);
      if (y === 0 && c !== 0) expect(m.open[c] & N).toBe(0);
      if (y === m.rows - 1 && c !== m.cols * m.rows - 1) expect(m.open[c] & S).toBe(0);
    }
    expect(m.open[0] & N).toBe(N);
    expect(m.open[m.cols * m.rows - 1] & S).toBe(S);
  });

  it('is perfect: every cell reachable and exactly one route between any two', () => {
    const edges = passages(m);
    const cells = m.cols * m.rows;
    // A connected graph with cells - 1 edges is a tree: one path between any two cells.
    expect(edges.length).toBe(cells - 1);
    const parent = Array.from({ length: cells }, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const [a, b] of edges) {
      expect(find(a)).not.toBe(find(b)); // no loops
      parent[find(a)] = find(b);
    }
    const root = find(0);
    for (let c = 0; c < cells; c++) expect(find(c)).toBe(root);
  });

  it('solves from entrance to exit through open passages', () => {
    const path = solveMaze(m);
    expect(path[0]).toBe(0);
    expect(path[path.length - 1]).toBe(m.cols * m.rows - 1);
    expect(new Set(path).size).toBe(path.length);
    const open = new Set(passages(m).map(([a, b]) => `${a},${b}`));
    for (let i = 1; i < path.length; i++) {
      const [a, b] = [Math.min(path[i - 1], path[i]), Math.max(path[i - 1], path[i])];
      expect(open.has(`${a},${b}`)).toBe(true);
    }
  });
});

describe('maze drawing', () => {
  const area = { minX: 10, minY: 10, maxX: 190, maxY: 140 };
  const layout = mazeLayout(area, 7);
  const m = generateMaze(layout.cols, layout.rows, 11);
  const walls = mazeWalls(m, layout);

  it('fits whole cells in the area, centred', () => {
    expect(layout.cols).toBe(25);
    expect(layout.rows).toBe(18);
    expect(layout.x).toBeCloseTo(10 + (180 - 175) / 2);
    expect(layout.y).toBeCloseTo(10 + (130 - 126) / 2);
  });

  /** Unit wall edges "i,j,h|v" covered by the drawn lines. */
  function drawnEdges(): Set<string> {
    const set = new Set<string>();
    for (const l of walls) {
      for (let k = 1; k < l.length; k++) {
        const [a, b] = [l[k - 1], l[k]];
        const i0 = Math.round((Math.min(a.x, b.x) - layout.x) / layout.cell);
        const j0 = Math.round((Math.min(a.y, b.y) - layout.y) / layout.cell);
        const i1 = Math.round((Math.max(a.x, b.x) - layout.x) / layout.cell);
        const j1 = Math.round((Math.max(a.y, b.y) - layout.y) / layout.cell);
        // Every piece is axis-aligned on the lattice.
        expect(i0 === i1 || j0 === j1).toBe(true);
        for (let i = i0; i < i1; i++) {
          const key = `${i},${j0},h`;
          expect(set.has(key)).toBe(false); // never drawn twice
          set.add(key);
        }
        for (let j = j0; j < j1; j++) {
          const key = `${i0},${j},v`;
          expect(set.has(key)).toBe(false);
          set.add(key);
        }
      }
    }
    return set;
  }

  it('draws exactly the closed walls, each once', () => {
    const drawn = drawnEdges();
    const expected = new Set<string>();
    for (let j = 0; j <= m.rows; j++) {
      for (let i = 0; i < m.cols; i++) {
        const closed = j < m.rows ? !(m.open[j * m.cols + i] & N) : !(m.open[(j - 1) * m.cols + i] & S);
        if (closed) expected.add(`${i},${j},h`);
      }
    }
    for (let i = 0; i <= m.cols; i++) {
      for (let j = 0; j < m.rows; j++) {
        const closed = i < m.cols ? !(m.open[j * m.cols + i] & W) : !(m.open[j * m.cols + i - 1] & E);
        if (closed) expected.add(`${i},${j},v`);
      }
    }
    expect([...drawn].sort()).toEqual([...expected].sort());
  });

  it('merges walls into far fewer lines than wall pieces', () => {
    const pieces = drawnEdges().size;
    expect(walls.length).toBeLessThan(pieces / 3);
    for (const l of walls) for (const p of l) expect(insideRect(p, area)).toBe(true);
  });

  it('draws the solution from the entrance gap to the exit gap', () => {
    const sol = mazeSolution(m, layout);
    expect(sol[0]).toEqual({ x: layout.x + layout.cell / 2, y: layout.y });
    expect(sol[sol.length - 1].y).toBeCloseTo(layout.y + layout.rows * layout.cell);
    for (const p of sol) expect(insideRect(p, area)).toBe(true);
    // Corners only: no three points in a row on one line.
    for (let i = 2; i < sol.length; i++) {
      const [a, b, c] = [sol[i - 2], sol[i - 1], sol[i]];
      expect(Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x))).toBeGreaterThan(1e-9);
    }
  });
});
