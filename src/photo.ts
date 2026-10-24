import { detectEdges, traceEdges } from './edges';
import { estimateSeconds } from './gcode';
import { clampPoint, dist, polylineLength, type Polyline, type Rect } from './geometry';
import { hatch, spiral, squiggle, type HatchOptions, type SpiralOptions, type SquiggleOptions } from './photo-styles';
import type { Settings } from './settings';
import { dedupe, simplifyRDP } from './simplify';
import { orderLines, stipple, tspPath } from './stipple';
import { adjustTone, DEFAULT_TONE, gridToPlace, type Placement, type ToneGrid, type ToneOptions } from './tone';
import { fitToArea } from './topo';

// Photo -> pen strokes in paper mm, inside the drawable area. The image is
// decoded and cropped by the dialog; everything from luminance on is here.

export type PhotoStyle = 'squiggle' | 'spiral' | 'hatch' | 'outline' | 'tsp';
export const PHOTO_STYLES: PhotoStyle[] = ['squiggle', 'spiral', 'hatch', 'outline', 'tsp'];

/** 'fill' crops the photo to the drawable area's shape; 'fit' shows all of it, centred. */
export type PhotoFit = 'fill' | 'fit';

export interface OutlineOptions {
  /** Blur passes before edge detection. */
  blur: number;
  /** 0.05..1, fraction of the strong-edge level an edge must reach. */
  threshold: number;
  /** Edges shorter than this on the paper are dropped, mm. */
  minLength: number;
}

export interface TspOptions {
  /** Number of stipples the path visits. */
  points: number;
  /** Budget for stippling plus tour improvement, seconds. */
  timeLimit: number;
}

export interface PhotoOptions {
  style: PhotoStyle;
  fit: PhotoFit;
  tone: ToneOptions;
  squiggle: SquiggleOptions;
  spiral: SpiralOptions;
  hatch: HatchOptions;
  outline: OutlineOptions;
  tsp: TspOptions;
}

export const DEFAULT_PHOTO_OPTIONS: PhotoOptions = {
  style: 'squiggle',
  fit: 'fill',
  tone: { ...DEFAULT_TONE },
  squiggle: { lines: 80, amplitude: 0.6, frequency: 0.6 },
  spiral: { spacing: 2.5, amplitude: 0.6, frequency: 0.5 },
  hatch: { spacing: 1.5, angle: 45, layers: 3 },
  outline: { blur: 2, threshold: 0.35, minLength: 4 },
  tsp: { points: 4000, timeLimit: 3 },
};

/** Longest side of the processing grid, pixels. Finer than a 0.6 mm pen on a 400 mm sheet. */
export const MAX_GRID = 640;

/** Point counts above this make the drawing too big to autosave in browser storage. */
export const STORAGE_POINT_LIMIT = 200_000;
/** Stroke counts above this make planning (and Send) noticeably slow. */
export const PLANNER_STROKE_LIMIT = 8000;

const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const int = (v: unknown, fallback: number, min: number, max: number) => Math.round(num(v, fallback, min, max));

/** Fill gaps from the defaults and clamp every number to a usable range. */
export function sanitizePhotoOptions(raw: unknown): PhotoOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PHOTO_OPTIONS;
  const part = (k: keyof PhotoOptions) => (o[k] && typeof o[k] === 'object' ? (o[k] as Record<string, unknown>) : {});
  const t = part('tone');
  const sq = part('squiggle');
  const sp = part('spiral');
  const h = part('hatch');
  const ol = part('outline');
  const ts = part('tsp');
  return {
    style: PHOTO_STYLES.includes(o.style as PhotoStyle) ? (o.style as PhotoStyle) : d.style,
    fit: o.fit === 'fit' ? 'fit' : 'fill',
    tone: {
      brightness: num(t.brightness, d.tone.brightness, -100, 100),
      contrast: num(t.contrast, d.tone.contrast, -100, 95),
      gamma: num(t.gamma, d.tone.gamma, 0.2, 5),
      invert: t.invert === true,
    },
    squiggle: {
      lines: int(sq.lines, d.squiggle.lines, 1, 1000),
      amplitude: num(sq.amplitude, d.squiggle.amplitude, 0, 2),
      frequency: num(sq.frequency, d.squiggle.frequency, 0.05, 5),
    },
    spiral: {
      spacing: num(sp.spacing, d.spiral.spacing, 0.3, 50),
      amplitude: num(sp.amplitude, d.spiral.amplitude, 0, 2),
      frequency: num(sp.frequency, d.spiral.frequency, 0.05, 5),
    },
    hatch: {
      spacing: num(h.spacing, d.hatch.spacing, 0.3, 50),
      angle: num(h.angle, d.hatch.angle, -180, 180),
      layers: int(h.layers, d.hatch.layers, 1, 4),
    },
    outline: {
      blur: int(ol.blur, d.outline.blur, 0, 20),
      threshold: num(ol.threshold, d.outline.threshold, 0.05, 1),
      minLength: num(ol.minLength, d.outline.minLength, 0, 1000),
    },
    tsp: {
      points: int(ts.points, d.tsp.points, 10, 50_000),
      timeLimit: num(ts.timeLimit, d.tsp.timeLimit, 0.5, 60),
    },
  };
}

export interface Frame {
  /** Part of the source image to use, source pixels. */
  source: { x: number; y: number; width: number; height: number };
  /** Where it lands on the paper, mm. */
  place: Placement;
  /** Processing grid size, at most MAX_GRID on the longer side. */
  gridWidth: number;
  gridHeight: number;
}

/**
 * Crop and place an image of `imgW` × `imgH` pixels. 'fill' takes the largest
 * centred crop with the drawable area's shape; 'fit' keeps the whole image and
 * fits it inside the area.
 */
export function framePhoto(imgW: number, imgH: number, area: Rect, fit: PhotoFit, maxGrid = MAX_GRID): Frame {
  const aw = area.maxX - area.minX;
  const ah = area.maxY - area.minY;
  let source = { x: 0, y: 0, width: imgW, height: imgH };
  let place: Placement;
  if (fit === 'fill') {
    const aspect = aw / ah;
    if (imgW / imgH > aspect) {
      const width = imgH * aspect;
      source = { x: (imgW - width) / 2, y: 0, width, height: imgH };
    } else {
      const height = imgW / aspect;
      source = { x: 0, y: (imgH - height) / 2, width: imgW, height };
    }
    place = { x: area.minX, y: area.minY, width: aw, height: ah };
  } else {
    place = fitToArea({ width: imgW, height: imgH }, area);
  }
  // Never upsample past the source; never go below a couple of pixels.
  const scale = Math.min(1, maxGrid / Math.max(source.width, source.height));
  return {
    source,
    place,
    gridWidth: Math.max(2, Math.round(source.width * scale)),
    gridHeight: Math.max(2, Math.round(source.height * scale)),
  };
}

export interface PhotoInput {
  /** Luminance 0 (black) .. 1 (white) of the cropped photo, row-major. */
  luminance: Float32Array;
  width: number;
  height: number;
  place: Placement;
  area: Rect;
  options: PhotoOptions;
}

export interface PhotoResult {
  lines: Polyline[];
  /** True when TSP ran out of its time budget before the tour stopped improving. */
  timedOut: boolean;
  /** Outline edges dropped for being shorter than minLength. */
  dropped: number;
}

/** Round to 0.01 mm (keeps saved drawings small) and keep inside the area. */
function finish(lines: Polyline[], area: Rect): Polyline[] {
  const r = (n: number) => Math.round(n * 100) / 100;
  return lines
    .map((l) => dedupe(l.map((p) => clampPoint({ x: r(p.x), y: r(p.y) }, area))))
    .filter((l) => l.length >= 2);
}

function outline(grid: ToneGrid, place: Placement, o: OutlineOptions): { lines: Polyline[]; dropped: number } {
  const mask = detectEdges(grid, { blur: o.blur, threshold: o.threshold });
  // Simplify to about half a pixel: removes the pixel staircase, keeps the shape.
  const tolerance = (0.5 * place.width) / grid.width;
  const lines = traceEdges(mask, grid.width, grid.height).map((l) =>
    simplifyRDP(l.map((p) => gridToPlace(p, grid, place)), tolerance),
  );
  const kept = lines.filter((l) => l.length >= 2 && polylineLength(l) >= o.minLength);
  return { lines: kept, dropped: lines.length - kept.length };
}

function tsp(grid: ToneGrid, place: Placement, o: TspOptions): { lines: Polyline[]; timedOut: boolean } {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const budget = o.timeLimit * 1000;
  // Stippling gets 60% of the budget; the tour the rest, plus whatever stippling left over.
  const points = stipple(grid, o.points, { deadline: started + budget * 0.6 });
  const { path, timedOut } = tspPath(points, started + budget);
  return { lines: path.length >= 2 ? [path.map((p) => gridToPlace(p, grid, place))] : [], timedOut };
}

export function buildPhoto(input: PhotoInput): PhotoResult {
  const { options: o, place } = input;
  const grid = adjustTone(input.luminance, input.width, input.height, o.tone);
  let lines: Polyline[] = [];
  let timedOut = false;
  let dropped = 0;
  switch (o.style) {
    case 'squiggle':
      lines = squiggle(grid, place, o.squiggle);
      break;
    case 'spiral':
      lines = spiral(grid, place, o.spiral);
      break;
    case 'hatch':
      lines = orderLines(hatch(grid, place, o.hatch), place);
      break;
    case 'outline':
      ({ lines, dropped } = outline(grid, place, o.outline));
      lines = orderLines(lines, place);
      break;
    case 'tsp':
      ({ lines, timedOut } = tsp(grid, place, o.tsp));
      break;
  }
  return { lines: finish(lines, input.area), timedOut, dropped };
}

export interface PhotoEstimate {
  lines: number;
  points: number;
  /** Pen-down length, mm. */
  drawLength: number;
  /** Pen-up travel between lines in generated order, mm. The planner usually shortens it. */
  travel: number;
  seconds: number;
}

/** Rough cost of plotting `lines`, before the planner reorders them. */
export function estimatePhoto(lines: Polyline[], s: Pick<Settings, 'drawFeed' | 'travelFeed' | 'penDwell'>): PhotoEstimate {
  let drawLength = 0;
  let travel = 0;
  let points = 0;
  for (let i = 0; i < lines.length; i++) {
    drawLength += polylineLength(lines[i]);
    points += lines[i].length;
    if (i > 0) travel += dist(lines[i - 1][lines[i - 1].length - 1], lines[i][0]);
  }
  return { lines: lines.length, points, drawLength, travel, seconds: estimateSeconds(drawLength, travel, lines.length, s) };
}
