import { drawableRect, type Polyline } from './geometry';
import { checkBounds, estimateSeconds, generateGcode, toMachine, type BoundsReport } from './gcode';
import { planStrokes, type PlanResult } from './planner';
import type { Settings } from './settings';
import { dedupe, simplifyRDP } from './simplify';
import type { Stroke } from './drawing';

export interface Job {
  /** Planned strokes in machine coordinates, in drawing order. */
  plan: PlanResult;
  bounds: BoundsReport;
  /** Empty when the drawing is out of bounds or empty. */
  gcode: string[];
  estimatedSeconds: number;
  /** Points sent to the machine after simplification. */
  pointCount: number;
}

/** Flatten + simplify: every stroke becomes a machine-ready polyline in paper mm. */
export function flattenStrokes(strokes: Stroke[], simplifyTolerance: number): Polyline[] {
  return strokes
    .map((s) => (s.kind === 'freehand' ? simplifyRDP(dedupe(s.points), simplifyTolerance) : dedupe(s.points)))
    .filter((p) => p.length > 0);
}

/** flatten -> simplify -> to machine space -> bounds check -> optimize -> G-code. */
export function buildJob(strokes: Stroke[], s: Settings): Job {
  const machine = flattenStrokes(strokes, s.simplifyTolerance).map((pl) => pl.map((p) => toMachine(p, s)));
  // The margin is the same on every side, so the drawable rect is identical in
  // paper and machine space.
  const area = drawableRect(s.paperWidth, s.paperHeight, s.margin);
  const bounds = checkBounds(machine, area);
  const plan = planStrokes(machine, {
    origin: { x: 0, y: 0 },
    mergeTolerance: s.mergeTolerance,
    timeLimitMs: s.optimizeTimeMs,
  });
  const pointCount = plan.strokes.reduce((n, pl) => n + pl.length, 0);
  const gcode =
    bounds.ok && plan.strokes.length > 0
      ? generateGcode(plan.strokes, {
          ...s,
          bounds: area,
          header: [
            `pen plotter job: ${plan.strokes.length} strokes, ${pointCount} points`,
            `draw ${plan.drawLength.toFixed(0)} mm, pen-up travel ${plan.travelAfter.toFixed(0)} mm`,
          ],
        })
      : [];
  return {
    plan,
    bounds,
    gcode,
    estimatedSeconds: estimateSeconds(plan.drawLength, plan.travelAfter, plan.strokes.length, s),
    pointCount,
  };
}
