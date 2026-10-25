import { dist, type Point, type Polyline, type Rect } from './geometry';
import { LAYER_INFO, STREET_LAYERS, type OsmLine, type StreetLayer } from './osm';
import { dedupe, simplifyRDP } from './simplify';
import { orderLines } from './stipple';
import { groundSize, type GeoBox, type LatLon } from './terrain';
import { filterFragments, fitToArea, type Placement } from './topo';

// OpenStreetMap lines -> pen strokes in paper mm: projected into the box's
// place on the sheet, joined where ways meet, clipped to the box and filtered.

export interface StreetsOptions {
  layers: Record<StreetLayer, boolean>;
  /** Draw major roads as two parallel lines. */
  doubleMajor: boolean;
  /** Distance between the two lines of a major road, mm. */
  doubleGap: number;
  /** Ramer-Douglas-Peucker tolerance on the paper, mm. */
  simplify: number;
  /** Fragments shorter than this on the paper are dropped, mm. */
  minLength: number;
}

export const DEFAULT_STREETS_OPTIONS: StreetsOptions = {
  layers: { major: true, minor: true, paths: false, rail: true, waterways: true, water: true, buildings: false, parks: false },
  doubleMajor: false,
  doubleGap: 0.8,
  simplify: 0.05,
  minLength: 1,
};

const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return v !== '' && v !== null && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Fill gaps from the defaults and clamp every number to a usable range. */
export function sanitizeStreetsOptions(raw: unknown): StreetsOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_STREETS_OPTIONS;
  const l = (o.layers && typeof o.layers === 'object' ? o.layers : {}) as Record<string, unknown>;
  const layers = { ...d.layers };
  for (const k of STREET_LAYERS) if (typeof l[k] === 'boolean') layers[k] = l[k];
  return {
    layers,
    doubleMajor: typeof o.doubleMajor === 'boolean' ? o.doubleMajor : d.doubleMajor,
    doubleGap: num(o.doubleGap, d.doubleGap, 0.2, 5),
    simplify: num(o.simplify, d.simplify, 0, 5),
    minLength: num(o.minLength, d.minLength, 0, 100),
  };
}

export const enabledLayers = (o: StreetsOptions): StreetLayer[] => STREET_LAYERS.filter((l) => o.layers[l]);

/** Where a box lands on paper: fitted inside `area` at its true ground proportions, like Topo. */
export const placeBox = (box: GeoBox, area: Rect): Placement => fitToArea(groundSize(box), area);

/** Lon/lat to paper mm inside `place`; north up, east-west scaled by the cosine of the middle latitude (through the placement's shape). */
export function projector(box: GeoBox, place: Placement): (p: LatLon) => Point {
  const sx = place.width / (box.east - box.west);
  const sy = place.height / (box.north - box.south);
  return (p) => ({ x: place.x + (p.lon - box.west) * sx, y: place.y + (box.north - p.lat) * sy });
}

/** Liang-Barsky: the parameter range of a→b inside r, or undefined when it misses. */
function clipSegment(a: Point, b: Point, r: Rect): [number, number] | undefined {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, a.x - r.minX],
    [dx, r.maxX - a.x],
    [-dy, a.y - r.minY],
    [dy, r.maxY - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return undefined;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return undefined;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return undefined;
        if (t < t1) t1 = t;
      }
    }
  }
  return [t0, t1];
}

const lerp = (a: Point, b: Point, t: number): Point => (t === 0 ? a : t === 1 ? b : { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** The parts of a polyline inside r. A line that leaves and re-enters becomes several. */
export function clipPolyline(line: Polyline, r: Rect): Polyline[] {
  const out: Polyline[] = [];
  let cur: Polyline | undefined;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const c = clipSegment(a, b, r);
    if (!c) {
      if (cur) out.push(cur);
      cur = undefined;
      continue;
    }
    const [t0, t1] = c;
    if (cur && t0 === 0) cur.push(lerp(a, b, t1));
    else {
      if (cur) out.push(cur);
      cur = [lerp(a, b, t0), lerp(a, b, t1)];
    }
    if (t1 < 1) {
      out.push(cur);
      cur = undefined;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const key = (p: Point) => `${p.x},${p.y}`;
const isClosed = (l: Polyline) => l.length > 2 && dist(l[0], l[l.length - 1]) === 0;

/**
 * Join lines that share an endpoint into longer ones so the pen lifts less.
 * Ways in OSM that meet share a node, so their projected ends are identical.
 * Where several lines meet, the chain continues along the straightest one.
 * Closed rings are left as they are.
 */
export function joinLines(lines: Polyline[]): Polyline[] {
  const ends = new Map<string, number[]>();
  const used = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    if (l.length < 2 || isClosed(l)) return;
    for (const e of [2 * i, 2 * i + 1]) {
      const k = key(e & 1 ? l[l.length - 1] : l[0]);
      const list = ends.get(k);
      if (list) list.push(e);
      else ends.set(k, [e]);
    }
  });
  // Grow `chain` from its last point for as long as some unused line starts or ends there.
  const extend = (chain: Polyline) => {
    for (;;) {
      if (isClosed(chain)) return;
      const tail = chain[chain.length - 1];
      const before = chain[chain.length - 2];
      const dx = tail.x - before.x;
      const dy = tail.y - before.y;
      const len = Math.hypot(dx, dy) || 1;
      let best = -1;
      let bestScore = -Infinity;
      for (const e of ends.get(key(tail)) ?? []) {
        if (used[e >> 1]) continue;
        const l = lines[e >> 1];
        const next = e & 1 ? l[l.length - 2] : l[1];
        const nx = next.x - tail.x;
        const ny = next.y - tail.y;
        const score = (dx * nx + dy * ny) / (len * (Math.hypot(nx, ny) || 1));
        if (score > bestScore) {
          bestScore = score;
          best = e;
        }
      }
      if (best < 0) return;
      used[best >> 1] = 1;
      const l = lines[best >> 1];
      const add = best & 1 ? l.slice().reverse() : l;
      for (let k = 1; k < add.length; k++) chain.push(add[k]);
    }
  };
  const out: Polyline[] = [];
  lines.forEach((l, i) => {
    if (used[i]) return;
    used[i] = 1;
    if (l.length < 2 || isClosed(l)) {
      out.push(l);
      return;
    }
    const chain = l.slice();
    extend(chain);
    chain.reverse();
    extend(chain);
    out.push(chain.reverse());
  });
  return out;
}

/** Miters longer than this many offsets are cut short, so sharp corners do not spike. */
const MITER_LIMIT = 3;

/** A parallel copy of a polyline `d` mm to one side (negative for the other). Closed rings stay closed. */
export function offsetPolyline(line: Polyline, d: number): Polyline {
  const n = line.length;
  if (n < 2) return line.slice();
  const closed = isClosed(line);
  const normals: Point[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const dx = line[i + 1].x - line[i].x;
    const dy = line[i + 1].y - line[i].y;
    const len = Math.hypot(dx, dy) || 1;
    normals.push({ x: -dy / len, y: dx / len });
  }
  const out: Polyline = [];
  for (let k = 0; k < n; k++) {
    let prev = k > 0 ? normals[k - 1] : closed ? normals[n - 2] : undefined;
    let next = k < n - 1 ? normals[k] : closed ? normals[0] : undefined;
    prev ??= next!;
    next ??= prev;
    let mx = prev.x + next.x;
    let my = prev.y + next.y;
    const mlen = Math.hypot(mx, my);
    if (mlen < 1e-9) {
      // A full reversal: no sensible miter, step straight out from the incoming side.
      mx = prev.x;
      my = prev.y;
    } else {
      mx /= mlen;
      my /= mlen;
    }
    const scale = Math.min(MITER_LIMIT, 1 / Math.max(1e-9, mx * prev.x + my * prev.y));
    out.push({ x: line[k].x + mx * d * scale, y: line[k].y + my * d * scale });
  }
  return out;
}

const rectOf = (p: Placement): Rect => ({ minX: p.x, minY: p.y, maxX: p.x + p.width, maxY: p.y + p.height });

export interface StreetsResult {
  lines: Polyline[];
  /** Strokes per layer, after joining, clipping and dropping fragments. */
  counts: Partial<Record<StreetLayer, number>>;
  /** Fragments dropped for being shorter than minLength. */
  dropped: number;
  place: Placement;
}

/** Project, join, simplify, (double), clip to the box and filter every enabled layer of `features`. */
export function buildStreets(features: OsmLine[], box: GeoBox, area: Rect, opts: StreetsOptions): StreetsResult {
  const place = placeBox(box, area);
  const clip = rectOf(place);
  const project = projector(box, place);
  const counts: Partial<Record<StreetLayer, number>> = {};
  const all: Polyline[] = [];
  let dropped = 0;
  for (const layer of enabledLayers(opts)) {
    const projected = features.filter((f) => f.layer === layer).map((f) => dedupe(f.points.map(project)));
    if (projected.length === 0) continue;
    let lines = joinLines(projected).map((l) => simplifyRDP(l, opts.simplify));
    if (layer === 'major' && opts.doubleMajor) {
      const half = opts.doubleGap / 2;
      lines = lines.flatMap((l) => [offsetPolyline(l, half), offsetPolyline(l, -half)]);
    }
    const clipped = lines.flatMap((l) => clipPolyline(l, clip));
    const kept = filterFragments(clipped, opts.minLength);
    dropped += kept.dropped;
    if (kept.kept.length) counts[layer] = kept.kept.length;
    all.push(...kept.kept);
  }
  return { lines: orderLines(all, place), counts, dropped, place };
}

/** "Major roads 12 · Railways 3" for the status line. */
export const describeCounts = (counts: StreetsResult['counts']): string =>
  STREET_LAYERS.filter((l) => counts[l])
    .map((l) => `${LAYER_INFO[l].label} ${counts[l]!.toLocaleString()}`)
    .join(' · ');
