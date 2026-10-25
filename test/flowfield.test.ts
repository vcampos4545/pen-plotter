import { describe, expect, it } from 'vitest';
import { FLOW_STOP, flowField, type FlowOptions } from '../src/flowfield';
import { insideRect, polylineLength, type Polyline } from '../src/geometry';

const area = { minX: 10, minY: 10, maxX: 130, maxY: 100 };
const o: FlowOptions = { seed: 3, scale: 60, curl: 1.5, spacing: 4, step: 0.5, maxLength: 300, minLength: 5 };

/** Smallest distance between points of different lines, by brute force. */
function minGap(lines: Polyline[]): number {
  let best = Infinity;
  for (let a = 0; a < lines.length; a++) {
    for (let b = a + 1; b < lines.length; b++) {
      for (const p of lines[a]) for (const q of lines[b]) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    }
  }
  return best;
}

describe('flowField', () => {
  const lines = flowField(area, o);

  it('is deterministic for a seed and changes with it', () => {
    expect(flowField(area, o)).toEqual(lines);
    expect(flowField(area, { ...o, seed: 4 })).not.toEqual(lines);
  });

  it('fills the area with lines inside it', () => {
    expect(lines.length).toBeGreaterThan(20);
    for (const l of lines) for (const p of l) expect(insideRect(p, area)).toBe(true);
    const total = lines.reduce((s, l) => s + polylineLength(l), 0);
    // Evenly spaced lines cover about area / spacing of length.
    const ideal = ((area.maxX - area.minX) * (area.maxY - area.minY)) / o.spacing;
    expect(total).toBeGreaterThan(ideal * 0.6);
    expect(total).toBeLessThan(ideal * 1.6);
  });

  it('keeps lines apart and within their length limits', () => {
    expect(minGap(lines)).toBeGreaterThanOrEqual(o.spacing * FLOW_STOP - 1e-9);
    for (const l of lines) {
      expect(polylineLength(l)).toBeGreaterThanOrEqual(o.minLength - 1e-9);
      expect(polylineLength(l)).toBeLessThanOrEqual(o.maxLength + o.step);
    }
  });

  it('does not let a line curl back onto itself', () => {
    const swirly = flowField(area, { ...o, curl: 6, scale: 30 });
    const stop = o.spacing * FLOW_STOP;
    const skip = Math.ceil(stop / o.step) + 2;
    for (const l of swirly) {
      for (let i = 0; i < l.length; i++) {
        for (let j = i + skip + 1; j < l.length; j++) {
          expect(Math.hypot(l[i].x - l[j].x, l[i].y - l[j].y)).toBeGreaterThanOrEqual(stop - 1e-9);
        }
      }
    }
  });
});
