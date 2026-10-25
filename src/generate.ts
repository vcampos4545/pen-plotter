import { lorenz, mapCurve, randomMapParams, type LorenzOptions, type MapKind, type MapOptions } from './attractor';
import { harmonograph, spirograph, spirographLoops, type HarmonographOptions, type SpirographOptions } from './curves';
import { flowField, type FlowOptions } from './flowfield';
import { clampPoint, type Polyline, type Rect } from './geometry';
import { generateMaze, mazeLayout, mazeSolution, mazeWalls } from './maze';
import { dedupe, simplifyRDP } from './simplify';
import { orderLines } from './stipple';

// Math art: spirographs, harmonographs, strange attractors, flow fields and
// mazes, as pen strokes in paper mm inside the drawable area.

export type GenStyle = 'spirograph' | 'harmonograph' | 'lorenz' | 'clifford' | 'dejong' | 'flow' | 'maze';
export const GEN_STYLES: GenStyle[] = ['spirograph', 'harmonograph', 'lorenz', 'clifford', 'dejong', 'flow', 'maze'];

export interface MazeOptions {
  seed: number;
  /** Corridor width, mm. */
  cell: number;
  /** Also draw the path from entrance to exit, as its own stroke. */
  solution: boolean;
}

export interface GenerateOptions {
  style: GenStyle;
  /** Share of the drawable area to use, percent. The drawing is centred in it. */
  size: number;
  spirograph: SpirographOptions;
  harmonograph: HarmonographOptions;
  lorenz: LorenzOptions;
  clifford: MapOptions;
  dejong: MapOptions;
  flow: FlowOptions;
  maze: MazeOptions;
}

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  style: 'spirograph',
  size: 100,
  spirograph: { ring: 96, wheel: 52, pen: 0.8, outside: false },
  harmonograph: { freqX: 3, freqY: 2, phaseX: 0, phaseY: 90, freqR: 1.003, rotary: 0.4, damping: 0.03, duration: 60 },
  lorenz: { sigma: 10, rho: 28, beta: 8 / 3, steps: 10_000, yaw: 0, pitch: 0 },
  clifford: { a: -1.4, b: 1.6, c: 1.0, d: 0.7, density: 30 },
  dejong: { a: 1.4, b: -2.3, c: 2.4, d: -2.1, density: 30 },
  flow: { seed: 1, scale: 120, curl: 1, spacing: 4, step: 0.5, maxLength: 400, minLength: 8 },
  maze: { seed: 1, cell: 8, solution: false },
};

/** Line simplification after fitting, mm. Well under a pen width. */
const SIMPLIFY = 0.03;
/** Seeds are whole numbers in this range. */
export const MAX_SEED = 999_999;

const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const int = (v: unknown, fallback: number, min: number, max: number) => Math.round(num(v, fallback, min, max));
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

/** Fill gaps from the defaults and clamp every number to a usable range. */
export function sanitizeGenerateOptions(raw: unknown): GenerateOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_GENERATE_OPTIONS;
  const part = (k: keyof GenerateOptions) => (o[k] && typeof o[k] === 'object' ? (o[k] as Record<string, unknown>) : {});
  const sp = part('spirograph');
  const h = part('harmonograph');
  const lz = part('lorenz');
  const fl = part('flow');
  const mz = part('maze');
  const ring = int(sp.ring, d.spirograph.ring, 3, 400);
  const outside = bool(sp.outside, d.spirograph.outside);
  const map = (m: Record<string, unknown>, def: MapOptions): MapOptions => ({
    a: num(m.a, def.a, -5, 5),
    b: num(m.b, def.b, -5, 5),
    c: num(m.c, def.c, -5, 5),
    d: num(m.d, def.d, -5, 5),
    density: num(m.density, def.density, 1, 200),
  });
  const flowStep = num(fl.step, d.flow.step, 0.1, 5);
  return {
    style: GEN_STYLES.includes(o.style as GenStyle) ? (o.style as GenStyle) : d.style,
    size: num(o.size, d.size, 10, 100),
    spirograph: {
      ring,
      // Inside the ring the wheel must be smaller, or there is nothing to roll.
      wheel: int(sp.wheel, d.spirograph.wheel, 1, outside ? 400 : ring - 1),
      pen: num(sp.pen, d.spirograph.pen, 0, 3),
      outside,
    },
    harmonograph: {
      freqX: num(h.freqX, d.harmonograph.freqX, 0, 20),
      freqY: num(h.freqY, d.harmonograph.freqY, 0, 20),
      phaseX: num(h.phaseX, d.harmonograph.phaseX, -360, 360),
      phaseY: num(h.phaseY, d.harmonograph.phaseY, -360, 360),
      freqR: num(h.freqR, d.harmonograph.freqR, 0, 20),
      rotary: num(h.rotary, d.harmonograph.rotary, 0, 1),
      damping: num(h.damping, d.harmonograph.damping, 0, 0.5),
      duration: num(h.duration, d.harmonograph.duration, 1, 1000),
    },
    lorenz: {
      sigma: num(lz.sigma, d.lorenz.sigma, 0.1, 50),
      rho: num(lz.rho, d.lorenz.rho, 0.1, 100),
      beta: num(lz.beta, d.lorenz.beta, 0.1, 20),
      steps: int(lz.steps, d.lorenz.steps, 100, 200_000),
      yaw: num(lz.yaw, d.lorenz.yaw, -360, 360),
      pitch: num(lz.pitch, d.lorenz.pitch, -90, 90),
    },
    clifford: map(part('clifford'), d.clifford),
    dejong: map(part('dejong'), d.dejong),
    flow: {
      seed: int(fl.seed, d.flow.seed, 0, MAX_SEED),
      scale: num(fl.scale, d.flow.scale, 5, 2000),
      curl: num(fl.curl, d.flow.curl, 0, 10),
      spacing: num(fl.spacing, d.flow.spacing, 0.5, 50),
      step: flowStep,
      maxLength: num(fl.maxLength, d.flow.maxLength, 1, 10_000),
      minLength: num(fl.minLength, d.flow.minLength, 0, 1000),
    },
    maze: {
      seed: int(mz.seed, d.maze.seed, 0, MAX_SEED),
      cell: num(mz.cell, d.maze.cell, 1, 100),
      solution: bool(mz.solution, d.maze.solution),
    },
  };
}

/** `area` shrunk about its centre to `size` percent of each side. */
export function sizedArea(area: Rect, size: number): Rect {
  const k = (1 - size / 100) / 2;
  const dx = (area.maxX - area.minX) * k;
  const dy = (area.maxY - area.minY) * k;
  return { minX: area.minX + dx, minY: area.minY + dy, maxX: area.maxX - dx, maxY: area.maxY - dy };
}

/**
 * Scale lines drawn with y up uniformly so their bounding box just fits
 * `area`, centred, and flip them to paper's y down.
 */
export function fitLines(lines: Polyline[], area: Rect): Polyline[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of lines) {
    for (const p of l) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) return [];
  const aw = area.maxX - area.minX;
  const ah = area.maxY - area.minY;
  const w = maxX - minX;
  const h = maxY - minY;
  const scale = Math.min(w > 0 ? aw / w : Infinity, h > 0 ? ah / h : Infinity);
  if (!Number.isFinite(scale)) return [];
  const ox = area.minX + (aw - w * scale) / 2;
  const oy = area.minY + (ah - h * scale) / 2;
  return lines.map((l) => l.map((p) => ({ x: ox + (p.x - minX) * scale, y: oy + (maxY - p.y) * scale })));
}

/** Simplify, round to 0.01 mm (keeps saved drawings small) and keep inside the area. */
function finish(lines: Polyline[], area: Rect): Polyline[] {
  const r = (n: number) => Math.round(n * 100) / 100;
  return lines
    .map((l) => dedupe(simplifyRDP(l, SIMPLIFY).map((p) => clampPoint({ x: r(p.x), y: r(p.y) }, area))))
    .filter((l) => l.length >= 2);
}

export interface GenerateResult {
  lines: Polyline[];
  /** Things worth telling the user about this result, e.g. a cap that was hit. */
  notes: string[];
}

export function buildGenerate(area: Rect, o: GenerateOptions): GenerateResult {
  const box = sizedArea(area, o.size);
  const notes: string[] = [];
  let lines: Polyline[];
  switch (o.style) {
    case 'spirograph': {
      const loops = spirographLoops(o.spirograph);
      notes.push(`Closes after ${loops} trip${loops === 1 ? '' : 's'} around the ring.`);
      lines = fitLines([spirograph(o.spirograph)], box);
      break;
    }
    case 'harmonograph':
      lines = fitLines([harmonograph(o.harmonograph)], box);
      break;
    case 'lorenz':
      lines = fitLines([lorenz(o.lorenz)], box);
      break;
    case 'clifford':
    case 'dejong': {
      const curve = mapCurve(o.style, o[o.style]);
      if (!curve.chaotic) notes.push('These parameters settle into a few points or a short cycle, not a strange attractor. Try a preset or Randomize.');
      else if (curve.density < o[o.style].density * 0.95) notes.push(`Stopped at density ${curve.density.toFixed(0)}: the line hit the point limit.`);
      lines = fitLines([curve.line], box);
      break;
    }
    case 'flow':
      lines = orderLines(flowField(box, o.flow), { x: box.minX, y: box.minY });
      break;
    case 'maze': {
      const layout = mazeLayout(box, o.maze.cell);
      if (layout.cols < 2 || layout.rows < 2) {
        notes.push('The cells are too big to fit a maze. Make the corridors narrower.');
        lines = [];
        break;
      }
      const maze = generateMaze(layout.cols, layout.rows, o.maze.seed);
      notes.push(`${layout.cols} × ${layout.rows} cells. Enter at the top left, leave at the bottom right.`);
      lines = orderLines(mazeWalls(maze, layout), { x: box.minX, y: box.minY });
      if (o.maze.solution) lines.push(mazeSolution(maze, layout));
      break;
    }
  }
  return { lines: finish(lines, area), notes };
}

/** New random parameters for the current style: a fresh seed, or a new curve. */
export function randomizeOptions(o: GenerateOptions, rand: () => number): GenerateOptions {
  const pick = (min: number, max: number) => min + rand() * (max - min);
  const whole = (min: number, max: number) => Math.floor(pick(min, max + 1));
  const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
  const next = structuredClone(o);
  switch (o.style) {
    case 'spirograph': {
      // Up to 30 trips around the ring: more just fills in to a solid disc.
      for (let tries = 0; tries < 100; tries++) {
        const outside = rand() < 0.3;
        const ring = whole(40, 150);
        const wheel = whole(8, outside ? 80 : ring - 8);
        if (spirographLoops({ ring, wheel }) > 30) continue;
        next.spirograph = { ring, wheel, pen: round(pick(0.3, 1.3), 2), outside };
        break;
      }
      break;
    }
    case 'harmonograph': {
      const detune = () => round(pick(-0.01, 0.01), 3);
      next.harmonograph = {
        ...o.harmonograph,
        freqX: whole(1, 4) + detune(),
        freqY: whole(1, 4) + detune(),
        phaseX: whole(0, 359),
        phaseY: whole(0, 359),
        freqR: whole(1, 3) + detune(),
        rotary: round(pick(0, 0.8), 2),
      };
      break;
    }
    case 'lorenz':
      next.lorenz = { ...o.lorenz, yaw: whole(0, 359), pitch: whole(-60, 60) };
      break;
    case 'clifford':
    case 'dejong':
      next[o.style] = { ...randomMapParams(o.style as MapKind, rand), density: o[o.style].density };
      break;
    case 'flow':
      next.flow = { ...o.flow, seed: whole(0, MAX_SEED) };
      break;
    case 'maze':
      next.maze = { ...o.maze, seed: whole(0, MAX_SEED) };
      break;
  }
  return next;
}
