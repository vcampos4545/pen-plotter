import { fmt } from './gcode';

// Picking up a job after the WebSocket dropped mid-stream.
//
// What FluidNC does on a drop (checked against v4.1.1 WSChannel.cpp / Serial.cpp):
// the channel is removed and its unparsed input discarded, but the planner keeps
// running. So every line that got an "ok" (parsed and queued) still executes, and
// of the lines sent but not yet acknowledged some prefix may have arrived and run.
// Once the machine is Idle again, its position tells us how far it got: the job
// stopped after exactly the lines whose end point matches where the pen is.

/** Modal state after some prefix of the program. Undefined until a line sets it. */
export interface ProgramPoint {
  x?: number;
  y?: number;
  z?: number;
  feed?: number;
}

const WORD = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;

/**
 * points[i] is the state before line i runs (after lines 0..i-1), so
 * points.length === lines.length + 1. Returns undefined when the program uses
 * something the tracker does not model (relative moves, inches, offsets), in
 * which case a resume cannot be placed safely.
 */
export function trackProgram(lines: readonly string[]): ProgramPoint[] | undefined {
  const points: ProgramPoint[] = [{}];
  let cur: ProgramPoint = {};
  for (const raw of lines) {
    const s = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').toUpperCase();
    const next = { ...cur };
    let isDwell = false;
    for (const m of s.matchAll(WORD)) {
      const letter = m[1];
      const v = Number(m[2]);
      if (letter === 'G') {
        if (v === 4) isDwell = true;
        else if (v === 91 || v === 20 || v === 92 || v === 10 || v === 28 || v === 30 || v === 53) return undefined;
      } else if (letter === 'X') next.x = v;
      else if (letter === 'Y') next.y = v;
      else if (letter === 'Z') next.z = v;
      else if (letter === 'F') next.feed = v;
    }
    if (isDwell) {
      // G4's P is a time, and it moves nothing.
      next.x = cur.x;
      next.y = cur.y;
      next.z = cur.z;
    }
    cur = next;
    points.push(cur);
  }
  return points;
}

/**
 * How many leading lines ran, given that `acked` certainly did, at most `sent`
 * did, and the machine came to rest at work position (x, y). Only X/Y are
 * compared: the pen may have been lifted by hand since, and lines that change
 * only Z, F or dwell are harmless to repeat because the resume preamble sets the
 * pen anyway. When several counts fit, the smallest wins, so a revisited point
 * redraws a short piece rather than skipping one. Undefined when none fit (the
 * controller restarted, lost steps or was moved).
 */
export function findExecutedCount(
  points: readonly ProgramPoint[],
  acked: number,
  sent: number,
  pos: { x: number; y: number },
  tolerance = 0.05,
): number | undefined {
  const near = (a: number | undefined, b: number) => a === undefined || Math.abs(a - b) <= tolerance;
  for (let n = acked; n <= sent && n < points.length; n++) {
    const p = points[n];
    if (near(p.x, pos.x) && near(p.y, pos.y)) return n;
  }
  return undefined;
}

export interface PreambleOptions {
  penUpZ: number;
  penDwell: number;
  travelUseG1: boolean;
  travelFeed: number;
}

/**
 * Lines that put the machine back where the program expects it before line n:
 * absolute mm, pen up, travel to the last point, restore the pen height and the
 * feed. The job then continues with line n as if nothing happened.
 */
export function resumePreamble(at: ProgramPoint, o: PreambleOptions): string[] {
  const out = ['G21 G90', `G0 Z${fmt(o.penUpZ)}`];
  if (o.penDwell > 0) out.push(`G4 P${fmt(o.penDwell)}`);
  if (at.x !== undefined && at.y !== undefined) {
    out.push(
      o.travelUseG1
        ? `G1 X${fmt(at.x)} Y${fmt(at.y)} F${fmt(o.travelFeed)}`
        : `G0 X${fmt(at.x)} Y${fmt(at.y)}`,
    );
  }
  if (at.z !== undefined && at.z !== o.penUpZ) {
    out.push(`G0 Z${fmt(at.z)}`);
    if (o.penDwell > 0) out.push(`G4 P${fmt(o.penDwell)}`);
  }
  // A bare F word sets the modal feed for the G1 lines that follow without one.
  if (at.feed !== undefined) out.push(`F${fmt(at.feed)}`);
  return out;
}
