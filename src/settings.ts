// Machine and app settings, persisted to localStorage.

export type OriginCorner = 'bottom-left' | 'top-left';

export interface Settings {
  /** FluidNC host name or IP. */
  host: string;
  /** WebSocket port. FluidNC v4 serves it on the HTTP port (80); v3.x used 81. */
  port: number;
  /** WebSocket path. FluidNC registers its socket at "/". */
  path: string;

  /** Paper / work area, mm. */
  paperWidth: number;
  paperHeight: number;
  /** Blank border kept on every side, mm. */
  margin: number;
  /** Which paper corner is machine X0 Y0. Drawing is top-left based, like the screen. */
  originCorner: OriginCorner;

  /** Feed for pen-down G1 moves, mm/min. */
  drawFeed: number;
  /** Feed for pen-up moves, mm/min. Only applied when travelUseG1 is set. */
  travelFeed: number;
  /** Emit pen-up travel as G1 at travelFeed instead of G0 (which runs at max_rate). */
  travelUseG1: boolean;
  penUpZ: number;
  penDownZ: number;
  /** Dwell after every pen change, seconds. */
  penDwell: number;

  /** Freehand simplification tolerance, mm. */
  simplifyTolerance: number;
  /** Strokes whose endpoints are this close are drawn without lifting, mm. */
  mergeTolerance: number;
  /** Time budget for the 2-opt pass, ms. */
  optimizeTimeMs: number;
  /** Lines sent but not yet acknowledged with ok. */
  maxInFlight: number;
}

export const DEFAULT_SETTINGS: Settings = {
  host: 'plotter.local',
  port: 80,
  path: '/',
  paperWidth: 400,
  paperHeight: 400,
  margin: 10,
  originCorner: 'bottom-left',
  drawFeed: 3000,
  travelFeed: 6000,
  travelUseG1: false,
  penUpZ: 5,
  penDownZ: 0,
  penDwell: 0.15,
  simplifyTolerance: 0.2,
  mergeTolerance: 0.1,
  optimizeTimeMs: 1000,
  maxInFlight: 4,
};

const STORAGE_KEY = 'penplotter.settings.v1';

type NumericKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];

/** Lower bounds for numeric settings; anything invalid falls back to the default. */
const NUMERIC_MIN: Record<NumericKey, number> = {
  port: 1,
  paperWidth: 10,
  paperHeight: 10,
  margin: 0,
  drawFeed: 1,
  travelFeed: 1,
  penUpZ: -1000,
  penDownZ: -1000,
  penDwell: 0,
  simplifyTolerance: 0,
  mergeTolerance: 0,
  optimizeTimeMs: 0,
  maxInFlight: 1,
};

/** Coerce arbitrary input (parsed JSON, form values) into valid settings. */
export function sanitizeSettings(raw: unknown): Settings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(NUMERIC_MIN) as NumericKey[]) {
    const v = Number(src[key]);
    if (src[key] !== undefined && src[key] !== '' && Number.isFinite(v) && v >= NUMERIC_MIN[key]) {
      out[key] = v;
    }
  }
  out.port = Math.min(65535, Math.round(out.port));
  out.maxInFlight = Math.min(32, Math.round(out.maxInFlight));
  // The margin must leave a drawable area.
  if (out.margin * 2 >= Math.min(out.paperWidth, out.paperHeight)) out.margin = DEFAULT_SETTINGS.margin;
  if (out.margin * 2 >= Math.min(out.paperWidth, out.paperHeight)) out.margin = 0;

  if (typeof src.host === 'string' && src.host.trim()) out.host = src.host.trim();
  if (typeof src.path === 'string') out.path = src.path.trim().startsWith('/') ? src.path.trim() : `/${src.path.trim()}`;
  if (src.originCorner === 'bottom-left' || src.originCorner === 'top-left') out.originCorner = src.originCorner;
  if (typeof src.travelUseG1 === 'boolean') out.travelUseG1 = src.travelUseG1;
  return out;
}

export function loadSettings(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Settings {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return sanitizeSettings(raw ? JSON.parse(raw) : {});
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** ws:// URL for the FluidNC WebSocket. Bracket bare IPv6 addresses. */
export function websocketUrl(s: Pick<Settings, 'host' | 'port' | 'path'>): string {
  const host = s.host.includes(':') && !s.host.startsWith('[') ? `[${s.host}]` : s.host;
  const path = s.path.startsWith('/') ? s.path : `/${s.path}`;
  return `ws://${host}:${s.port}${path}`;
}
