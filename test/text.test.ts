import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { describe, expect, it } from 'vitest';
import { insideRect, type Point, type Polyline } from '../src/geometry';
import { hersheyFont, parseJhf } from '../src/hershey';
import { flattenCommands, outlineFont } from '../src/outline-font';
import { buildText, DEFAULT_TEXT_OPTIONS, sanitizeTextOptions, TEXT_FILLS, type TextOptions } from '../src/text';
import {
  clipLines,
  contourField,
  distanceTransform,
  fieldAt,
  hatchFill,
  insetFill,
  offsetStroke,
  outlineOffsets,
  spans,
  strokeField,
} from '../src/text-fill';
import { bounds, layoutText, NO_WARP, warpPaths, warpPoint, type TextFont } from '../src/text-layout';

const fontDir = new URL('../src/fonts/', import.meta.url);
const sans = hersheyFont(readFileSync(new URL('hershey/futural.jhf', fontDir), 'utf8'));
const bytes = readFileSync(new URL('outline/BebasNeue-Regular.ttf', fontDir));
const bebas = outlineFont(parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));

const layout = { size: 10, letterSpacing: 0, lineHeight: 1, align: 'left' as const };

/** Axis-aligned square as a closed contour; clockwise on screen (y down) unless `reverse`. */
function square(x: number, y: number, s: number, reverse = false): Polyline {
  const c = [
    { x, y },
    { x: x + s, y },
    { x: x + s, y: y + s },
    { x, y: y + s },
    { x, y },
  ];
  return reverse ? c.reverse() : c;
}
/** A 20 mm square with a 10 mm hole wound the other way, like the counter of an O. */
const ring = [square(0, 0, 20), square(5, 5, 10, true)];

const width = (l: Polyline) => Math.abs(l[l.length - 1].x - l[0].x);

describe('Hershey fonts', () => {
  it('parses one glyph per printable ASCII character', () => {
    const glyphs = parseJhf(readFileSync(new URL('hershey/futural.jhf', fontDir), 'utf8'));
    expect(glyphs.size).toBe(95);
    const a = glyphs.get('A'.charCodeAt(0))!;
    expect(a.strokes).toHaveLength(3);
    expect(a.right - a.left).toBe(18);
    expect(glyphs.get(32)!.strokes).toHaveLength(0);
  });

  it('scales so a capital is the asked size, standing on the baseline', () => {
    const box = bounds(layoutText(sans, 'H', layout).paths)!;
    expect(box.maxY).toBeCloseTo(0);
    expect(box.maxY - box.minY).toBeCloseTo(10);
  });

  it('counts characters the font lacks', () => {
    expect(layoutText(sans, 'a€b', layout).missing).toBe(1);
  });
});

describe('outline fonts', () => {
  it('flattens curves within the tolerance and closes every contour', () => {
    const [c] = flattenCommands(
      [
        { type: 'M', x: 0, y: 0 },
        { type: 'Q', x1: 50, y1: 100, x: 100, y: 0 },
        { type: 'Z' },
      ],
      0.1,
    );
    expect(c[0]).toEqual(c[c.length - 1]);
    // The curve's peak is at y = 50; the flattened one must reach close to it.
    expect(Math.max(...c.map((p) => p.y))).toBeGreaterThan(49.9);
  });

  it('gives an O two contours wound opposite ways, and sizes capitals', () => {
    const o = layoutText(bebas, 'O', layout).paths;
    expect(o).toHaveLength(2);
    const area = (c: Polyline) => c.reduce((s, p, i) => s + (i ? c[i - 1].x * p.y - p.x * c[i - 1].y : 0), 0) / 2;
    expect(Math.sign(area(o[0]))).toBe(-Math.sign(area(o[1])));
    const h = bounds(layoutText(bebas, 'H', layout).paths)!;
    expect(h.maxY - h.minY).toBeCloseTo(10, 1);
  });
});

describe('layoutText', () => {
  it('adds letter spacing between letters but not after the last', () => {
    const plain = layoutText(sans, 'ABC', layout).width;
    expect(layoutText(sans, 'ABC', { ...layout, letterSpacing: 2 }).width).toBeCloseTo(plain + 4);
  });

  it('aligns each line within the widest and stacks lines by the line height', () => {
    const font: TextFont = {
      kind: 'stroke',
      capHeight: 10,
      lineHeight: 20,
      shape: (line) => Array.from(line, () => ({ advance: 10, paths: [[{ x: 0, y: 0 }, { x: 10, y: 0 }]], missing: false })),
    };
    for (const [align, start] of [['left', 0], ['center', 10], ['right', 20]] as const) {
      const t = layoutText(font, 'aaaa\naa', { ...layout, align, lineHeight: 1.5 });
      expect(t.width).toBe(40);
      expect(t.baselines).toEqual([0, 30]);
      const second = t.paths.filter((p) => p[0].y === 30);
      expect(Math.min(...second.map((p) => p[0].x))).toBe(start);
    }
  });
});

describe('warps', () => {
  it('is the identity with no warp', () => {
    const paths = [[{ x: 0, y: 0 }, { x: 10, y: -5 }]];
    expect(warpPaths(paths, NO_WARP, 10)).toBe(paths);
  });

  it('bends the baseline onto a circle, keeping distance along it', () => {
    const width = 100;
    const map = warpPoint({ ...NO_WARP, arc: 90 }, width, -10, 0);
    const radius = width / (Math.PI / 2);
    const centre = { x: 50, y: radius };
    for (const x of [0, 25, 50, 100]) {
      const p = map({ x, y: 0 });
      expect(Math.hypot(p.x - centre.x, p.y - centre.y)).toBeCloseTo(radius);
      // Angle from straight up equals distance along the line over the radius.
      expect(Math.atan2(p.x - centre.x, centre.y - p.y)).toBeCloseTo((x - 50) / radius);
    }
    // Up is away from the centre of a rainbow, towards it for a smile.
    expect(map({ x: 50, y: -10 }).y).toBeCloseTo(-10);
    const smile = warpPoint({ ...NO_WARP, arc: -90 }, width, -10, 0);
    const end = smile({ x: 100, y: 0 });
    expect(end.y).toBeLessThan(0);
    expect(Math.hypot(end.x - 50, end.y + radius)).toBeCloseTo(radius);
  });

  it('waves up and down by the amplitude', () => {
    const map = warpPoint({ ...NO_WARP, waveAmplitude: 3, waveLength: 40 }, 100, -10, 0);
    expect(map({ x: 10, y: 0 }).y).toBeCloseTo(3);
    expect(map({ x: 30, y: 0 }).y).toBeCloseTo(-3);
    expect(map({ x: 20, y: -5 }).y).toBeCloseTo(-5);
  });

  it('slants about the baseline', () => {
    const map = warpPoint({ ...NO_WARP, slant: 45 }, 100, -10, 0);
    expect(map({ x: 5, y: 0 })).toEqual({ x: 5, y: 0 });
    expect(map({ x: 5, y: -10 }).x).toBeCloseTo(15);
  });
});

describe('hatchFill', () => {
  it('leaves holes wound the other way empty (nonzero rule)', () => {
    const lines = hatchFill(ring, 1, 0);
    // Rows through the hole come in two pieces, rows above it in one.
    const through = lines.filter((l) => Math.abs(l[0].y - 10) < 1e-9);
    expect(through).toHaveLength(2);
    expect(through.map(width).sort()).toEqual([5, 5]);
    expect(lines.filter((l) => Math.abs(l[0].y - 2) < 1e-9).map(width)).toEqual([20]);
  });

  it('merges overlapping shapes instead of cancelling them', () => {
    const [row] = spans([square(0, 0, 10), square(5, 0, 10)], [5]);
    expect(row).toEqual([0, 15]);
  });

  it('keeps every line inside the shape at any angle', () => {
    for (const angle of [0, 30, 45, 90, 137]) {
      for (const l of hatchFill(ring, 0.7, angle)) {
        for (const p of l) expect(insideRect(p, { minX: 0, minY: 0, maxX: 20, maxY: 20 }, 1e-6)).toBe(true);
        const mid = { x: (l[0].x + l[1].x) / 2, y: (l[0].y + l[1].y) / 2 };
        expect(mid.x > 5 && mid.x < 15 && mid.y > 5 && mid.y < 15).toBe(false);
      }
    }
  });

  it('clips to the counters of real letters', () => {
    const paths = layoutText(bebas, 'OA', { ...layout, size: 30 }).paths;
    const lines = hatchFill(paths, 0.5, 0);
    const box = bounds(paths)!;
    // A row through the middle of the O crosses ink, counter, ink: two pieces in the O.
    const oBox = bounds(paths.slice(0, 2))!;
    const midY = Math.round((oBox.minY + oBox.maxY) / 2 / 0.5) * 0.5;
    const inO = lines.filter((l) => Math.abs(l[0].y - midY) < 1e-6 && Math.max(l[0].x, l[1].x) <= oBox.maxX + 1e-6);
    expect(inO).toHaveLength(2);
    expect(lines.every((l) => l.every((p) => insideRect(p, box, 1e-6)))).toBe(true);
  });
});

describe('distance field', () => {
  it('matches brute-force distances', () => {
    const nx = 13;
    const ny = 9;
    const feature = new Uint8Array(nx * ny);
    const on = [5, 40, 77, 100];
    for (const k of on) feature[k] = 1;
    const d = distanceTransform(feature, nx, ny);
    for (let k = 0; k < nx * ny; k++) {
      const best = Math.min(...on.map((f) => (f % nx - (k % nx)) ** 2 + (Math.floor(f / nx) - Math.floor(k / nx)) ** 2));
      expect(d[k]).toBe(best);
    }
  });

  it('is positive inside the shape, negative in the hole and outside', () => {
    const f = contourField(ring, 3)!;
    expect(fieldAt(f, { x: 2.5, y: 10 })).toBeCloseTo(2.5, 0);
    expect(fieldAt(f, { x: 10, y: 10 })).toBeCloseTo(-5, 0);
    expect(fieldAt(f, { x: -2, y: 10 })).toBeCloseTo(-2, 0);
  });

  it('insets rings that stay inside the ink and out of the hole', () => {
    const f = contourField(ring, 1, 0.05)!;
    const rings = insetFill(f, 1);
    expect(rings.length).toBeGreaterThan(0);
    for (const r of rings) {
      for (const p of r) {
        const sd = fieldAt(f, p);
        expect(sd).toBeGreaterThan(0.5);
        expect(p.x > 5.5 && p.x < 14.5 && p.y > 5.5 && p.y < 14.5).toBe(false);
      }
    }
  });

  it('grows outlines outwards by the gap', () => {
    const f = contourField([square(0, 0, 20)], 3, 0.05)!;
    const [outer] = outlineOffsets(f, 1, 2);
    const box = bounds([outer])!;
    expect(box.minX).toBeCloseTo(-2, 1);
    expect(box.maxY).toBeCloseTo(22, 1);
  });

  it('clips lines to the shape, cutting at the edges', () => {
    const f = contourField(ring, 1, 0.05)!;
    const pieces = clipLines([[{ x: -5, y: 10 }, { x: 25, y: 10 }]], f, 0);
    expect(pieces).toHaveLength(2);
    expect(pieces[0][0].x).toBeCloseTo(0, 1);
    expect(pieces[0][pieces[0].length - 1].x).toBeCloseTo(5, 1);
    expect(pieces[1][0].x).toBeCloseTo(15, 1);
    expect(pieces[1][pieces[1].length - 1].x).toBeCloseTo(20, 1);
    // Outside instead: the three gaps.
    expect(clipLines([[{ x: -5, y: 10 }, { x: 25, y: 10 }]], f, 0, false)).toHaveLength(3);
  });

  it('measures the band round open strokes', () => {
    const f = strokeField([[{ x: 0, y: 0 }, { x: 10, y: 0 }]], 1, 1)!;
    expect(fieldAt(f, { x: 5, y: 0 })).toBeCloseTo(1, 1);
    expect(fieldAt(f, { x: 5, y: 1.5 })).toBeCloseTo(-0.5, 1);
  });
});

describe('offsetStroke', () => {
  it('moves a stroke sideways and keeps corners the same distance from both sides', () => {
    const corner: Polyline = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const off = offsetStroke(corner, 1);
    expect(off[0]).toEqual({ x: 0, y: -1 });
    expect(off[1].x).toBeCloseTo(11);
    expect(off[1].y).toBeCloseTo(-1);
    expect(off[2].x).toBeCloseTo(11);
  });
});

describe('buildText', () => {
  const area = { minX: 10, minY: 10, maxX: 190, maxY: 140 };
  const opts = (o: Partial<TextOptions>) => sanitizeTextOptions({ ...DEFAULT_TEXT_OPTIONS, ...o });
  const inside = (lines: Polyline[]) => lines.every((l) => l.every((p: Point) => insideRect(p, area)));

  it('centres single-stroke text in the area at the asked size', () => {
    const { lines, notes } = buildText(area, opts({ text: 'HI', font: 'hershey-sans', size: 20 }), sans);
    expect(notes).toEqual([]);
    const box = bounds(lines)!;
    expect(box.maxY - box.minY).toBeCloseTo(20, 1);
    expect((box.minX + box.maxX) / 2).toBeCloseTo(100, 0);
    expect((box.minY + box.maxY) / 2).toBeCloseTo(75, 0);
  });

  it('shrinks text that does not fit, and says so', () => {
    const { lines, notes } = buildText(area, opts({ text: 'A long line of text', font: 'hershey-sans', size: 80 }), sans);
    expect(inside(lines)).toBe(true);
    expect(notes.some((n) => n.startsWith('Shrunk'))).toBe(true);
  });

  it('thickens single strokes with parallel passes', () => {
    const thin = buildText(area, opts({ text: 'I', font: 'hershey-sans' }), sans).lines;
    const thick = buildText(area, opts({ text: 'I', font: 'hershey-sans', strokePasses: 2 }), sans).lines;
    expect(thick).toHaveLength(thin.length * 5);
  });

  it('draws every fill of an outline font inside the area', () => {
    for (const fill of TEXT_FILLS) {
      const { lines } = buildText(area, opts({ text: 'Ob', font: 'bebas-neue', size: 40, fill, spacing: 1.5, arc: 40, outlinePasses: 1 }), bebas);
      expect(lines.length).toBeGreaterThan(fill === 'none' ? 2 : 4);
      expect(inside(lines)).toBe(true);
    }
  });

  it('keeps the drop shadow off the letters', () => {
    const o = opts({ text: 'O', font: 'bebas-neue', size: 40, fill: 'none', outline: true, shadow: 4, spacing: 1 });
    const lines = buildText(area, o, bebas).lines;
    // The letter outlines are the closed lines; everything else is shadow hatching.
    const closed = (l: Polyline) => l[0].x === l[l.length - 1].x && l[0].y === l[l.length - 1].y;
    const letters = lines.filter(closed);
    const shadow = lines.filter((l) => !closed(l));
    expect(letters).toHaveLength(2);
    expect(shadow.length).toBeGreaterThan(10);
    const field = contourField(letters, 1)!;
    for (const l of shadow) for (const p of l) expect(fieldAt(field, p)).toBeLessThan(-0.3);
  });

  it('asks for text when there is none', () => {
    expect(buildText(area, opts({ text: '  ' }), sans)).toEqual({ lines: [], notes: ['Type some text to draw.'] });
  });
});
