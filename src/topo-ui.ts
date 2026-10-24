import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { niceInterval } from './contour';
import type { Point, Polyline, Rect } from './geometry';
import {
  boxFromCorners,
  chooseZoom,
  gridDims,
  groundSize,
  loadMosaic,
  lockAspect,
  resampleGrid,
  tileCount,
  tileRange,
  type ElevationGrid,
  type GeoBox,
  type LatLon,
} from './terrain';
import { terrariumLoader } from './terrain-fetch';
import { buildTopo, DEFAULT_TOPO_OPTIONS, fitToArea, MAX_LEVELS, topoLevels, type TopoOptions, type TopoResult } from './topo';
import { CanvasView } from './view';

// DOM wiring for the Topo dialog: a world map to drag a box on, contour
// controls and a preview of the sheet. Loaded on first use so the map library
// and its tiles stay out of the main app.

export interface TopoHost {
  /** Drawable area of the sheet, paper mm. */
  area(): Rect;
  paper(): { width: number; height: number; margin: number; origin: Point };
  /** The current drawing, shown under the preview. */
  strokes(): Polyline[];
  insert(lines: Polyline[]): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STORAGE_KEY = 'penplotter.topo.v1';

interface Saved {
  options: TopoOptions;
  center: [number, number];
  zoom: number;
}

function load(): Saved {
  const fallback: Saved = { options: { ...DEFAULT_TOPO_OPTIONS }, center: [30, 10], zoom: 2 };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Saved> | null;
    if (!raw) return fallback;
    return {
      options: sanitizeOptions({ ...DEFAULT_TOPO_OPTIONS, ...raw.options }),
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ options, center: [c.lat, c.lng], zoom: map.getZoom() }));
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
let options = saved.options;
let host: TopoHost;
let map: L.Map | undefined;
let rect: L.Rectangle | undefined;
let selecting = false;
let box: GeoBox | undefined;
/** Elevation for `box`, once downloaded. */
let grid: ElevationGrid | undefined;
let result: TopoResult | undefined;
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

  const el = m.getContainer();
  let drag: { id: number; anchor: LatLon } | undefined;
  const at = (e: PointerEvent): LatLon => {
    const ll = m.mouseEventToLatLng(e);
    return { lat: ll.lat, lon: ll.lng };
  };
  const cornerFor = (e: PointerEvent): LatLon => {
    const a = host.area();
    const ratio = (a.maxX - a.minX) / (a.maxY - a.minY);
    return $<HTMLInputElement>('topo-lock').checked ? lockAspect(drag!.anchor, at(e), ratio) : at(e);
  };
  const showBox = (b: GeoBox) => {
    const bounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);
    if (rect) rect.setBounds(bounds);
    else rect = L.rectangle(bounds, { color: '#2563eb', weight: 2, fillOpacity: 0.08, interactive: false }).addTo(m);
  };
  // Capture phase, ahead of Leaflet's own handlers, so a box drag never pans the map.
  el.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || !(selecting || e.shiftKey) || (e.target as Element).closest('.leaflet-control')) return;
      e.preventDefault();
      e.stopPropagation();
      m.dragging.disable();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointer; the drag still works while over the map.
      }
      drag = { id: e.pointerId, anchor: at(e) };
    },
    true,
  );
  el.addEventListener(
    'pointermove',
    (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      e.stopPropagation();
      showBox(boxFromCorners(drag.anchor, cornerFor(e)));
    },
    true,
  );
  const end = (e: PointerEvent, cancelled: boolean) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.stopPropagation();
    const b = boxFromCorners(drag.anchor, cornerFor(e));
    drag = undefined;
    m.dragging.enable();
    const sw = m.latLngToContainerPoint([b.south, b.west]);
    const ne = m.latLngToContainerPoint([b.north, b.east]);
    // A click rather than a drag: keep whatever was selected before.
    if (cancelled || Math.abs(ne.x - sw.x) < 6 || Math.abs(ne.y - sw.y) < 6) {
      if (box) {
        showBox(box);
      } else {
        rect?.remove();
        rect = undefined;
      }
      return;
    }
    setSelecting(false);
    showBox(b);
    selectBox(b);
  };
  el.addEventListener('pointerup', (e) => end(e, false), true);
  el.addEventListener('pointercancel', (e) => end(e, true), true);
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

function readForm(): TopoOptions {
  const val = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value;
  return sanitizeOptions({
    mode: val('mode') as TopoOptions['mode'],
    value: Number(val('value')),
    smoothing: Number(val('smoothing')),
    simplify: Number(val('simplify')),
    minLength: Number(val('minLength')),
  });
}

function fillForm(): void {
  const set = (name: string, v: string | number) => ((form.elements.namedItem(name) as HTMLInputElement).value = String(v));
  set('mode', options.mode);
  set('value', options.value);
  set('smoothing', options.smoothing);
  set('simplify', options.simplify);
  set('minLength', options.minLength);
  $('topo-value-label').textContent = options.mode === 'count' ? 'Number of levels' : 'Interval (m)';
}

/** Contour the cached grid with the current options. `fresh` is true right after a new area loads. */
function regenerate(fresh = false): void {
  if (!grid || !box) return;
  let note = '';
  // A new area can make the last interval useless (100 m on a plain, 5 m on Everest).
  if (fresh && options.mode === 'interval') {
    const n = topoLevels(grid.min, grid.max, options).levels.length;
    if (n < 3 || n > MAX_LEVELS) {
      options = { ...options, value: niceInterval(grid.min, grid.max, 20) };
      fillForm();
      save();
      note = `\nInterval set to ${options.value} m for this area.`;
    }
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
    const points = result.lines.reduce((n, l) => n + l.length, 0);
    setStatus(
      `${range}.\n${result.levels.length} levels${every}${result.capped ? ` (thinned to ${MAX_LEVELS})` : ''} · ` +
        `${result.lines.length} lines · ${points.toLocaleString()} points` +
        (result.dropped ? `\n${result.dropped} fragments under ${options.minLength} mm dropped.` : '') +
        note,
    );
  }
  updateInsert();
  renderPreview();
}

function updateInsert(): void {
  $<HTMLButtonElement>('topo-insert').disabled = !result || result.lines.length === 0;
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
    previewStrokes: result?.lines,
  });
}

// ---- dialog -------------------------------------------------------------

let wired = false;
function wire(): void {
  wired = true;
  fillForm();
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', () => {
    const modeChanged = readForm().mode !== options.mode;
    options = readForm();
    if (modeChanged) {
      // The old number means something else in the other mode.
      options = { ...options, value: options.mode === 'count' ? 20 : grid ? niceInterval(grid.min, grid.max, 20) : DEFAULT_TOPO_OPTIONS.value };
      fillForm();
    }
    save();
    clearTimeout(regenTimer);
    regenTimer = setTimeout(() => regenerate(), 200);
  });
  // Show the clamped values once editing a field is done.
  form.addEventListener('change', fillForm);
  $('topo-select').addEventListener('click', () => setSelecting(!selecting));
  $('topo-retry').addEventListener('click', () => void fetchElevation());
  $('topo-insert').addEventListener('click', () => {
    if (!result || result.lines.length === 0) return;
    host.insert(result.lines);
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
