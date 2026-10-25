import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { niceInterval } from './contour';
import type { Point, Polyline, Rect } from './geometry';
import { estimatePhoto } from './photo';
import { buildRidges, sanitizeRidgeOptions, type RidgeOptions, type RidgeResult } from './ridgeline';
import type { Settings } from './settings';
import {
  chooseZoom,
  gridDims,
  groundSize,
  loadMosaic,
  resampleGrid,
  tileCount,
  tileRange,
  type ElevationGrid,
  type GeoBox,
} from './terrain';
import { terrariumLoader } from './terrain-fetch';
import { enableBoxSelect } from './map-select';
import { buildTopo, DEFAULT_TOPO_OPTIONS, fitToArea, MAX_LEVELS, topoLevels, type TopoOptions, type TopoResult } from './topo';
import { CanvasView } from './view';

// DOM wiring for the Topo dialog: a world map to drag a box on, contour or
// ridgeline controls and a preview of the sheet. Loaded on first use so the map library
// and its tiles stay out of the main app.

export interface TopoHost {
  /** Drawable area of the sheet, paper mm. */
  area(): Rect;
  paper(): { width: number; height: number; margin: number; origin: Point };
  /** Feeds and dwell, for the time estimate. */
  machine(): Pick<Settings, 'drawFeed' | 'travelFeed' | 'penDwell'>;
  /** The current drawing, shown under the preview. */
  strokes(): Polyline[];
  insert(lines: Polyline[]): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STORAGE_KEY = 'penplotter.topo.v1';

/** Contour lines, or stacked horizontal elevation profiles. */
type TopoStyle = 'contours' | 'ridges';

interface Saved {
  style: TopoStyle;
  options: TopoOptions;
  ridge: RidgeOptions;
  center: [number, number];
  zoom: number;
}

function load(): Saved {
  const fallback: Saved = { style: 'contours', options: { ...DEFAULT_TOPO_OPTIONS }, ridge: sanitizeRidgeOptions(null), center: [30, 10], zoom: 2 };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Saved> | null;
    if (!raw) return fallback;
    return {
      style: raw.style === 'ridges' ? 'ridges' : 'contours',
      options: sanitizeOptions({ ...DEFAULT_TOPO_OPTIONS, ...raw.options }),
      ridge: sanitizeRidgeOptions(raw.ridge),
      center: Array.isArray(raw.center) && raw.center.every(Number.isFinite) ? raw.center : fallback.center,
      zoom: Number.isFinite(raw.zoom) ? raw.zoom! : fallback.zoom,
    };
  } catch {
    return fallback;
  }
}

function save(): void {
  if (!map) return;
  const c = map.getCenter();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ style, options, ridge, center: [c.lat, c.lng], zoom: map.getZoom() }));
  } catch {
    // Storage full or disabled; settings just won't persist.
  }
}

function sanitizeOptions(o: Partial<TopoOptions>): TopoOptions {
  const num = (v: unknown, fallback: number, min: number, max = Infinity) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const d = DEFAULT_TOPO_OPTIONS;
  const mode = o.mode === 'count' ? 'count' : 'interval';
  return {
    mode,
    value: mode === 'count' ? Math.round(num(o.value, 20, 1, MAX_LEVELS)) : num(o.value, d.value, 0.1),
    smoothing: Math.round(num(o.smoothing, d.smoothing, 0, 20)),
    simplify: num(o.simplify, d.simplify, 0, 10),
    minLength: num(o.minLength, d.minLength, 0, 1000),
  };
}

const saved = load();
let style = saved.style;
let options = saved.options;
let ridge = saved.ridge;
let host: TopoHost;
let map: L.Map | undefined;
let selecting = false;
let box: GeoBox | undefined;
/** Elevation for `box`, once downloaded. */
let grid: ElevationGrid | undefined;
let result: TopoResult | undefined;
let ridges: RidgeResult | undefined;
let download: AbortController | undefined;
let regenTimer: ReturnType<typeof setTimeout> | undefined;
let preview: CanvasView | undefined;

const dialog = $<HTMLDialogElement>('topo-dialog');
const form = $<HTMLFormElement>('topo-form');

function setStatus(text: string, failed = false): void {
  const el = $('topo-status');
  el.textContent = text;
  el.classList.toggle('failed', failed);
}

const km = (m: number) => (m >= 10000 ? `${(m / 1000).toFixed(0)} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m.toFixed(0)} m`);
const metres = (m: number) => `${Math.round(m).toLocaleString()} m`;
const mm = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} m` : `${n.toFixed(0)} mm`);
function duration(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Lines, pen distance and time, as the Photo dialog shows them. */
function estimateText(lines: Polyline[]): string {
  const e = estimatePhoto(lines, host.machine());
  return (
    `${e.lines.toLocaleString()} line${e.lines === 1 ? '' : 's'} · ${e.points.toLocaleString()} points\n` +
    `Pen-down ${mm(e.drawLength)} · pen-up about ${mm(e.travel)} · about ${duration(e.seconds)} to draw`
  );
}

/** The lines the current style would add. */
const current = (): Polyline[] | undefined => (style === 'ridges' ? ridges?.lines : result?.lines);

// ---- map ----------------------------------------------------------------

function createMap(): L.Map {
  const m = L.map($('topo-map'), { boxZoom: false, worldCopyJump: true }).setView(saved.center, saved.zoom);
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(m);
  m.attributionControl.addAttribution(
    'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> ' +
      '(<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">USGS 3DEP, SRTM, GMTED2010, ETOPO1, EU-DEM and others</a>)',
  );
  const warning = $('topo-map-warning');
  tiles.on('tileerror', () => {
    warning.hidden = false;
    warning.textContent = navigator.onLine
      ? 'Some map tiles failed to load. The map may be incomplete.'
      : 'You appear to be offline: the map and the elevation data both need an internet connection.';
  });
  tiles.on('load', () => (warning.hidden = true));
  m.on('moveend', save);

  enableBoxSelect(m, {
    selecting: () => selecting,
    ratio: () => {
      if (!$<HTMLInputElement>('topo-lock').checked) return undefined;
      const a = host.area();
      return (a.maxX - a.minX) / (a.maxY - a.minY);
    },
    onSelect: (b) => {
      setSelecting(false);
      selectBox(b);
    },
  });
  return m;
}

function setSelecting(on: boolean): void {
  selecting = on;
  $('topo-select').setAttribute('aria-pressed', String(on));
  $('topo-map').classList.toggle('selecting', on);
}

// ---- elevation ----------------------------------------------------------

function selectBox(b: GeoBox): void {
  box = b;
  grid = undefined;
  result = undefined;
  ridges = undefined;
  const g = groundSize(b);
  const z = chooseZoom(b);
  const tiles = tileCount(tileRange(b, z));
  $('topo-box').textContent = `${km(g.width)} × ${km(g.height)} · elevation zoom ${z} · ${tiles} tile${tiles === 1 ? '' : 's'}`;
  void fetchElevation();
}

async function fetchElevation(): Promise<void> {
  if (!box) return;
  download?.abort();
  const ctrl = new AbortController();
  download = ctrl;
  const b = box;
  const range = tileRange(b, chooseZoom(b));
  $('topo-retry').hidden = true;
  updateInsert();
  renderPreview();
  if (!navigator.onLine) {
    setStatus('You appear to be offline. Elevation data is downloaded from the AWS Terrain Tiles, so an internet connection is needed.', true);
    $('topo-retry').hidden = false;
    return;
  }
  setStatus(`Downloading elevation… 0/${tileCount(range)} tiles`);
  try {
    const mosaic = await loadMosaic(range, terrariumLoader(ctrl.signal), (done, total) => {
      if (download === ctrl) setStatus(`Downloading elevation… ${done}/${total} tiles`);
    });
    if (download !== ctrl) return;
    const { nx, ny } = gridDims(b);
    grid = resampleGrid(mosaic, b, nx, ny);
    regenerate(true);
  } catch (err) {
    if (download !== ctrl || ctrl.signal.aborted) return;
    setStatus(`Could not download the elevation data: ${(err as Error).message}`, true);
    $('topo-retry').hidden = false;
  } finally {
    if (download === ctrl) download = undefined;
  }
}

// ---- contours -----------------------------------------------------------

const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
const val = (name: string) => field(name).value;
const readStyle = (): TopoStyle => (val('style') === 'ridges' ? 'ridges' : 'contours');

function readForm(): TopoOptions {
  return sanitizeOptions({
    mode: val('mode') as TopoOptions['mode'],
    value: Number(val('value')),
    smoothing: Number(val('smoothing')),
    simplify: Number(val('simplify')),
    minLength: Number(val('minLength')),
  });
}

function readRidgeForm(): RidgeOptions {
  return sanitizeRidgeOptions({
    lines: Number(val('ridge.lines')),
    height: Number(val('ridge.height')),
    baseline: field('ridge.baseline').checked,
    smoothing: Number(val('smoothing')),
    simplify: Number(val('simplify')),
    minLength: Number(val('minLength')),
  });
}

function fillForm(): void {
  const set = (name: string, v: string | number) => (field(name).value = String(v));
  set('style', style);
  set('mode', options.mode);
  set('value', options.value);
  set('ridge.lines', ridge.lines);
  set('ridge.height', ridge.height);
  field('ridge.baseline').checked = ridge.baseline;
  // Smoothing, simplify and the length filter are shared fields; each style keeps its own values.
  const shared = style === 'ridges' ? ridge : options;
  set('smoothing', shared.smoothing);
  set('simplify', shared.simplify);
  set('minLength', shared.minLength);
  $('topo-value-label').textContent = options.mode === 'count' ? 'Number of levels' : 'Interval (m)';
  for (const fs of Array.from(form.querySelectorAll<HTMLFieldSetElement>('fieldset.topo-style'))) fs.hidden = fs.dataset.style !== style;
}

/** Draw the cached grid with the current style and options. `fresh` is true right after a new area loads. */
function regenerate(fresh = false): void {
  if (!grid || !box) return;
  let note = '';
  // A new area can make the last interval useless (100 m on a plain, 5 m on Everest).
  // Checked in either style so switching to contours later starts from a sensible interval.
  if (fresh && options.mode === 'interval') {
    const n = topoLevels(grid.min, grid.max, options).levels.length;
    if (n < 3 || n > MAX_LEVELS) {
      options = { ...options, value: niceInterval(grid.min, grid.max, 20) };
      fillForm();
      save();
      note = `\nInterval set to ${options.value} m for this area.`;
    }
  }
  if (style === 'ridges') {
    regenerateRidges();
    return;
  }
  const area = host.area();
  result = buildTopo(grid, fitToArea(groundSize(box), area), area, options);
  const range = `Elevation ${metres(grid.min)} to ${metres(grid.max)}`;
  if (result.lines.length === 0) {
    const why =
      result.levels.length === 0
        ? options.mode === 'interval'
          ? `no ${options.value} m contour falls inside it`
          : 'the ground is flat'
        : `every line is shorter than ${options.minLength} mm`;
    setStatus(`No contour lines here: ${range.toLowerCase()}, and ${why}. Try a smaller interval, less filtering, or another area.`, true);
  } else {
    const every = options.mode === 'interval' ? ` every ${options.value} m` : '';
    setStatus(
      `${range}.\n${result.levels.length} levels${every}${result.capped ? ` (thinned to ${MAX_LEVELS})` : ''}\n` +
        estimateText(result.lines) +
        (result.dropped ? `\n${result.dropped} fragments under ${options.minLength} mm dropped.` : '') +
        note,
    );
  }
  updateInsert();
  renderPreview();
}

function regenerateRidges(): void {
  if (!grid || !box) return;
  ridges = buildRidges(grid, groundSize(box), host.area(), ridge);
  const range = `Elevation ${metres(ridges.min)} to ${metres(ridges.max)}`;
  if (ridges.lines.length === 0) {
    setStatus(`No ridgelines here: every visible piece is shorter than ${ridge.minLength} mm. Lower that filter to keep them.`, true);
  } else {
    const x = ridges.exaggeration;
    setStatus(
      `${range}.\n${ridges.rows} profiles` +
        (x > 0 ? ` · heights about ×${x >= 10 ? x.toFixed(0) : x.toFixed(1)} true scale` : ' · flat ground, so the profiles are straight') +
        `\n${estimateText(ridges.lines)}` +
        (ridges.dropped ? `\n${ridges.dropped} pieces under ${ridge.minLength} mm dropped.` : ''),
    );
  }
  updateInsert();
  renderPreview();
}

function updateInsert(): void {
  $<HTMLButtonElement>('topo-insert').disabled = !current()?.length;
}

function renderPreview(): void {
  if (!preview) return;
  const p = host.paper();
  preview.render({
    paperWidth: p.width,
    paperHeight: p.height,
    margin: p.margin,
    origin: p.origin,
    strokes: host.strokes(),
    previewStrokes: current(),
  });
}

// ---- dialog -------------------------------------------------------------

let wired = false;
function wire(): void {
  wired = true;
  fillForm();
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', () => {
    const styleChanged = readStyle() !== style;
    if (styleChanged) {
      style = readStyle();
      // The shared fields now show the other style's values.
      fillForm();
    } else if (style === 'ridges') {
      ridge = readRidgeForm();
    } else {
      const modeChanged = readForm().mode !== options.mode;
      options = readForm();
      if (modeChanged) {
        // The old number means something else in the other mode.
        options = { ...options, value: options.mode === 'count' ? 20 : grid ? niceInterval(grid.min, grid.max, 20) : DEFAULT_TOPO_OPTIONS.value };
        fillForm();
      }
    }
    save();
    clearTimeout(regenTimer);
    regenTimer = setTimeout(() => regenerate(), styleChanged ? 0 : 200);
  });
  // Show the clamped values once editing a field is done.
  form.addEventListener('change', fillForm);
  $('topo-select').addEventListener('click', () => setSelecting(!selecting));
  $('topo-retry').addEventListener('click', () => void fetchElevation());
  $('topo-insert').addEventListener('click', () => {
    const lines = current();
    if (!lines?.length) return;
    host.insert(lines);
    dialog.close();
  });
  $('topo-cancel').addEventListener('click', () => dialog.close());
  $('topo-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => setSelecting(false));
  const canvas = $<HTMLCanvasElement>('topo-preview');
  preview = new CanvasView(canvas);
  new ResizeObserver(() => {
    const p = host.paper();
    preview!.layout(p.width, p.height);
    renderPreview();
  }).observe(canvas);
}

export function openTopo(h: TopoHost): void {
  host = h;
  if (!wired) wire();
  dialog.showModal();
  if (!map) map = createMap();
  else map.invalidateSize();
  // Paper size or margin may have changed since the last visit.
  if (grid) regenerate();
  const p = host.paper();
  preview!.layout(p.width, p.height);
  renderPreview();
}
