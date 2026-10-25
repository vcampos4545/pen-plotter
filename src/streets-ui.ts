import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Point, Polyline, Rect } from './geometry';
import { enableBoxSelect } from './map-select';
import { buildQuery, checkArea, LAYER_INFO, normalizeBox, OverpassError, parseOverpass, type OsmLine, type StreetLayer } from './osm';
import { fetchOverpass } from './osm-fetch';
import { estimatePhoto, PLANNER_STROKE_LIMIT, STORAGE_POINT_LIMIT } from './photo';
import type { Settings } from './settings';
import { buildStreets, describeCounts, enabledLayers, sanitizeStreetsOptions, type StreetsOptions, type StreetsResult } from './streets';
import { groundSize, type GeoBox } from './terrain';
import { CanvasView } from './view';

// DOM wiring for the Streets dialog: a map to drag a box on, layer toggles and
// a preview of the sheet. One Overpass request per box. Loaded on first use.

export interface StreetsHost {
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
const STORAGE_KEY = 'penplotter.streets.v1';
/** Long jobs get a warning, seconds. */
const LONG_JOB = 2 * 3600;

interface Saved {
  options: StreetsOptions;
  center: [number, number];
  zoom: number;
}

function load(): Saved {
  const fallback: Saved = { options: sanitizeStreetsOptions(null), center: [48.8566, 2.3522], zoom: 13 };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Saved> | null;
    if (!raw) return fallback;
    return {
      options: sanitizeStreetsOptions(raw.options),
      center: Array.isArray(raw.center) && raw.center.length === 2 && raw.center.every(Number.isFinite) ? raw.center : fallback.center,
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

const saved = load();
let options = saved.options;
let host: StreetsHost;
let map: L.Map | undefined;
let selecting = false;
let box: GeoBox | undefined;
/** Features downloaded for `box`, and which layers the request asked for. */
let data: { layers: StreetLayer[]; features: OsmLine[] } | undefined;
let result: StreetsResult | undefined;
let download: AbortController | undefined;
let regenTimer: ReturnType<typeof setTimeout> | undefined;
let preview: CanvasView | undefined;

const dialog = $<HTMLDialogElement>('streets-dialog');
const form = $<HTMLFormElement>('streets-form');

function setStatus(text: string, failed = false): void {
  const el = $('streets-status');
  el.textContent = text;
  el.classList.toggle('failed', failed);
}

/** Show the download button with `label`, or hide it. */
function setFetch(label?: string): void {
  const b = $<HTMLButtonElement>('streets-fetch');
  b.hidden = !label;
  if (label) b.textContent = label;
}

const km = (m: number) => (m >= 10000 ? `${(m / 1000).toFixed(0)} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m.toFixed(0)} m`);
const mm = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} m` : `${n.toFixed(0)} mm`);
function duration(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
const labels = (layers: StreetLayer[]) => layers.map((l) => LAYER_INFO[l].label.toLowerCase()).join(', ');

// ---- map ----------------------------------------------------------------

function createMap(): L.Map {
  const m = L.map($('streets-map'), { boxZoom: false, worldCopyJump: true }).setView(saved.center, saved.zoom);
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(m);
  const warning = $('streets-map-warning');
  tiles.on('tileerror', () => {
    warning.hidden = false;
    warning.textContent = navigator.onLine
      ? 'Some map tiles failed to load. The map may be incomplete.'
      : 'You appear to be offline: the map and the street data both need an internet connection.';
  });
  tiles.on('load', () => (warning.hidden = true));
  m.on('moveend', save);
  enableBoxSelect(m, {
    selecting: () => selecting,
    ratio: () => {
      if (!$<HTMLInputElement>('streets-lock').checked) return undefined;
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
  $('streets-select').setAttribute('aria-pressed', String(on));
  $('streets-map').classList.toggle('selecting', on);
}

// ---- download -----------------------------------------------------------

function selectBox(b: GeoBox): void {
  box = b;
  data = undefined;
  result = undefined;
  const g = groundSize(b);
  $('streets-box').textContent = `${km(g.width)} × ${km(g.height)}`;
  void fetchData();
}

async function fetchData(): Promise<void> {
  if (!box) return;
  download?.abort();
  download = undefined;
  setFetch();
  const b = box;
  const layers = enabledLayers(options);
  const fail = (text: string, retry?: string) => {
    setStatus(text, true);
    setFetch(retry);
    updateInsert();
    renderPreview();
  };
  if (layers.length === 0) return fail('Turn on at least one layer to download.');
  const check = checkArea(b, layers);
  if (!check.ok) {
    const label = LAYER_INFO[check.limitedBy].label;
    return fail(
      `This box is ${check.spanKm.toFixed(1)} km across. ${label} can be downloaded for boxes up to ${check.limitKm} km across, ` +
        `to keep each request to the shared Overpass server modest. Select a smaller area or turn off ${label.toLowerCase()}.`,
      'Download',
    );
  }
  let norm: ReturnType<typeof normalizeBox>;
  try {
    norm = normalizeBox(b);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (!navigator.onLine) {
    return fail('You appear to be offline. Street data is downloaded from OpenStreetMap through the Overpass API, so an internet connection is needed.', 'Retry download');
  }
  const ctrl = new AbortController();
  download = ctrl;
  result = undefined;
  updateInsert();
  renderPreview();
  setStatus(`Downloading ${labels(layers)} from OpenStreetMap…`);
  try {
    const json = await fetchOverpass(buildQuery(norm.box, layers), ctrl.signal);
    if (download !== ctrl) return;
    data = { layers, features: parseOverpass(json, layers, norm.shift) };
    download = undefined;
    regenerate();
  } catch (err) {
    if (download !== ctrl || ctrl.signal.aborted) return;
    const retry = !(err instanceof OverpassError) || err.retry;
    fail(`Could not download the street data. ${(err as Error).message}`, retry ? 'Retry download' : undefined);
  } finally {
    if (download === ctrl) download = undefined;
  }
}

// ---- lines --------------------------------------------------------------

function regenerate(): void {
  clearTimeout(regenTimer);
  // A download in progress replaces `data` and regenerates when it lands.
  if (!box || download) return;
  if (!data) {
    // Nothing downloaded for this box (refused or failed): new layers only take effect on request.
    setStatus('Press Download to fetch the street data for this box with these layers.');
    setFetch('Download');
    return;
  }
  result = buildStreets(data.features, box, host.area(), options);
  const missing = enabledLayers(options).filter((l) => !data!.layers.includes(l));
  const missingNote = missing.length ? `\nNot downloaded yet: ${labels(missing)}. Press Download to fetch the box again with them.` : '';
  setFetch(missing.length ? 'Download' : undefined);
  const warn = $('streets-warning');
  warn.hidden = true;
  if (result.lines.length === 0) {
    const why = result.dropped ? `every line is shorter than ${options.minLength} mm` : 'OpenStreetMap has none of the chosen layers inside it';
    setStatus(`Nothing to draw in this box: ${why}. Try other layers or another area.${missingNote}`, true);
  } else {
    const e = estimatePhoto(result.lines, host.machine());
    setStatus(
      `${describeCounts(result.counts)}\n` +
        `${e.lines.toLocaleString()} line${e.lines === 1 ? '' : 's'} · ${e.points.toLocaleString()} points\n` +
        `Pen-down ${mm(e.drawLength)} · pen-up about ${mm(e.travel)}\n` +
        `About ${duration(e.seconds)} to draw` +
        (result.dropped ? `\n${result.dropped.toLocaleString()} fragments under ${options.minLength} mm dropped.` : '') +
        missingNote,
    );
    const warnings: string[] = [];
    if (e.seconds > LONG_JOB) warnings.push(`This is a long job: about ${duration(e.seconds)} of plotting.`);
    if (e.points > STORAGE_POINT_LIMIT) {
      warnings.push(`${e.points.toLocaleString()} points is too big for the browser to autosave. Export the drawing as JSON to keep it.`);
    }
    if (e.lines > PLANNER_STROKE_LIMIT) warnings.push(`${e.lines.toLocaleString()} separate lines will make path planning slow. Fewer layers or a smaller box helps.`);
    warn.hidden = warnings.length === 0;
    warn.textContent = warnings.join(' ');
  }
  updateInsert();
  renderPreview();
}

function updateInsert(): void {
  $<HTMLButtonElement>('streets-insert').disabled = !result || result.lines.length === 0;
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

// ---- form ---------------------------------------------------------------

function readForm(): StreetsOptions {
  const raw: Record<string, unknown> = { layers: {} };
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name) continue;
    const value = el.type === 'checkbox' ? el.checked : el.value;
    const [group, key] = el.name.split('.');
    if (key === undefined) raw[group] = value;
    else (raw[group] as Record<string, unknown>)[key] = value;
  }
  return sanitizeStreetsOptions(raw);
}

function fillForm(): void {
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name) continue;
    const [group, key] = el.name.split('.');
    const value = key === undefined ? options[group as keyof StreetsOptions] : options.layers[key as StreetLayer];
    if (el.type === 'checkbox') el.checked = value === true;
    else el.value = String(value);
  }
  $<HTMLInputElement>('streets-gap').disabled = !options.doubleMajor;
}

// ---- dialog -------------------------------------------------------------

let wired = false;
function wire(): void {
  wired = true;
  fillForm();
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', () => {
    options = readForm();
    $<HTMLInputElement>('streets-gap').disabled = !options.doubleMajor;
    save();
    clearTimeout(regenTimer);
    regenTimer = setTimeout(regenerate, 150);
  });
  // Show the clamped values once editing a field is done.
  form.addEventListener('change', fillForm);
  $('streets-select').addEventListener('click', () => setSelecting(!selecting));
  $('streets-fetch').addEventListener('click', () => void fetchData());
  $('streets-insert').addEventListener('click', () => {
    if (!result || result.lines.length === 0) return;
    host.insert(result.lines);
    dialog.close();
  });
  $('streets-cancel').addEventListener('click', () => dialog.close());
  $('streets-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => setSelecting(false));
  const canvas = $<HTMLCanvasElement>('streets-preview');
  preview = new CanvasView(canvas);
  new ResizeObserver(() => {
    const p = host.paper();
    preview!.layout(p.width, p.height);
    renderPreview();
  }).observe(canvas);
}

export function openStreets(h: StreetsHost): void {
  host = h;
  if (!wired) wire();
  dialog.showModal();
  if (!map) map = createMap();
  else map.invalidateSize();
  // Paper size or margin may have changed since the last visit.
  if (data) regenerate();
  const p = host.paper();
  preview!.layout(p.width, p.height);
  renderPreview();
}
