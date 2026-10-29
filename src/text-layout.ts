import type { Point, Polyline, Rect } from './geometry';

// Lays a block of text out as paths in mm and bends it: slant, taper, wave and
// arc. Fonts come in two kinds: single-stroke (Hershey) fonts give open
// strokes the pen draws as they are, outline fonts give closed contours that
// can be outlined and filled. Text space is y down with the first line's
// baseline at y = 0 and the block's left edge at x = 0.

export interface FontGlyph {
  /** Distance to the next glyph's origin, kerning included, font units. */
  advance: number;
  /** Strokes or closed contours relative to the glyph origin on the baseline, font units, y down. */
  paths: Polyline[];
  /** The font has no glyph for this character; a blank took its place. */
  missing: boolean;
}

export interface TextFont {
  kind: 'stroke' | 'outline';
  /** Height of a capital letter, font units. */
  capHeight: number;
  /** Baseline to baseline at line height 1, font units. */
  lineHeight: number;
  /** Glyphs for one line of text. `tolerance` is the curve flattening error allowed, font units. */
  shape(line: string, tolerance: number): FontGlyph[];
}

export type TextAlign = 'left' | 'center' | 'right';

export interface LayoutOptions {
  /** Height of a capital letter, mm. */
  size: number;
  /** Extra gap between letters, mm. May be negative. */
  letterSpacing: number;
  /** Baseline to baseline, as a multiple of the font's own line height. */
  lineHeight: number;
  align: TextAlign;
}

export interface TextLayout {
  /** Strokes (single-stroke fonts) or closed contours (outline fonts), mm. */
  paths: Polyline[];
  /** Width of the widest line, mm. */
  width: number;
  /** Baseline y of each line, mm. */
  baselines: number[];
  /** Characters the font has no glyph for. */
  missing: number;
}

/** Curve flattening error, mm. Well under a pen width. */
const FLATTEN_TOLERANCE = 0.02;

export function layoutText(font: TextFont, text: string, o: LayoutOptions): TextLayout {
  const scale = o.size / font.capHeight;
  const lineGap = font.lineHeight * scale * o.lineHeight;
  const rows = text.replace(/\r\n?/g, '\n').split('\n');
  let missing = 0;
  const shaped = rows.map((row) => {
    const glyphs = font.shape(row, FLATTEN_TOLERANCE / scale);
    const placed: Polyline[] = [];
    let x = 0;
    glyphs.forEach((g, i) => {
      if (g.missing) missing++;
      for (const path of g.paths) placed.push(path.map((p) => ({ x: x + p.x * scale, y: p.y * scale })));
      x += g.advance * scale + (i < glyphs.length - 1 ? o.letterSpacing : 0);
    });
    return { paths: placed, width: Math.max(0, x) };
  });
  const width = Math.max(0, ...shaped.map((r) => r.width));
  const paths: Polyline[] = [];
  const baselines: number[] = [];
  shaped.forEach((row, i) => {
    const y = i * lineGap;
    const dx = o.align === 'left' ? 0 : o.align === 'center' ? (width - row.width) / 2 : width - row.width;
    baselines.push(y);
    for (const path of row.paths) paths.push(path.map((p) => ({ x: p.x + dx, y: p.y + y })));
  });
  return { paths, width, baselines, missing };
}

export interface WarpOptions {
  /** Lean of the letters, degrees. Positive leans right like italics. */
  slant: number;
  /** Letters grow from one end of the line to the other, percent. Positive grows to the right. */
  taper: number;
  /** Up and down wave along the line, mm. 0 turns it off. */
  waveAmplitude: number;
  /** Length of one wave, mm. */
  waveLength: number;
  /** Bend the text round a circle: degrees of arc the widest line covers. Positive bows up like a rainbow. */
  arc: number;
}

export const NO_WARP: WarpOptions = { slant: 0, taper: 0, waveAmplitude: 0, waveLength: 40, arc: 0 };

/** Bent paths keep segments this short so curves stay smooth, mm. */
const WARP_STEP = 0.5;

export function isWarped(o: WarpOptions): boolean {
  return o.slant !== 0 || o.taper !== 0 || o.waveAmplitude !== 0 || o.arc !== 0;
}

/** Split long segments so no piece is longer than `step`. */
export function densify(line: Polyline, step: number): Polyline {
  if (line.length < 2) return line.slice();
  const out: Polyline = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step);
    for (let k = 1; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    out.push(b);
  }
  return out;
}

/**
 * The point map for a text block `width` wide whose ink spans `top`..`bottom`
 * (y down, the first baseline at 0). Applied in order: slant, taper, wave, arc.
 */
export function warpPoint(o: WarpOptions, width: number, top: number, bottom: number): (p: Point) => Point {
  const shear = Math.tan((Math.max(-80, Math.min(80, o.slant)) * Math.PI) / 180);
  const mid = (top + bottom) / 2;
  const t = o.taper / 100;
  const k = (2 * Math.PI) / Math.max(1e-6, o.waveLength);
  const angle = (o.arc * Math.PI) / 180;
  const radius = angle !== 0 && width > 0 ? width / angle : 0;
  const cx = width / 2;
  return (p) => {
    // Lean about the baseline so the letters' feet stay put.
    let x = p.x - p.y * shear;
    let y = p.y;
    if (t !== 0 && width > 0) {
      const grow = Math.max(0.05, 1 + t * ((2 * p.x) / width - 1));
      y = mid + (y - mid) * grow;
    }
    if (o.waveAmplitude !== 0) y += o.waveAmplitude * Math.sin(k * x);
    if (radius !== 0) {
      // The baseline y = 0 becomes a circle of `radius` about (cx, radius),
      // keeping distance along it. A negative radius puts the centre above.
      const theta = (x - cx) / radius;
      const r = radius - y;
      x = cx + r * Math.sin(theta);
      y = radius - r * Math.cos(theta);
    }
    return { x, y };
  };
}

/** Bend every path. Segments are split first so straight edges can curve. */
export function warpPaths(paths: Polyline[], o: WarpOptions, width: number): Polyline[] {
  if (!isWarped(o)) return paths;
  const box = bounds(paths);
  if (!box) return paths;
  const map = warpPoint(o, width, box.minY, box.maxY);
  return paths.map((path) => densify(path, WARP_STEP).map(map));
}

export function bounds(paths: Polyline[]): Rect | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const p of path) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : undefined;
}
