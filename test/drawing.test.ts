import { describe, expect, it } from 'vitest';
import { Drawing, fromJSON, fromSVG, loadDrawing, parsePathData, saveDrawing, toJSON, toSVG, type Stroke } from '../src/drawing';

const s = (id: string, points: Array<[number, number]>, kind: Stroke['kind'] = 'freehand'): Stroke => ({
  id,
  kind,
  points: points.map(([x, y]) => ({ x, y })),
});

describe('Drawing history', () => {
  it('undo/redo across add, remove and clear', () => {
    const d = new Drawing();
    let changes = 0;
    d.onChange(() => changes++);
    d.add(s('a', [[1, 1]]));
    d.add(s('b', [[2, 2]]));
    d.remove(['a']);
    expect(d.strokes.map((x) => x.id)).toEqual(['b']);
    d.clear();
    expect(d.strokes).toHaveLength(0);
    d.undo();
    expect(d.strokes.map((x) => x.id)).toEqual(['b']);
    d.undo();
    expect(d.strokes.map((x) => x.id)).toEqual(['a', 'b']);
    d.redo();
    expect(d.strokes.map((x) => x.id)).toEqual(['b']);
    // A new edit drops the redo stack.
    d.add(s('c', [[3, 3]]));
    expect(d.canRedo).toBe(false);
    expect(changes).toBe(8);
  });

  it('addMany is one undo step', () => {
    const d = new Drawing([s('a', [[1, 1]])]);
    d.addMany([s('b', [[2, 2]]), s('c', [[3, 3]])]);
    expect(d.strokes.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    d.undo();
    expect(d.strokes.map((x) => x.id)).toEqual(['a']);
    d.addMany([]);
    expect(d.canRedo).toBe(true);
  });

  it('removing nothing is not an undo step', () => {
    const d = new Drawing([s('a', [[1, 1]])]);
    d.remove(['zzz']);
    expect(d.canUndo).toBe(false);
  });
});

describe('JSON', () => {
  it('round trips', () => {
    const strokes = [s('a', [[1.23456, 2], [3, 4]], 'line'), s('b', [[5, 6]])];
    const back = fromJSON(JSON.parse(JSON.stringify(toJSON(strokes, 400, 400))));
    expect(back.map((x) => [x.kind, x.points])).toEqual([
      ['line', [{ x: 1.235, y: 2 }, { x: 3, y: 4 }]],
      ['freehand', [{ x: 5, y: 6 }]],
    ]);
  });

  it('rejects junk', () => {
    expect(() => fromJSON({ nope: 1 })).toThrow();
    expect(fromJSON({ strokes: [{ points: [[1, 'x'], [2, 2]] }] })[0].points).toEqual([{ x: 2, y: 2 }]);
  });

  it('persists through storage', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveDrawing([s('a', [[1, 2], [3, 4]], 'rect')], 400, 400, storage as Storage);
    expect(loadDrawing(storage as Storage)[0].points).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
  });
});

describe('SVG', () => {
  it('round trips our own export', () => {
    const strokes = [s('a', [[10, 20], [30, 40], [50, 20]]), s('b', [[100, 100], [200, 100]], 'line')];
    const svg = toSVG(strokes, 400, 300);
    expect(svg).toContain('width="400mm"');
    expect(svg).toContain('viewBox="0 0 400 300"');
    const back = fromSVG(svg);
    expect(back.map((x) => [x.kind, x.points])).toEqual(strokes.map((x) => [x.kind, x.points]));
  });

  it('imports line, polygon and straight paths with unit scaling', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20cm" height="10cm" viewBox="0 0 100 50">
      <line x1="0" y1="0" x2="10" y2="10"/>
      <polygon points="0,0 10,0 10,10"/>
      <path d="M 1 1 h 2 v 2 Z m 10 10 l 1 1 2 2"/>
    </svg>`;
    const out = fromSVG(svg);
    expect(out).toHaveLength(4);
    // viewBox 100 wide on 200 mm => 2 mm per unit.
    expect(out[0].points).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 20 },
    ]);
    expect(out[1].points).toHaveLength(4);
    expect(out[2].points.map((p) => [p.x, p.y])).toEqual([
      [2, 2],
      [6, 2],
      [6, 6],
      [2, 2],
    ]);
    expect(out[3].points.map((p) => [p.x, p.y])).toEqual([
      [22, 22],
      [24, 24],
      [28, 28],
    ]);
  });

  it('rejects curves and non-SVG', () => {
    expect(() => parsePathData('M0 0 C 1 1 2 2 3 3')).toThrow(/Unsupported/);
    expect(() => fromSVG('hello')).toThrow();
  });
});
