import { groundSize, type GeoBox, type LatLon } from './terrain';

// OpenStreetMap features from the public Overpass API: the query for a box,
// parsing the JSON reply into lon/lat lines, and plain-language errors. Pure so
// it can be unit tested; the browser-only request lives in osm-fetch.ts.

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
/** Server-side time limit put in the query, seconds. */
export const OVERPASS_TIMEOUT = 90;

export type StreetLayer = 'major' | 'minor' | 'paths' | 'rail' | 'waterways' | 'water' | 'buildings' | 'parks';
export const STREET_LAYERS: StreetLayer[] = ['major', 'minor', 'paths', 'rail', 'waterways', 'water', 'buildings', 'parks'];

/** One tag test. `match` is a regex source used both in the Overpass query and here; without it any value but "no" matches. */
interface TagRule {
  key: string;
  match?: string;
  /** Also fetch multipolygon relations, not just ways. */
  relations?: boolean;
  /** Leave out features whose tag `key` matches this regex source. */
  unless?: { key: string; match: string };
}

interface LayerInfo {
  label: string;
  rules: TagRule[];
  /** Longest box side, km, this layer may be fetched for. Dense layers get small limits to keep requests modest. */
  maxSpanKm: number;
}

export const LAYER_INFO: Record<StreetLayer, LayerInfo> = {
  major: {
    label: 'Major roads',
    rules: [{ key: 'highway', match: '^(motorway|trunk|primary|secondary|tertiary)(_link)?$' }],
    maxSpanKm: 25,
  },
  minor: {
    label: 'Minor roads',
    rules: [{ key: 'highway', match: '^(residential|unclassified|living_street|service|road)$' }],
    maxSpanKm: 8,
  },
  paths: {
    label: 'Paths',
    rules: [{ key: 'highway', match: '^(footway|path|cycleway|pedestrian|steps|bridleway|track)$' }],
    maxSpanKm: 5,
  },
  rail: {
    label: 'Railways',
    // Yards and sidings would plot as solid blocks of ink.
    rules: [
      {
        key: 'railway',
        match: '^(rail|light_rail|tram|narrow_gauge|monorail|funicular)$',
        unless: { key: 'service', match: '^(yard|siding|spur)$' },
      },
    ],
    maxSpanKm: 25,
  },
  waterways: {
    label: 'Rivers and streams',
    rules: [{ key: 'waterway', match: '^(river|stream|canal)$' }],
    maxSpanKm: 25,
  },
  water: {
    label: 'Coast and water',
    rules: [
      { key: 'natural', match: '^coastline$' },
      { key: 'natural', match: '^water$', relations: true },
      { key: 'waterway', match: '^riverbank$', relations: true },
    ],
    maxSpanKm: 25,
  },
  buildings: { label: 'Buildings', rules: [{ key: 'building', relations: true }], maxSpanKm: 3 },
  parks: { label: 'Parks', rules: [{ key: 'leisure', match: '^park$', relations: true }], maxSpanKm: 15 },
};

/** Which layer, of those asked for, a feature with these tags belongs to. */
export function classify(tags: Record<string, string> | undefined, layers: StreetLayer[]): StreetLayer | undefined {
  if (!tags) return undefined;
  return layers.find((layer) =>
    LAYER_INFO[layer].rules.some((r) => {
      const v = tags[r.key];
      if (v === undefined || !(r.match ? new RegExp(r.match).test(v) : v !== 'no')) return false;
      const u = r.unless && tags[r.unless.key];
      return !(u && new RegExp(r.unless!.match).test(u));
    }),
  );
}

/**
 * Overpass wants longitudes in -180..180, but a box drawn after panning around
 * the world may sit a whole turn away. Returns the box shifted into range and
 * the shift to add back to every longitude in the reply.
 */
export function normalizeBox(box: GeoBox): { box: GeoBox; shift: number } {
  const shift = Math.floor((box.west + 180) / 360) * 360;
  const b = { ...box, west: box.west - shift, east: box.east - shift };
  if (b.east > 180) throw new Error('The box crosses the 180° meridian. Select an area on one side of it.');
  return { box: b, shift };
}

const coord = (n: number) => n.toFixed(6);

/** One Overpass QL request for every feature of `layers` touching the box (already normalized). */
export function buildQuery(box: GeoBox, layers: StreetLayer[]): string {
  const bbox = [box.south, box.west, box.north, box.east].map(coord).join(',');
  const lines: string[] = [];
  for (const layer of layers) {
    for (const r of LAYER_INFO[layer].rules) {
      const filter =
        (r.match ? `["${r.key}"~"${r.match}"]` : `["${r.key}"]["${r.key}"!="no"]`) + (r.unless ? `["${r.unless.key}"!~"${r.unless.match}"]` : '');
      lines.push(`  way${filter};`);
      if (r.relations) lines.push(`  relation${filter}["type"="multipolygon"];`);
    }
  }
  return `[out:json][timeout:${OVERPASS_TIMEOUT}][bbox:${bbox}];\n(\n${lines.join('\n')}\n);\nout geom qt;`;
}

export interface AreaCheck {
  ok: boolean;
  /** Longer side of the box, km. */
  spanKm: number;
  /** Largest span the chosen layers allow, km. */
  limitKm: number;
  /** The layer setting the limit. */
  limitedBy: StreetLayer;
}

/** Refuse boxes too big for the densest chosen layer, so one request stays a modest download. */
export function checkArea(box: GeoBox, layers: StreetLayer[]): AreaCheck {
  const g = groundSize(box);
  const spanKm = Math.max(g.width, g.height) / 1000;
  let limitedBy: StreetLayer = layers[0] ?? 'major';
  for (const l of layers) if (LAYER_INFO[l].maxSpanKm < LAYER_INFO[limitedBy].maxSpanKm) limitedBy = l;
  const limitKm = LAYER_INFO[limitedBy].maxSpanKm;
  return { ok: spanKm <= limitKm, spanKm, limitKm, limitedBy };
}

export interface OsmLine {
  layer: StreetLayer;
  points: LatLon[];
}

interface OverpassNode {
  lat: number;
  lon: number;
}
interface OverpassMember {
  type: string;
  ref: number;
  geometry?: Array<OverpassNode | null>;
}
interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<OverpassNode | null>;
  members?: OverpassMember[];
}

function toPoints(geometry: Array<OverpassNode | null> | undefined, shift: number): LatLon[] {
  const out: LatLon[] = [];
  for (const n of geometry ?? []) {
    if (n && Number.isFinite(n.lat) && Number.isFinite(n.lon)) out.push({ lat: n.lat, lon: n.lon + shift });
  }
  return out;
}

/**
 * Turn an `out geom` reply into lines, one per way. Relations contribute their
 * member ways (outer and inner rings alike); a way that is both fetched on its
 * own and a member of a fetched relation is kept once.
 */
export function parseOverpass(json: unknown, layers: StreetLayer[], shift = 0): OsmLine[] {
  const reply = json as { elements?: unknown; remark?: unknown } | null;
  if (!reply || typeof reply !== 'object' || !Array.isArray(reply.elements)) {
    throw new Error('The Overpass server sent a reply that is not map data.');
  }
  // The server reports timeouts and memory limits inside a 200 reply.
  if (typeof reply.remark === 'string' && /error/i.test(reply.remark)) {
    throw new Error(`The Overpass server gave up on this request: ${reply.remark.trim()} Try a smaller area or fewer layers.`);
  }
  const out: OsmLine[] = [];
  const seen = new Set<number>();
  const add = (layer: StreetLayer, id: number, geometry: OverpassMember['geometry']) => {
    if (seen.has(id)) return;
    seen.add(id);
    const points = toPoints(geometry, shift);
    if (points.length >= 2) out.push({ layer, points });
  };
  for (const el of reply.elements as OverpassElement[]) {
    const layer = classify(el?.tags, layers);
    if (!layer) continue;
    if (el.type === 'way') add(layer, el.id, el.geometry);
    else if (el.type === 'relation') {
      for (const m of el.members ?? []) if (m.type === 'way') add(layer, m.ref, m.geometry);
    }
  }
  return out;
}

/** A failed request, with whether pressing Retry later is likely to help. */
export class OverpassError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message);
  }
}

/** Explain a non-OK HTTP reply from Overpass. `body` is the response text, which for 400 holds the parse error. */
export function overpassError(status: number, body = ''): OverpassError {
  if (status === 429) {
    return new OverpassError(
      'The Overpass server is limiting requests from this address (HTTP 429). Wait a minute or two, then press Retry.',
      true,
    );
  }
  if (status === 504 || status === 503 || status === 502) {
    return new OverpassError(
      `The Overpass server is busy or the request took too long (HTTP ${status}). Try again in a minute, or select a smaller area.`,
      true,
    );
  }
  if (status === 400) {
    const detail = body
      .replace(/<[^>]*>/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /error/i.test(l));
    return new OverpassError(`The Overpass server rejected the request (HTTP 400)${detail ? `: ${detail}` : '.'}`, false);
  }
  return new OverpassError(`The Overpass server returned HTTP ${status}.`, status >= 500);
}
