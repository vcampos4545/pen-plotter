import { insideRect, type Point, type Polyline, type Rect } from './geometry';
import type { Settings } from './settings';

// Paper space (what the canvas shows) has its origin at the top-left corner with
// Y pointing down. Machine space has X0 Y0 at the configured origin corner.

export function toMachine(p: Point, s: Pick<Settings, 'paperHeight' | 'originCorner'>): Point {
  return s.originCorner === 'bottom-left' ? { x: p.x, y: s.paperHeight - p.y } : { x: p.x, y: p.y };
}

/** The transform is its own inverse (a Y flip or the identity). */
export const fromMachine = toMachine;

export interface BoundsReport {
  ok: boolean;
  /** Number of points outside the drawable area. */
  outside: number;
  /** Number of strokes containing at least one such point. */
  strokes: number;
}

export function checkBounds(strokes: Polyline[], area: Rect): BoundsReport {
  let outside = 0;
  let bad = 0;
  for (const s of strokes) {
    let strokeBad = false;
    for (const p of s) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !insideRect(p, area)) {
        outside++;
        strokeBad = true;
      }
    }
    if (strokeBad) bad++;
  }
  return { ok: outside === 0, outside, strokes: bad };
}

export class OutOfBoundsError extends Error {
  constructor(readonly report: BoundsReport) {
    super(`${report.outside} point(s) in ${report.strokes} stroke(s) are outside the work area`);
    this.name = 'OutOfBoundsError';
  }
}

export type GcodeOptions = Pick<
  Settings,
  'drawFeed' | 'travelFeed' | 'travelUseG1' | 'penUpZ' | 'penDownZ' | 'penDwell'
> & {
  /** When given, every point must lie inside it or generation throws. */
  bounds?: Rect;
  /** Optional comment lines placed at the top of the program. */
  header?: string[];
};

/** Format a coordinate: 3 decimals, no trailing zeros, never "-0". */
export function fmt(n: number): string {
  const s = n.toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * Turn ordered machine-space strokes into a FluidNC program: absolute mm, pen
 * lift on Z (RC servo), dwell after each pen change, G0 travel and G1 drawing.
 * Starts and ends with the pen up and finishes back at X0 Y0.
 */
export function generateGcode(strokes: Polyline[], o: GcodeOptions): string[] {
  if (o.bounds) {
    const report = checkBounds(strokes, o.bounds);
    if (!report.ok) throw new OutOfBoundsError(report);
  }

  const lines: string[] = [];
  for (const h of o.header ?? []) lines.push(`; ${h.replace(/[\r\n]+/g, ' ')}`);
  const dwell = () => {
    if (o.penDwell > 0) lines.push(`G4 P${fmt(o.penDwell)}`);
  };
  const penUp = () => {
    lines.push(`G0 Z${fmt(o.penUpZ)}`);
    dwell();
  };
  const penDown = () => {
    lines.push(`G0 Z${fmt(o.penDownZ)}`);
    dwell();
  };
  const travel = (p: Point) => {
    lines.push(
      o.travelUseG1
        ? `G1 X${fmt(p.x)} Y${fmt(p.y)} F${fmt(o.travelFeed)}`
        : `G0 X${fmt(p.x)} Y${fmt(p.y)}`,
    );
  };

  lines.push('G21 G90');
  penUp();
  for (const s of strokes) {
    if (s.length === 0) continue;
    travel(s[0]);
    penDown();
    for (let i = 1; i < s.length; i++) {
      lines.push(`G1 X${fmt(s[i].x)} Y${fmt(s[i].y)}${i === 1 ? ` F${fmt(o.drawFeed)}` : ''}`);
    }
    penUp();
  }
  travel({ x: 0, y: 0 });
  return lines;
}

/** Rough job duration from feeds and dwells (ignores acceleration). Seconds. */
export function estimateSeconds(
  drawLength: number,
  travelLength: number,
  strokeCount: number,
  o: Pick<Settings, 'drawFeed' | 'travelFeed' | 'penDwell'>,
): number {
  return (drawLength / o.drawFeed) * 60 + (travelLength / o.travelFeed) * 60 + strokeCount * 2 * o.penDwell;
}
