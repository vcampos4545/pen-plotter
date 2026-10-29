import { isolines } from './contour';
import type { Point, Polyline, Rect } from './geometry';
import { bounds, densify } from './text-layout';

// Fills for letter shapes, in paper mm. Shapes are closed contours filled by
// the nonzero rule, as fonts are, so the holes in O and A stay empty and
// overlapping letters merge. Straight hatching is clipped exactly. Insets,
// offsets and the clipping of curved fills use a signed distance field: a grid
// whose value is the distance to the shape's edge, positive inside.

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** +1 where the contour runs down (y growing), -1 up. */
  w: number;
}

function edgesOf(contours: Polyline[]): Edge[] {
  const edges: Edge[] = [];
  for (const c of contours) {
    for (let i = 0; i < c.length; i++) {
      const a = c[i];
      const b = c[(i + 1) % c.length];
      if (a.y === b.y) continue;
      edges.push(a.y < b.y ? { x0: a.x, y0: a.y, x1: b.x, y1: b.y, w: 1 } : { x0: b.x, y0: b.y, x1: a.x, y1: a.y, w: -1 });
    }
  }
  return edges.sort((p, q) => p.y0 - q.y0);
}

/**
 * Inside spans [x0, x1, x0, x1, ...] of the shape along each horizontal line
 * y = ys[k], nonzero rule. `ys` must be ascending.
 */
export function spans(contours: Polyline[], ys: number[]): number[][] {
  const edges = edgesOf(contours);
  const out: number[][] = [];
  let next = 0;
  let active: Edge[] = [];
  for (const y of ys) {
    while (next < edges.length && edges[next].y0 <= y) active.push(edges[next++]);
    active = active.filter((e) => e.y1 > y);
    const hits: Array<{ x: number; w: number }> = [];
    for (const e of active) {
      if (e.y0 > y) continue;
      hits.push({ x: e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), w: e.w });
    }
    hits.sort((a, b) => a.x - b.x);
    const row: number[] = [];
    let winding = 0;
    for (const h of hits) {
      const before = winding;
      winding += h.w;
      if (before === 0 && winding !== 0) row.push(h.x);
      else if (before !== 0 && winding === 0) row.push(h.x);
    }
    out.push(row);
  }
  return out;
}

const rotate = (p: Point, cos: number, sin: number): Point => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos });

/**
 * Straight parallel lines `spacing` apart at `angle` degrees, clipped to the
 * shape. Lines sit on a fixed grid through the origin, so two hatches at the
 * same angle line up. Alternate rows run back the other way.
 */
export function hatchFill(contours: Polyline[], spacing: number, angle: number): Polyline[] {
  if (!(spacing > 0)) return [];
  const t = (angle * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  // Turn the shape so the hatch runs along x, then turn the lines back.
  const turned = contours.map((c) => c.map((p) => rotate(p, cos, -sin)));
  const box = bounds(turned);
  if (!box) return [];
  const ys: number[] = [];
  for (let k = Math.ceil(box.minY / spacing); k * spacing <= box.maxY; k++) ys.push(k * spacing);
  const lines: Polyline[] = [];
  spans(turned, ys).forEach((row, r) => {
    const segs: Polyline[] = [];
    for (let i = 0; i + 1 < row.length; i += 2) {
      if (row[i + 1] - row[i] < 1e-6) continue;
      segs.push([rotate({ x: row[i], y: ys[r] }, cos, sin), rotate({ x: row[i + 1], y: ys[r] }, cos, sin)]);
    }
    if (r % 2 === 1) {
      segs.reverse();
      for (const s of segs) s.reverse();
    }
    lines.push(...segs);
  });
  return lines;
}

// ---- distance field -------------------------------------------------------

export interface Field {
  /** Paper position of grid node (0, 0), mm. */
  x0: number;
  y0: number;
  /** Node spacing, mm. */
  cell: number;
  nx: number;
  ny: number;
  /** Signed distance to the edge at each node, mm. Positive inside. */
  sd: Float32Array;
}

/** Largest field, nodes. Coarser cells beyond this keep memory and time in check. */
const MAX_NODES = 3_000_000;
/** Finest field cell, mm. */
const MIN_CELL = 0.08;

function grid(box: Rect, margin: number, cell: number) {
  const w = box.maxX - box.minX + 2 * margin;
  const h = box.maxY - box.minY + 2 * margin;
  const c = Math.max(cell, MIN_CELL, Math.sqrt((w * h) / MAX_NODES));
  const nx = Math.max(2, Math.ceil(w / c) + 1);
  const ny = Math.max(2, Math.ceil(h / c) + 1);
  return { x0: box.minX - margin, y0: box.minY - margin, cell: c, nx, ny };
}

const INF = 1e20;

/**
 * Squared distance transform of one row or column (Felzenszwalb and
 * Huttenlocher, 2012): the lower envelope of parabolas rooted at the nodes
 * that have a finite value. A line with none stays at INF.
 */
function edt1d(f: Float32Array, start: number, stride: number, n: number, v: Int32Array, z: Float64Array, g: Float64Array): void {
  for (let q = 0; q < n; q++) g[q] = f[start + q * stride];
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (g[q] >= INF) continue;
    if (k < 0) {
      k = 0;
      v[0] = q;
      z[0] = -Infinity;
      z[1] = Infinity;
      continue;
    }
    let s: number;
    for (;;) {
      const p = v[k];
      s = (g[q] + q * q - (g[p] + p * p)) / (2 * (q - p));
      // z[0] is -Infinity, so this stops at k = 0 at the latest.
      if (s > z[k]) break;
      k--;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  if (k < 0) return;
  for (let q = 0, j = 0; q < n; q++) {
    while (z[j + 1] < q) j++;
    const p = v[j];
    f[start + q * stride] = (q - p) * (q - p) + g[p];
  }
}

/** Squared distance, in cells, from every node to the nearest node where `feature` is set. */
export function distanceTransform(feature: Uint8Array, nx: number, ny: number): Float32Array {
  const f = new Float32Array(nx * ny);
  for (let i = 0; i < f.length; i++) f[i] = feature[i] ? 0 : INF;
  const n = Math.max(nx, ny);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const g = new Float64Array(n);
  for (let i = 0; i < nx; i++) edt1d(f, i, nx, ny, v, z, g);
  for (let j = 0; j < ny; j++) edt1d(f, j * nx, 1, nx, v, z, g);
  return f;
}

/** Signed distance field of a filled shape, reaching `margin` mm beyond it. */
export function contourField(contours: Polyline[], margin: number, cell = 0.1): Field | undefined {
  const box = bounds(contours);
  if (!box) return undefined;
  const gr = grid(box, margin, cell);
  const { nx, ny } = gr;
  const ys = Array.from({ length: ny }, (_, j) => gr.y0 + j * gr.cell);
  const inside = new Uint8Array(nx * ny);
  spans(contours, ys).forEach((row, j) => {
    for (let s = 0; s + 1 < row.length; s += 2) {
      const i0 = Math.max(0, Math.ceil((row[s] - gr.x0) / gr.cell));
      const i1 = Math.min(nx - 1, Math.floor((row[s + 1] - gr.x0) / gr.cell));
      for (let i = i0; i <= i1; i++) inside[j * nx + i] = 1;
    }
  });
  const outside = inside.map((v) => 1 - v);
  const toInside = distanceTransform(inside, nx, ny);
  const toOutside = distanceTransform(outside, nx, ny);
  const sd = new Float32Array(nx * ny);
  const half = gr.cell / 2;
  for (let k = 0; k < sd.length; k++) {
    // The edge lies about half a cell from the nearest node on the other side.
    sd[k] = inside[k] ? Math.sqrt(toOutside[k]) * gr.cell - half : half - Math.sqrt(toInside[k]) * gr.cell;
  }
  return { ...gr, sd };
}

/** Field of the band within `radius` mm of open strokes, reaching `margin` mm beyond it. */
export function strokeField(strokes: Polyline[], radius: number, margin: number, cell = 0.1): Field | undefined {
  const box = bounds(strokes);
  if (!box) return undefined;
  const gr = grid(box, radius + margin, cell);
  const { nx, ny } = gr;
  const on = new Uint8Array(nx * ny);
  for (const s of strokes) {
    for (const p of densify(s, gr.cell / 2)) {
      const i = Math.round((p.x - gr.x0) / gr.cell);
      const j = Math.round((p.y - gr.y0) / gr.cell);
      if (i >= 0 && i < nx && j >= 0 && j < ny) on[j * nx + i] = 1;
    }
  }
  const d2 = distanceTransform(on, nx, ny);
  const sd = new Float32Array(nx * ny);
  for (let k = 0; k < sd.length; k++) sd[k] = radius - Math.sqrt(d2[k]) * gr.cell;
  return { ...gr, sd };
}

/** Field value at a paper point, bilinear. Far outside beyond the grid. */
export function fieldAt(f: Field, p: Point): number {
  const u = (p.x - f.x0) / f.cell;
  const v = (p.y - f.y0) / f.cell;
  if (u < 0 || v < 0 || u > f.nx - 1 || v > f.ny - 1) return -INF;
  const i = Math.min(f.nx - 2, Math.floor(u));
  const j = Math.min(f.ny - 2, Math.floor(v));
  const a = u - i;
  const b = v - j;
  const k = j * f.nx + i;
  return (1 - b) * ((1 - a) * f.sd[k] + a * f.sd[k + 1]) + b * ((1 - a) * f.sd[k + f.nx] + a * f.sd[k + f.nx + 1]);
}

/** Lines where the field equals `level`, in paper mm. Positive levels lie inside the shape. */
export function fieldLines(f: Field, level: number): Polyline[] {
  return isolines(f.sd, f.nx, f.ny, level).map((l) => l.map((p) => ({ x: f.x0 + p.x * f.cell, y: f.y0 + p.y * f.cell })));
}

/** Concentric copies of the outline, `spacing` apart, working inwards until the shape runs out. */
export function insetFill(f: Field, spacing: number, maxRings = 500): Polyline[] {
  if (!(spacing > 0)) return [];
  let deepest = 0;
  for (const v of f.sd) if (v > deepest) deepest = v;
  const out: Polyline[] = [];
  for (let k = 1; k * spacing < deepest && k <= maxRings; k++) out.push(...fieldLines(f, k * spacing));
  return out;
}

/** Copies of the outline grown outwards by `gap`, 2 × `gap`, ...: a bold or double outline. */
export function outlineOffsets(f: Field, passes: number, gap: number): Polyline[] {
  const out: Polyline[] = [];
  for (let k = 1; k <= passes; k++) out.push(...fieldLines(f, -k * gap));
  return out;
}

/**
 * The parts of `lines` where the field is above `level` (or below it, with
 * `inside` false). Cuts are placed where the field crosses the level. Pieces
 * shorter than `minLength` are dropped.
 */
export function clipLines(lines: Polyline[], f: Field, level: number, inside = true, minLength = 0.2): Polyline[] {
  const out: Polyline[] = [];
  const keep = (p: Point) => (inside ? fieldAt(f, p) - level : level - fieldAt(f, p));
  const push = (piece: Polyline) => {
    let len = 0;
    for (let i = 1; i < piece.length && len < minLength; i++) len += Math.hypot(piece[i].x - piece[i - 1].x, piece[i].y - piece[i - 1].y);
    if (piece.length >= 2 && len >= minLength) out.push(piece);
  };
  for (const line of lines) {
    const pts = densify(line, f.cell);
    let piece: Polyline = [];
    let prev = pts.length ? keep(pts[0]) : 0;
    if (prev > 0) piece.push(pts[0]);
    for (let i = 1; i < pts.length; i++) {
      const cur = keep(pts[i]);
      if ((prev > 0) !== (cur > 0)) {
        // Interpolate the crossing; a jump from far outside the grid cuts at the inside point.
        const t = Math.abs(prev) >= INF / 2 || Math.abs(cur) >= INF / 2 ? (cur > 0 ? 1 : 0) : prev / (prev - cur);
        const a = pts[i - 1];
        const b = pts[i];
        const cut = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        if (cur > 0) piece = [cut];
        else {
          piece.push(cut);
          push(piece);
          piece = [];
        }
      }
      if (cur > 0) piece.push(pts[i]);
      prev = cur;
    }
    push(piece);
  }
  return out;
}

// ---- decorative fills -----------------------------------------------------

/** Wavy hatch: rows of sine waves `spacing` apart at `angle` degrees covering `box`. */
export function waveLines(box: Rect, spacing: number, angle: number): Polyline[] {
  const t = (angle * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const reach = Math.hypot(box.maxX - box.minX, box.maxY - box.minY) / 2 + spacing;
  const amp = spacing * 0.4;
  const k = (2 * Math.PI) / (spacing * 3);
  const step = Math.min(0.3, spacing / 4);
  const lines: Polyline[] = [];
  let row = 0;
  for (let y = -Math.ceil(reach / spacing) * spacing; y <= reach; y += spacing, row++) {
    const line: Polyline = [];
    for (let x = -reach; x <= reach; x += step) {
      const p = rotate({ x, y: y + amp * Math.sin(k * x) }, cos, sin);
      line.push({ x: cx + p.x, y: cy + p.y });
    }
    if (row % 2 === 1) line.reverse();
    lines.push(line);
  }
  return lines;
}

/** One Archimedean spiral from the centre of `box` out past its corners, turns `spacing` apart. */
export function spiralLines(box: Rect, spacing: number): Polyline[] {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const maxR = Math.hypot(box.maxX - box.minX, box.maxY - box.minY) / 2 + spacing;
  const b = spacing / (2 * Math.PI);
  const line: Polyline = [];
  let theta = 0;
  for (let r = 0; r <= maxR; r = b * theta) {
    line.push({ x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) });
    // About 0.3 mm along the curve per step, finer near the centre.
    theta += Math.min(0.3, 0.3 / Math.max(r, 0.3));
  }
  return [line];
}

// ---- strokes --------------------------------------------------------------

/** `line` moved sideways by `d` mm (positive to the left of travel). Sharp corners are mitred, up to 2 × `d`. */
export function offsetStroke(line: Polyline, d: number): Polyline {
  const n = line.length;
  if (n < 2 || d === 0) return line.slice();
  const closed = n > 2 && line[0].x === line[n - 1].x && line[0].y === line[n - 1].y;
  const normal = (a: Point, b: Point): Point => {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.y - a.y) / len, y: -(b.x - a.x) / len };
  };
  const out: Polyline = [];
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? line[i - 1] : closed ? line[n - 2] : undefined;
    const next = i < n - 1 ? line[i + 1] : closed ? line[1] : undefined;
    const n1 = prev ? normal(prev, line[i]) : undefined;
    const n2 = next ? normal(line[i], next) : undefined;
    let m = n1 && n2 ? { x: n1.x + n2.x, y: n1.y + n2.y } : (n1 ?? n2)!;
    const len = Math.hypot(m.x, m.y);
    if (len < 1e-9) m = n1!;
    else {
      // Scale so the offset is d from both segments: 1 / cos(half the turn).
      const cosHalf = n1 && n2 ? len / 2 : 1;
      const k = Math.min(2, 1 / Math.max(cosHalf, 1e-9)) / len;
      m = { x: m.x * k, y: m.y * k };
    }
    out.push({ x: line[i].x + m.x * d, y: line[i].y + m.y * d });
  }
  return out;
}

/** Strokes plus `passes` parallel copies to each side, `gap` mm apart: a heavier single-stroke letter. */
export function thicken(strokes: Polyline[], passes: number, gap: number): Polyline[] {
  const out = strokes.slice();
  for (let k = 1; k <= passes; k++) {
    for (const s of strokes) {
      out.push(offsetStroke(s, k * gap));
      out.push(offsetStroke(s, -k * gap).reverse());
    }
  }
  return out;
}
