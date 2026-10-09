import { distToSegment, type Polyline } from './geometry';

/**
 * Ramer-Douglas-Peucker polyline simplification. Keeps the endpoints and drops
 * any interior point that lies within `tolerance` mm of the simplified line.
 * Iterative so very long freehand strokes cannot blow the stack.
 */
export function simplifyRDP(points: Polyline, tolerance: number): Polyline {
  if (points.length <= 2 || tolerance <= 0) return points.slice();

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxDist = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = distToSegment(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: Polyline = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Drop consecutive points closer than `minDist` (keeps the last point). */
export function dedupe(points: Polyline, minDist = 1e-3): Polyline {
  if (points.length <= 1) return points.slice();
  const out: Polyline = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const prev = out[out.length - 1];
    if (Math.hypot(p.x - prev.x, p.y - prev.y) >= minDist) out.push(p);
    else if (i === points.length - 1 && out.length > 1) out[out.length - 1] = p;
  }
  return out;
}
