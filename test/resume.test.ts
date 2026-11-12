import { describe, expect, it } from 'vitest';
import { generateGcode } from '../src/gcode';
import { findExecutedCount, resumePreamble, trackProgram } from '../src/resume';

const opts = { drawFeed: 3000, travelFeed: 6000, travelUseG1: false, penUpZ: 5, penDownZ: 0, penDwell: 0.15 };
const gcode = generateGcode(
  [
    [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
    ],
    [
      { x: 40, y: 40 },
      { x: 50, y: 50 },
    ],
  ],
  opts,
);
// 0 G21 G90 | 1 G0 Z5 | 2 G4 | 3 G0 X10 Y10 | 4 G0 Z0 | 5 G4 | 6 G1 X20 Y10 F3000 | 7 G1 X20 Y20
// 8 G0 Z5 | 9 G4 | 10 G0 X40 Y40 | 11 G0 Z0 | 12 G4 | 13 G1 X50 Y50 F3000 | 14 G0 Z5 | 15 G4 | 16 G0 X0 Y0

describe('trackProgram', () => {
  it('records the modal state before every line', () => {
    expect(gcode[6]).toBe('G1 X20 Y10 F3000');
    const pts = trackProgram(gcode)!;
    expect(pts).toHaveLength(gcode.length + 1);
    expect(pts[0]).toEqual({});
    expect(pts[3]).toEqual({ z: 5 });
    expect(pts[7]).toEqual({ x: 20, y: 10, z: 0, feed: 3000 });
    expect(pts[13]).toEqual({ x: 40, y: 40, z: 0, feed: 3000 });
    expect(pts[gcode.length]).toMatchObject({ x: 0, y: 0, z: 5 });
  });

  it('ignores comments and dwell times, and refuses relative or offset G-code', () => {
    expect(trackProgram(['; X99 Y99', 'G0 X1 Y2 (Z9)', 'G4 P0.5'])).toEqual([{}, {}, { x: 1, y: 2 }, { x: 1, y: 2 }]);
    expect(trackProgram(['G91', 'G0 X1'])).toBeUndefined();
    expect(trackProgram(['G20'])).toBeUndefined();
    expect(trackProgram(['G10 L20 P0 X0 Y0'])).toBeUndefined();
  });
});

describe('findExecutedCount', () => {
  const pts = trackProgram(gcode)!;

  it('finds the line the machine stopped after, between acked and sent', () => {
    // Acked through line 6, lines 7..9 in flight, machine at the end of line 7.
    expect(findExecutedCount(pts, 7, 10, { x: 20, y: 20 })).toBe(8);
    // Only the acked lines ran.
    expect(findExecutedCount(pts, 7, 10, { x: 20, y: 10 })).toBe(7);
    // All in-flight lines ran.
    expect(findExecutedCount(pts, 9, 11, { x: 40, y: 40 })).toBe(11);
  });

  it('prefers the earliest match so it never skips drawing', () => {
    // Lines 8 (pen up) and 9 (dwell) do not move X/Y: repeat them rather than skip.
    expect(findExecutedCount(pts, 8, 10, { x: 20, y: 20 })).toBe(8);
  });

  it('allows for step rounding but not for a different spot', () => {
    expect(findExecutedCount(pts, 7, 9, { x: 20.0125, y: 19.99 })).toBe(8);
    expect(findExecutedCount(pts, 7, 9, { x: 0, y: 0 })).toBeUndefined();
    // Position never moves backwards past what was acknowledged.
    expect(findExecutedCount(pts, 11, 13, { x: 20, y: 20 })).toBeUndefined();
  });

  it('matches anywhere before the first X/Y move', () => {
    expect(findExecutedCount(pts, 0, 3, { x: 123, y: 45 })).toBe(0);
  });
});

describe('resumePreamble', () => {
  it('lifts the pen, travels back, lowers it and restores the feed', () => {
    const pts = trackProgram(gcode)!;
    expect(resumePreamble(pts[7], opts)).toEqual(['G21 G90', 'G0 Z5', 'G4 P0.15', 'G0 X20 Y10', 'G0 Z0', 'G4 P0.15', 'F3000']);
  });

  it('leaves the pen up when the program had it up, and honours G1 travel', () => {
    const pts = trackProgram(gcode)!;
    expect(resumePreamble(pts[10], { ...opts, penDwell: 0, travelUseG1: true })).toEqual([
      'G21 G90',
      'G0 Z5',
      'G1 X20 Y20 F6000',
      'F3000',
    ]);
    expect(resumePreamble(pts[0], opts)).toEqual(['G21 G90', 'G0 Z5', 'G4 P0.15']);
  });
});
