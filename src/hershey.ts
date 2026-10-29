import type { Polyline } from './geometry';
import type { FontGlyph, TextFont } from './text-layout';

// Hershey single-stroke fonts in James Hurt's .jhf format: one glyph per line,
// a 5 character glyph number, a 3 character vertex count, then pairs of
// letters, each the coordinate plus 'R'. The first pair is the glyph's left and
// right edge; " R" lifts the pen. Glyphs are in ASCII order from the space.
// Coordinates are y down with the baseline at 9 and capitals 21 tall.

const R = 'R'.charCodeAt(0);
const FIRST_CHAR = 32;
const LAST_CHAR = 126;
/** Height of a capital, Hershey units. */
const CAP_HEIGHT = 21;
const BASELINE = 9;
/** Baseline to baseline at line height 1, Hershey units. */
const LINE_HEIGHT = 32;

export interface HersheyGlyph {
  left: number;
  right: number;
  /** Strokes, y down, relative to the glyph's own origin. */
  strokes: Polyline[];
}

/** Parse one .jhf file. Returns glyphs keyed by character code. */
export function parseJhf(text: string): Map<number, HersheyGlyph> {
  const glyphs = new Map<number, HersheyGlyph>();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  lines.forEach((line, i) => {
    const code = FIRST_CHAR + i;
    if (code > LAST_CHAR) return;
    const count = Number(line.slice(5, 8));
    const data = line.slice(8);
    if (!Number.isFinite(count) || data.length < 2) return;
    const left = data.charCodeAt(0) - R;
    const right = data.charCodeAt(1) - R;
    const strokes: Polyline[] = [];
    let current: Polyline = [];
    for (let k = 1; k < count && 2 * k + 1 < data.length; k++) {
      const a = data[2 * k];
      const b = data[2 * k + 1];
      if (a === ' ' && b === 'R') {
        if (current.length >= 2) strokes.push(current);
        current = [];
        continue;
      }
      current.push({ x: a.charCodeAt(0) - R, y: b.charCodeAt(0) - R });
    }
    if (current.length >= 2) strokes.push(current);
    glyphs.set(code, { left, right, strokes });
  });
  return glyphs;
}

/** A Hershey font as a TextFont: open strokes, no kerning. */
export function hersheyFont(text: string): TextFont {
  const glyphs = parseJhf(text);
  const space = glyphs.get(FIRST_CHAR) ?? { left: -8, right: 8, strokes: [] };
  return {
    kind: 'stroke',
    capHeight: CAP_HEIGHT,
    lineHeight: LINE_HEIGHT,
    shape(line: string): FontGlyph[] {
      const out: FontGlyph[] = [];
      for (const ch of line) {
        const code = ch === '\t' ? FIRST_CHAR : ch.codePointAt(0)!;
        const g = glyphs.get(code);
        const glyph = g ?? space;
        out.push({
          advance: glyph.right - glyph.left,
          paths: glyph.strokes.map((s) => s.map((p) => ({ x: p.x - glyph.left, y: p.y - BASELINE }))),
          missing: !g,
        });
      }
      return out;
    },
  };
}
