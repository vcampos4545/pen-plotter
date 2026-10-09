// Basic 2D geometry. All coordinates are millimeters.

export interface Point {
  x: number;
  y: number;
}

export type Polyline = Point[];

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function polylineLength(points: Polyline): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/** Shortest distance from p to the segment a-b. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToPolyline(p: Point, points: Polyline): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) return dist(p, points[0]);
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    best = Math.min(best, distToSegment(p, points[i - 1], points[i]));
  }
  return best;
}

export function clampPoint(p: Point, r: Rect): Point {
  return {
    x: Math.min(r.maxX, Math.max(r.minX, p.x)),
    y: Math.min(r.maxY, Math.max(r.minY, p.y)),
  };
}

export function insideRect(p: Point, r: Rect, eps = 1e-6): boolean {
  return p.x >= r.minX - eps && p.x <= r.maxX + eps && p.y >= r.minY - eps && p.y <= r.maxY + eps;
}

/** Drawable rectangle of a sheet: the paper inset by the margin on every side. */
export function drawableRect(width: number, height: number, margin: number): Rect {
  return { minX: margin, minY: margin, maxX: width - margin, maxY: height - margin };
}
