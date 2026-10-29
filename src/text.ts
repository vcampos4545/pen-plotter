import { flowField } from './flowfield';
import { finish } from './generate';
import type { Point, Polyline, Rect } from './geometry';
import { orderLines } from './stipple';
import {
  clipLines,
  contourField,
  hatchFill,
  insetFill,
  outlineOffsets,
  spiralLines,
  strokeField,
  thicken,
  waveLines,
  type Field,
} from './text-fill';
import { bounds, layoutText, warpPaths, type TextAlign, type TextFont } from './text-layout';

// Text -> pen strokes in paper mm, centred in the drawable area. Single-stroke
// fonts are drawn as their strokes, optionally thickened. Outline fonts are
// outlined and filled. Either can be bent (slant, taper, wave, arc) and given
// a hatched drop shadow.

export type TextFill = 'none' | 'hatch' | 'crosshatch' | 'inset' | 'wave' | 'spiral' | 'flow';
export const TEXT_FILLS: TextFill[] = ['none', 'hatch', 'crosshatch', 'inset', 'wave', 'spiral', 'flow'];
const ALIGNS: TextAlign[] = ['left', 'center', 'right'];

export interface FontInfo {
  id: string;
  name: string;
  kind: 'stroke' | 'outline';
}

/** Bundled fonts. Data and licences are in src/fonts. */
export const FONTS: FontInfo[] = [
  { id: 'hershey-sans', name: 'Hershey Sans', kind: 'stroke' },
  { id: 'hershey-sans-bold', name: 'Hershey Sans Bold', kind: 'stroke' },
  { id: 'hershey-serif', name: 'Hershey Serif', kind: 'stroke' },
  { id: 'hershey-serif-italic', name: 'Hershey Serif Italic', kind: 'stroke' },
  { id: 'hershey-script', name: 'Hershey Script', kind: 'stroke' },
  { id: 'hershey-cursive', name: 'Hershey Cursive', kind: 'stroke' },
  { id: 'hershey-gothic', name: 'Hershey Gothic', kind: 'stroke' },
  { id: 'bebas-neue', name: 'Bebas Neue', kind: 'outline' },
  { id: 'abril-fatface', name: 'Abril Fatface', kind: 'outline' },
  { id: 'bungee', name: 'Bungee', kind: 'outline' },
  { id: 'pacifico', name: 'Pacifico', kind: 'outline' },
];
/** A font file the user loaded. It is not saved, so this falls back to the default on reload. */
export const CUSTOM_FONT = 'custom';

export interface TextOptions {
  text: string;
  font: string;
  /** Height of a capital letter, mm. */
  size: number;
  /** Extra gap between letters, mm. */
  letterSpacing: number;
  /** Baseline to baseline, × the font's own line height. */
  lineHeight: number;
  align: TextAlign;
  /** Draw the letters' outlines (outline fonts). */
  outline: boolean;
  /** Extra outlines grown outwards, for a bold or double outline (outline fonts). */
  outlinePasses: number;
  /** Gap between those outlines, mm. */
  outlineGap: number;
  fill: TextFill;
  /** Gap between fill lines, mm. */
  spacing: number;
  /** Direction of hatch and wave fills, degrees. */
  angle: number;
  /** Parallel copies to each side of every stroke (single-stroke fonts). */
  strokePasses: number;
  /** Gap between those copies, mm. */
  strokeGap: number;
  /** Lean, degrees. */
  slant: number;
  /** Letters grow along the line, percent. */
  taper: number;
  /** Wave height, mm. */
  waveAmplitude: number;
  /** Wave length, mm. */
  waveLength: number;
  /** Bend round a circle, degrees of arc. */
  arc: number;
  /** Drop shadow offset down and to the right, mm. 0 is off. */
  shadow: number;
}

export const DEFAULT_TEXT_OPTIONS: TextOptions = {
  text: 'Hello, plotter!',
  font: 'hershey-script',
  size: 20,
  letterSpacing: 0,
  lineHeight: 1,
  align: 'center',
  outline: true,
  outlinePasses: 0,
  outlineGap: 0.6,
  fill: 'hatch',
  spacing: 0.8,
  angle: 45,
  strokePasses: 0,
  strokeGap: 0.3,
  slant: 0,
  taper: 0,
  waveAmplitude: 0,
  waveLength: 60,
  arc: 0,
  shadow: 0,
};

/** Longest text accepted, characters. */
export const MAX_TEXT = 2000;
/** Gap kept between a drop shadow and the letters, mm. */
const SHADOW_GAP = 0.5;
/** Width of a single-stroke line as the shadow sees it, mm. */
const STROKE_HALF_WIDTH = 0.3;

const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const int = (v: unknown, fallback: number, min: number, max: number) => Math.round(num(v, fallback, min, max));
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

/** Fill gaps from the defaults and clamp every number to a usable range. */
export function sanitizeTextOptions(raw: unknown): TextOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_TEXT_OPTIONS;
  const font = typeof o.font === 'string' && (o.font === CUSTOM_FONT || FONTS.some((f) => f.id === o.font)) ? o.font : d.font;
  return {
    text: typeof o.text === 'string' ? o.text.slice(0, MAX_TEXT) : d.text,
    font,
    size: num(o.size, d.size, 1, 500),
    letterSpacing: num(o.letterSpacing, d.letterSpacing, -50, 100),
    lineHeight: num(o.lineHeight, d.lineHeight, 0.3, 5),
    align: ALIGNS.includes(o.align as TextAlign) ? (o.align as TextAlign) : d.align,
    outline: bool(o.outline, d.outline),
    outlinePasses: int(o.outlinePasses, d.outlinePasses, 0, 10),
    outlineGap: num(o.outlineGap, d.outlineGap, 0.1, 10),
    fill: TEXT_FILLS.includes(o.fill as TextFill) ? (o.fill as TextFill) : d.fill,
    spacing: num(o.spacing, d.spacing, 0.2, 20),
    angle: num(o.angle, d.angle, -360, 360),
    strokePasses: int(o.strokePasses, d.strokePasses, 0, 10),
    strokeGap: num(o.strokeGap, d.strokeGap, 0.05, 5),
    slant: num(o.slant, d.slant, -60, 60),
    taper: num(o.taper, d.taper, -90, 90),
    waveAmplitude: num(o.waveAmplitude, d.waveAmplitude, -200, 200),
    waveLength: num(o.waveLength, d.waveLength, 1, 2000),
    arc: num(o.arc, d.arc, -360, 360),
    shadow: num(o.shadow, d.shadow, 0, 50),
  };
}

export interface TextResult {
  lines: Polyline[];
  notes: string[];
}

const move = (paths: Polyline[], dx: number, dy: number) => paths.map((l) => l.map((p) => ({ x: p.x + dx, y: p.y + dy })));

/** The text's lines for `font`, which must be the font `o.font` names. */
export function buildText(area: Rect, o: TextOptions, font: TextFont): TextResult {
  const notes: string[] = [];
  if (o.text.trim() === '') return { lines: [], notes: ['Type some text to draw.'] };
  const layout = layoutText(font, o.text, o);
  if (layout.missing > 0) notes.push(`${layout.missing} character${layout.missing === 1 ? ' is' : 's are'} not in this font and left blank.`);
  let paths = warpPaths(layout.paths, o, layout.width);
  const ink = bounds(paths);
  if (!ink) return { lines: [], notes: [...notes, 'Nothing to draw: only spaces.'] };

  // Room the extras need around the letters themselves, which do not scale.
  const stroke = font.kind === 'stroke';
  const grow = stroke ? o.strokePasses * o.strokeGap + STROKE_HALF_WIDTH : o.outlinePasses * o.outlineGap;
  const shadow = o.shadow / Math.SQRT2;
  const aw = area.maxX - area.minX - 2 * grow - shadow;
  const ah = area.maxY - area.minY - 2 * grow - shadow;
  const w = ink.maxX - ink.minX;
  const h = ink.maxY - ink.minY;
  const scale = Math.min(1, w > 0 ? aw / w : 1, h > 0 ? ah / h : 1);
  if (!(scale > 0)) return { lines: [], notes: [...notes, 'The outlines and shadow leave no room on the sheet. Make them smaller.'] };
  if (scale < 0.999) notes.push(`Shrunk to ${Math.round(scale * 100)}% to fit the drawable area.`);
  const cx = (area.minX + area.maxX - shadow) / 2;
  const cy = (area.minY + area.maxY - shadow) / 2;
  const mx = (ink.minX + ink.maxX) / 2;
  const my = (ink.minY + ink.maxY) / 2;
  paths = paths.map((l) => l.map((p) => ({ x: cx + (p.x - mx) * scale, y: cy + (p.y - my) * scale })));

  const out: Polyline[] = [];
  let field: Field | undefined;
  if (stroke) {
    out.push(...thicken(paths, o.strokePasses, o.strokeGap));
    if (o.shadow > 0) {
      field = strokeField(paths, grow, SHADOW_GAP + 1);
      if (field) out.push(...clipLines(move(out, shadow, shadow), field, -SHADOW_GAP, false));
    }
  } else {
    if (o.outline) out.push(...paths);
    const needsField = o.outlinePasses > 0 || o.fill === 'inset' || o.fill === 'wave' || o.fill === 'spiral' || o.fill === 'flow' || o.shadow > 0;
    if (needsField) field = contourField(paths, grow + SHADOW_GAP + 1, Math.min(0.1, o.spacing / 4));
    if (field && o.outlinePasses > 0) out.push(...outlineOffsets(field, o.outlinePasses, o.outlineGap));
    out.push(...fillShape(paths, o, field));
    if (field && o.shadow > 0) {
      // Hatch the letters' shape moved down-right, minus the letters (and their extra outlines).
      const hatch = hatchFill(move(paths, shadow, shadow), o.spacing, o.angle + 90);
      out.push(...clipLines(hatch, field, -(grow + SHADOW_GAP), false));
    }
  }
  const start: Point = { x: area.minX, y: area.minY };
  return { lines: finish(orderLines(out.filter((l) => l.length >= 2), start), area), notes };
}

function fillShape(contours: Polyline[], o: TextOptions, field: Field | undefined): Polyline[] {
  const box = bounds(contours);
  if (!box) return [];
  switch (o.fill) {
    case 'none':
      return [];
    case 'hatch':
      return hatchFill(contours, o.spacing, o.angle);
    case 'crosshatch':
      return [...hatchFill(contours, o.spacing, o.angle), ...hatchFill(contours, o.spacing, o.angle + 90)];
    case 'inset':
      return field ? insetFill(field, o.spacing) : [];
    case 'wave':
      return field ? clipLines(waveLines(box, o.spacing, o.angle), field, 0) : [];
    case 'spiral':
      return field ? clipLines(spiralLines(box, o.spacing), field, 0) : [];
    case 'flow': {
      if (!field) return [];
      // Swirls about the size of a letter, so each one gets a little eddy.
      const scale = Math.max(5, o.size * 1.5);
      const lines = flowField(box, { seed: 1, scale, curl: 1.2, spacing: o.spacing, step: Math.min(0.5, o.spacing / 2), maxLength: 2000, minLength: 0 });
      return clipLines(lines, field, 0);
    }
  }
}
