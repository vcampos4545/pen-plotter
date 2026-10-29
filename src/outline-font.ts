import type { Font, PathCommand } from 'opentype.js';
import type { Point, Polyline } from './geometry';
import type { FontGlyph, TextFont } from './text-layout';

// An OpenType or TrueType font, parsed by opentype.js, as closed contours.
// Curves are flattened to straight segments within the tolerance asked for.

/** Segments for a curve whose control polygon bends by `bend`, within `tolerance`. */
function segments(bend: number, tolerance: number): number {
  return Math.max(1, Math.min(100, Math.ceil(Math.sqrt(bend / (4 * Math.max(1e-9, tolerance))))));
}

const bendOf = (a: Point, b: Point, c: Point) => Math.hypot(a.x - 2 * b.x + c.x, a.y - 2 * b.y + c.y);

/** Path commands (y down, as opentype.js gives them) to closed polylines. */
export function flattenCommands(commands: PathCommand[], tolerance: number): Polyline[] {
  const contours: Polyline[] = [];
  let current: Polyline = [];
  let at: Point = { x: 0, y: 0 };
  const close = () => {
    if (current.length >= 3) {
      const first = current[0];
      const last = current[current.length - 1];
      if (first.x !== last.x || first.y !== last.y) current.push({ ...first });
      contours.push(current);
    }
    current = [];
  };
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        close();
        at = { x: c.x, y: c.y };
        current.push(at);
        break;
      case 'L':
        at = { x: c.x, y: c.y };
        current.push(at);
        break;
      case 'Q': {
        const p0 = at;
        const p1 = { x: c.x1, y: c.y1 };
        const p2 = { x: c.x, y: c.y };
        const n = segments(bendOf(p0, p1, p2), tolerance);
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          const u = 1 - t;
          current.push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y });
        }
        at = p2;
        break;
      }
      case 'C': {
        const p0 = at;
        const p1 = { x: c.x1, y: c.y1 };
        const p2 = { x: c.x2, y: c.y2 };
        const p3 = { x: c.x, y: c.y };
        const n = segments(1.5 * Math.max(bendOf(p0, p1, p2), bendOf(p1, p2, p3)), tolerance);
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          const u = 1 - t;
          const a = u * u * u;
          const b = 3 * u * u * t;
          const d = 3 * u * t * t;
          const e = t * t * t;
          current.push({ x: a * p0.x + b * p1.x + d * p2.x + e * p3.x, y: a * p0.y + b * p1.y + d * p2.y + e * p3.y });
        }
        at = p3;
        break;
      }
      case 'Z':
        close();
        break;
    }
  }
  close();
  return contours;
}

export function outlineFont(font: Font): TextFont {
  const os2 = font.tables.os2 as { sCapHeight?: number } | undefined;
  const hhea = font.tables.hhea as { lineGap?: number } | undefined;
  let capHeight = os2?.sCapHeight ?? 0;
  if (!(capHeight > 0)) capHeight = font.charToGlyph('H').getBoundingBox().y2;
  if (!(capHeight > 0)) capHeight = 0.7 * font.unitsPerEm;
  const lineHeight = font.ascender - font.descender + (hhea?.lineGap ?? 0) || font.unitsPerEm * 1.2;
  return {
    kind: 'outline',
    capHeight,
    lineHeight,
    shape(line: string, tolerance: number): FontGlyph[] {
      const glyphs = font.stringToGlyphs(line.replace(/\t/g, ' '));
      return glyphs.map((g, i) => {
        const next = glyphs[i + 1];
        const kern = next ? font.getKerningValue(g, next) : 0;
        // Glyph 0 is .notdef: the font has nothing for this character. Leave a gap, not its box.
        const missing = g.index === 0;
        return {
          advance: (g.advanceWidth ?? 0) + kern,
          paths: missing ? [] : flattenCommands(g.getPath(0, 0, font.unitsPerEm).commands, tolerance),
          missing,
        };
      });
    },
  };
}
