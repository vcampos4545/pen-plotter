import type { Point, Polyline } from './geometry';

/** Max distance between a true curve and its flattened chords, in mm. */
export const DEFAULT_CHORD_TOLERANCE = 0.05;

export function lineShape(a: Point, b: Point): Polyline {
  return [{ ...a }, { ...b }];
}

/** Axis-aligned rectangle from two opposite corners, closed (first point repeated). */
export function rectShape(a: Point, b: Point): Polyline {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
    { x: minX, y: minY },
  ];
}

/**
 * Ellipse inscribed in the box spanned by two opposite corners, flattened into
 * a closed polyline whose chords stay within `tolerance` mm of the curve.
 */
export function ellipseShape(a: Point, b: Point, tolerance = DEFAULT_CHORD_TOLERANCE): Polyline {
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2;
  const ry = Math.abs(b.y - a.y) / 2;
  const r = Math.max(rx, ry);
  if (r === 0) return [{ x: cx, y: cy }];

  // Chord sagitta for angle step t on radius r is r * (1 - cos(t / 2)).
  const step = 2 * Math.acos(Math.max(-1, 1 - Math.min(tolerance, r) / r));
  const segments = Math.min(720, Math.max(16, Math.ceil((2 * Math.PI) / step)));
  const out: Polyline = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * 2 * Math.PI;
    out.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  // Close exactly so endpoint merging sees a closed loop.
  out[out.length - 1] = { ...out[0] };
  return out;
}

/** Square/circle constraint used when Shift is held: make the box equal-sided. */
export function constrainSquare(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: a.x + Math.sign(dx || 1) * side, y: a.y + Math.sign(dy || 1) * side };
}

/** Snap a line end to the nearest 15 degree angle (Shift on the line tool). */
export function constrainAngle(a: Point, b: Point, stepDeg = 15): Point {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const step = (stepDeg * Math.PI) / 180;
  const angle = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / step) * step;
  return { x: a.x + len * Math.cos(angle), y: a.y + len * Math.sin(angle) };
}
