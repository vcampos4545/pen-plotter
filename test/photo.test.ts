import { describe, expect, it } from 'vitest';
import { newId } from '../src/drawing';
import { drawableRect, insideRect } from '../src/geometry';
import { buildJob } from '../src/job';
import {
  buildPhoto,
  DEFAULT_PHOTO_OPTIONS,
  estimatePhoto,
  framePhoto,
  PHOTO_STYLES,
  sanitizePhotoOptions,
  type PhotoInput,
  type PhotoOptions,
} from '../src/photo';
import { DEFAULT_SETTINGS } from '../src/settings';
import { adjustTone, DEFAULT_TONE, luminance, sampler } from '../src/tone';

/** Luminance image from f(x, y) in 0..1 (0 black). */
function image(w: number, h: number, f: (x: number, y: number) => number): Float32Array {
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out[j * w + i] = f(i, j);
  return out;
}

const area = drawableRect(200, 150, 10);
const place = { x: 10, y: 10, width: 180, height: 130 };

describe('tone', () => {
  it('converts RGBA to luminance, compositing transparency on white', () => {
    const rgba = [0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 255, 0, 0, 255];
    const lum = luminance(rgba, 4, 1);
    expect(lum[0]).toBe(0);
    expect(lum[1]).toBeCloseTo(1);
    expect(lum[2]).toBeCloseTo(1);
    expect(lum[3]).toBeCloseTo(0.2126);
  });

  it('turns luminance into darkness and applies invert', () => {
    const lum = Float32Array.from([0, 0.25, 1]);
    expect(Array.from(adjustTone(lum, 3, 1, DEFAULT_TONE).values)).toEqual([1, 0.75, 0]);
    expect(Array.from(adjustTone(lum, 3, 1, { ...DEFAULT_TONE, invert: true }).values)).toEqual([0, 0.25, 1]);
  });

  it('brightens, adds contrast around mid-grey and lifts mid-tones with gamma', () => {
    const lum = Float32Array.from([0.25, 0.5, 0.75]);
    const bright = adjustTone(lum, 3, 1, { ...DEFAULT_TONE, brightness: 20 }).values;
    expect(bright[1]).toBeCloseTo(0.3);
    const contrast = adjustTone(lum, 3, 1, { ...DEFAULT_TONE, contrast: 50 }).values;
    expect(contrast[0]).toBeCloseTo(1); // 0.25 pushed to black
    expect(contrast[1]).toBeCloseTo(0.5);
    expect(contrast[2]).toBeCloseTo(0);
    const gamma = adjustTone(lum, 3, 1, { ...DEFAULT_TONE, gamma: 2 }).values;
    expect(gamma[1]).toBeCloseTo(1 - Math.sqrt(0.5));
  });

  it('samples bilinearly between pixel centres and is white outside the placement', () => {
    const grid = adjustTone(Float32Array.from([1, 0]), 2, 1, DEFAULT_TONE); // white | black
    const at = sampler(grid, { x: 0, y: 0, width: 20, height: 10 });
    expect(at({ x: 5, y: 5 })).toBeCloseTo(0);
    expect(at({ x: 10, y: 5 })).toBeCloseTo(0.5);
    expect(at({ x: 15, y: 5 })).toBeCloseTo(1);
    expect(at({ x: 19.9, y: 5 })).toBeCloseTo(1);
    expect(at({ x: 25, y: 5 })).toBe(0);
    expect(at({ x: 5, y: -1 })).toBe(0);
  });
});

describe('framing', () => {
  it('fill crops a wide photo to the area shape, centred', () => {
    const f = framePhoto(1000, 400, area, 'fill');
    // Area is 180 × 130.
    expect(f.source.height).toBe(400);
    expect(f.source.width).toBeCloseTo((400 * 180) / 130);
    expect(f.source.x).toBeCloseTo((1000 - f.source.width) / 2);
    expect(f.place).toEqual(place);
  });

  it('fill crops a tall photo top and bottom', () => {
    const f = framePhoto(300, 900, area, 'fill');
    expect(f.source.width).toBe(300);
    expect(f.source.height).toBeCloseTo((300 * 130) / 180);
    expect(f.source.y).toBeCloseTo((900 - f.source.height) / 2);
  });

  it('fit keeps the whole photo and fits it inside the area', () => {
    const f = framePhoto(1000, 1000, area, 'fit');
    expect(f.source).toEqual({ x: 0, y: 0, width: 1000, height: 1000 });
    expect(f.place).toEqual({ x: 10 + 25, y: 10, width: 130, height: 130 });
  });

  it('caps the processing grid and never upsamples', () => {
    const big = framePhoto(4000, 3000, area, 'fit', 640);
    expect(big.gridWidth).toBe(640);
    expect(big.gridHeight).toBe(480);
    const small = framePhoto(40, 30, area, 'fit', 640);
    expect([small.gridWidth, small.gridHeight]).toEqual([40, 30]);
  });
});

describe('options', () => {
  it('fills in defaults and clamps', () => {
    expect(sanitizePhotoOptions(null)).toEqual(DEFAULT_PHOTO_OPTIONS);
    const o = sanitizePhotoOptions({ style: 'nope', fit: 'fit', hatch: { layers: 9, spacing: -1 }, tone: { gamma: 'x', invert: true } });
    expect(o.style).toBe('squiggle');
    expect(o.fit).toBe('fit');
    expect(o.hatch.layers).toBe(4);
    expect(o.hatch.spacing).toBe(0.3);
    expect(o.tone.gamma).toBe(1);
    expect(o.tone.invert).toBe(true);
  });
});

describe('buildPhoto', () => {
  // A dark disc on a light-grey ground, with a gradient for the hatching layers.
  const w = 72;
  const h = 52;
  const lum = image(w, h, (x, y) => (Math.hypot(x - w / 2, y - h / 2) < 18 ? 0.1 + (0.4 * x) / w : 0.9));
  const input = (o: Partial<PhotoOptions>): PhotoInput => ({
    luminance: lum,
    width: w,
    height: h,
    place,
    area,
    options: { ...DEFAULT_PHOTO_OPTIONS, tsp: { points: 300, timeLimit: 1 }, ...o },
  });

  for (const style of PHOTO_STYLES) {
    it(`${style}: produces strokes inside the margin that plan into a valid job`, () => {
      const r = buildPhoto(input({ style }));
      expect(r.lines.length).toBeGreaterThan(0);
      for (const l of r.lines) {
        expect(l.length).toBeGreaterThanOrEqual(2);
        for (const p of l) expect(insideRect(p, area)).toBe(true);
        // Rounded to 0.01 mm.
        for (const p of l) expect(Math.abs(p.x * 100 - Math.round(p.x * 100))).toBeLessThan(1e-6);
      }
      const settings = { ...DEFAULT_SETTINGS, paperWidth: 200, paperHeight: 150, optimizeTimeMs: 50 };
      const job = buildJob(
        r.lines.map((points) => ({ id: newId(), kind: 'freehand' as const, points })),
        settings,
      );
      expect(job.bounds.ok).toBe(true);
      expect(job.gcode.length).toBeGreaterThan(0);
    });
  }

  it('spiral and TSP are a single continuous stroke', () => {
    expect(buildPhoto(input({ style: 'spiral' })).lines).toHaveLength(1);
    expect(buildPhoto(input({ style: 'tsp' })).lines).toHaveLength(1);
  });

  it('outline traces the disc as one long line and drops nothing on a clean image', () => {
    const r = buildPhoto(input({ style: 'outline', outline: { blur: 1, threshold: 0.3, minLength: 4 } }));
    const longest = Math.max(...r.lines.map((l) => l.length));
    expect(longest).toBeGreaterThan(10);
  });

  it('a blank white photo gives nothing for hatching, outline and TSP', () => {
    const blank: PhotoInput = { ...input({}), luminance: image(w, h, () => 1) };
    for (const style of ['hatch', 'outline', 'tsp'] as const) {
      expect(buildPhoto({ ...blank, options: { ...blank.options, style } }).lines).toEqual([]);
    }
  });
});

describe('estimate', () => {
  it('sums drawing length, travel in order and time from the feeds', () => {
    const lines = [
      [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
      ],
      [
        { x: 30, y: 40 },
        { x: 0, y: 40 },
      ],
    ];
    const s = { drawFeed: 600, travelFeed: 2400, penDwell: 0.5 };
    const e = estimatePhoto(lines, s);
    expect(e).toEqual({ lines: 2, points: 4, drawLength: 60, travel: 40, seconds: 6 + 1 + 2 });
  });
});
