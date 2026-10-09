import type { Point } from './geometry';

// The drawing document: a list of immutable strokes in paper mm (origin at the
// top-left of the sheet, Y down), with snapshot undo/redo.

export type StrokeKind = 'freehand' | 'line' | 'rect' | 'ellipse';

export interface Stroke {
  id: string;
  kind: StrokeKind;
  points: Point[];
}

const KINDS: StrokeKind[] = ['freehand', 'line', 'rect', 'ellipse'];

let idCounter = 0;
export function newId(): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export class Drawing {
  private past: Stroke[][] = [];
  private future: Stroke[][] = [];
  private listeners = new Set<() => void>();
  /** Bumped on every change; lets callers cache derived data. */
  revision = 0;

  constructor(
    private current: Stroke[] = [],
    private readonly historyLimit = 200,
  ) {}

  get strokes(): readonly Stroke[] {
    return this.current;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private commit(next: Stroke[]): void {
    this.past.push(this.current);
    if (this.past.length > this.historyLimit) this.past.shift();
    this.future = [];
    this.current = next;
    this.changed();
  }

  private changed(): void {
    this.revision++;
    for (const fn of this.listeners) fn();
  }

  add(stroke: Stroke): void {
    this.commit([...this.current, stroke]);
  }

  /** Remove strokes by id as one undo step. No-op if none match. */
  remove(ids: Iterable<string>): void {
    const drop = new Set(ids);
    const next = this.current.filter((s) => !drop.has(s.id));
    if (next.length !== this.current.length) this.commit(next);
  }

  clear(): void {
    if (this.current.length > 0) this.commit([]);
  }

  /** Replace the whole drawing (import) as one undo step. */
  replace(strokes: Stroke[]): void {
    this.commit(strokes);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.current);
    this.current = prev;
    this.changed();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.current);
    this.current = next;
    this.changed();
  }
}

// ---- JSON ---------------------------------------------------------------

export interface DrawingFile {
  format: 'pen-plotter-drawing';
  version: 1;
  /** Paper size the drawing was made on, mm. */
  width: number;
  height: number;
  strokes: Array<{ kind: StrokeKind; points: Array<[number, number]> }>;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function toJSON(strokes: readonly Stroke[], width: number, height: number): DrawingFile {
  return {
    format: 'pen-plotter-drawing',
    version: 1,
    width,
    height,
    strokes: strokes.map((s) => ({ kind: s.kind, points: s.points.map((p) => [round3(p.x), round3(p.y)]) })),
  };
}

export function fromJSON(data: unknown): Stroke[] {
  const file = data as Partial<DrawingFile> | null;
  if (!file || typeof file !== 'object' || !Array.isArray(file.strokes)) {
    throw new Error('Not a pen plotter drawing (missing "strokes")');
  }
  const out: Stroke[] = [];
  for (const s of file.strokes) {
    if (!s || !Array.isArray(s.points)) continue;
    const points: Point[] = [];
    for (const p of s.points) {
      if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) points.push({ x: +p[0], y: +p[1] });
    }
    if (points.length === 0) continue;
    out.push({ id: newId(), kind: KINDS.includes(s.kind as StrokeKind) ? (s.kind as StrokeKind) : 'freehand', points });
  }
  return out;
}

// ---- SVG ----------------------------------------------------------------

/** SVG sized in mm with a viewBox in mm, so one user unit is one millimeter. */
export function toSVG(strokes: readonly Stroke[], width: number, height: number, strokeWidth = 0.5): string {
  const body = strokes
    .map((s) => {
      const pts = s.points.map((p) => `${round3(p.x)},${round3(p.y)}`).join(' ');
      return `  <polyline data-kind="${s.kind}" points="${pts}"/>`;
    })
    .join('\n');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">`,
    `<g fill="none" stroke="black" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">`,
    body,
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] ?? m[3]) : undefined;
}

function numbers(s: string): number[] {
  return (s.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
}

/** Size in mm of an SVG length such as "400mm", "40cm", "4in", or a bare number. */
function lengthToMm(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*(mm|cm|in|px|pt)?\s*$/i.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'px').toLowerCase();
  const perUnit: Record<string, number> = { mm: 1, cm: 10, in: 25.4, px: 25.4 / 96, pt: 25.4 / 72 };
  return n * perUnit[unit];
}

/** Parse the subset of path data made of straight segments (M, L, H, V, Z). Curves are rejected. */
export function parsePathData(d: string): Point[][] {
  const tokens = d.match(/[a-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const paths: Point[][] = [];
  let current: Point[] = [];
  let cmd = '';
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let i = 0;
  const num = () => {
    const t = tokens[i++];
    if (t === undefined || /[a-z]/i.test(t)) throw new Error('Malformed SVG path data');
    return Number(t);
  };
  while (i < tokens.length) {
    if (/^[a-z]$/i.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M': {
        const nx = num() + (rel ? x : 0);
        const ny = num() + (rel ? y : 0);
        if (current.length > 0) paths.push(current);
        x = startX = nx;
        y = startY = ny;
        current = [{ x, y }];
        cmd = rel ? 'l' : 'L'; // extra pairs after M are line-tos
        break;
      }
      case 'L':
        x = num() + (rel ? x : 0);
        y = num() + (rel ? y : 0);
        current.push({ x, y });
        break;
      case 'H':
        x = num() + (rel ? x : 0);
        current.push({ x, y });
        break;
      case 'V':
        y = num() + (rel ? y : 0);
        current.push({ x, y });
        break;
      case 'Z':
        x = startX;
        y = startY;
        current.push({ x, y });
        paths.push(current);
        current = [];
        // A following coordinate pair without a command is invalid; force a new command.
        if (i < tokens.length && !/^[a-z]$/i.test(tokens[i])) throw new Error('Malformed SVG path data');
        break;
      default:
        throw new Error(`Unsupported SVG path command "${cmd}" (only straight segments can be imported)`);
    }
  }
  if (current.length > 0) paths.push(current);
  return paths;
}

/**
 * Import polylines from an SVG. Supports polyline, polygon, line and path
 * elements made of straight segments, which covers everything toSVG writes.
 * Coordinates are scaled to mm using the root width/height and viewBox.
 */
export function fromSVG(svg: string): Stroke[] {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) throw new Error('Not an SVG file');
  let scaleX = 1;
  let scaleY = 1;
  let offX = 0;
  let offY = 0;
  const vb = attr(root, 'viewBox');
  const vbNums = vb ? numbers(vb) : [];
  if (vbNums.length === 4 && vbNums[2] > 0 && vbNums[3] > 0) {
    [offX, offY] = vbNums;
    const w = lengthToMm(attr(root, 'width'));
    const h = lengthToMm(attr(root, 'height'));
    // Without explicit sizes, treat one user unit as one mm.
    scaleX = w ? w / vbNums[2] : 1;
    scaleY = h ? h / vbNums[3] : scaleX;
    if (!w && h) scaleX = scaleY;
  }
  const map = (p: Point): Point => ({ x: (p.x - offX) * scaleX, y: (p.y - offY) * scaleY });

  const out: Stroke[] = [];
  const push = (points: Point[], kind: StrokeKind) => {
    const valid = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (valid.length > 0) out.push({ id: newId(), kind, points: valid.map(map) });
  };
  const toPoints = (nums: number[]) => {
    const pts: Point[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
    return pts;
  };

  for (const m of svg.matchAll(/<(polyline|polygon|line|path)\b[^>]*>/gi)) {
    const tag = m[0];
    const name = m[1].toLowerCase();
    const kindAttr = attr(tag, 'data-kind') as StrokeKind | undefined;
    const kind: StrokeKind = kindAttr && KINDS.includes(kindAttr) ? kindAttr : name === 'line' ? 'line' : 'freehand';
    if (name === 'polyline' || name === 'polygon') {
      const pts = toPoints(numbers(attr(tag, 'points') ?? ''));
      if (name === 'polygon' && pts.length > 1) pts.push({ ...pts[0] });
      push(pts, kind);
    } else if (name === 'line') {
      const n = (k: string) => Number(attr(tag, k) ?? 0);
      push([{ x: n('x1'), y: n('y1') }, { x: n('x2'), y: n('y2') }], kind);
    } else {
      for (const pts of parsePathData(attr(tag, 'd') ?? '')) push(pts, kind);
    }
  }
  return out;
}

// ---- localStorage -------------------------------------------------------

const STORAGE_KEY = 'penplotter.drawing.v1';

export function saveDrawing(strokes: readonly Stroke[], width: number, height: number, storage = globalThis.localStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(toJSON(strokes, width, height)));
  } catch {
    // Quota exceeded or storage disabled: keep working, the user can export.
  }
}

export function loadDrawing(storage = globalThis.localStorage): Stroke[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return raw ? fromJSON(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}
