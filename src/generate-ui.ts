import { MAP_PRESETS, type MapKind } from './attractor';
import { randomizeOptions, sanitizeGenerateOptions, type GenerateOptions, type GenerateResult } from './generate';
import type { GenerateReply, GenerateRequest } from './generate-worker';
import type { Point, Polyline, Rect } from './geometry';
import { estimatePhoto, PLANNER_STROKE_LIMIT, STORAGE_POINT_LIMIT } from './photo';
import type { Settings } from './settings';
import { rng } from './stipple';
import { CanvasView } from './view';

// DOM wiring for the Generate dialog: pick a math-art style, tune it and
// preview the lines on the sheet. Generation runs in a worker. Loaded on first use.

export interface GenerateHost {
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
const STORAGE_KEY = 'penplotter.generate.v1';
/** Long jobs get a warning, seconds. */
const LONG_JOB = 2 * 3600;
const MAP_KINDS: MapKind[] = ['clifford', 'dejong'];

function load(): GenerateOptions {
  try {
    return sanitizeGenerateOptions(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return sanitizeGenerateOptions(null);
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // Storage full or disabled; settings just won't persist.
  }
}

let options = load();
let host: GenerateHost;
let result: GenerateResult | undefined;
let worker: Worker | undefined;
let busy = false;
let requestId = 0;
let regenTimer: ReturnType<typeof setTimeout> | undefined;
let preview: CanvasView | undefined;

const dialog = $<HTMLDialogElement>('gen-dialog');
const form = $<HTMLFormElement>('gen-form');

function setStatus(text: string, failed = false): void {
  const el = $('gen-status');
  el.textContent = text;
  el.classList.toggle('failed', failed);
}

const mm = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} m` : `${n.toFixed(0)} mm`);
function duration(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ---- generation -----------------------------------------------------------

function spawn(): Worker {
  const w = new Worker(new URL('./generate-worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<GenerateReply>) => {
    if (e.data.id !== requestId) return;
    busy = false;
    if ('error' in e.data) {
      result = undefined;
      setStatus(`Could not generate the lines: ${e.data.error}`, true);
    } else {
      result = e.data.result;
      showResult(e.data.ms);
    }
    updateInsert();
    renderPreview();
  };
  w.onerror = (e) => {
    busy = false;
    result = undefined;
    setStatus(`The generator stopped: ${e.message || 'unknown error'}`, true);
    worker?.terminate();
    worker = undefined;
    updateInsert();
    renderPreview();
  };
  return w;
}

function regenerate(): void {
  clearTimeout(regenTimer);
  // Only the newest request matters: drop a run that is still busy on old settings.
  if (busy && worker) {
    worker.terminate();
    worker = undefined;
  }
  worker ??= spawn();
  busy = true;
  const id = ++requestId;
  const request: GenerateRequest = { id, area: host.area(), options };
  worker.postMessage(request);
  setStatus('Generating…');
  updateInsert();
}

function showResult(ms: number): void {
  const warn = $('gen-warning');
  if (!result || result.lines.length === 0) {
    setStatus(result?.notes.join('\n') || 'No lines at these settings.', true);
    warn.hidden = true;
    return;
  }
  const e = estimatePhoto(result.lines, host.machine());
  setStatus(
    `${e.lines.toLocaleString()} line${e.lines === 1 ? '' : 's'} · ${e.points.toLocaleString()} points\n` +
      `Pen-down ${mm(e.drawLength)} · pen-up about ${mm(e.travel)}\n` +
      `About ${duration(e.seconds)} to draw · made in ${(ms / 1000).toFixed(1)} s` +
      (result.notes.length ? `\n${result.notes.join('\n')}` : ''),
  );
  const warnings: string[] = [];
  if (e.seconds > LONG_JOB) warnings.push(`This is a long job: about ${duration(e.seconds)} of plotting.`);
  if (e.points > STORAGE_POINT_LIMIT) {
    warnings.push(`${e.points.toLocaleString()} points is too big for the browser to autosave. Export the drawing as JSON to keep it.`);
  }
  if (e.lines > PLANNER_STROKE_LIMIT) warnings.push(`${e.lines.toLocaleString()} separate lines will make path planning slow. Wider spacing helps.`);
  warn.hidden = warnings.length === 0;
  warn.textContent = warnings.join(' ');
}

function updateInsert(): void {
  $<HTMLButtonElement>('gen-insert').disabled = busy || !result || result.lines.length === 0;
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
    previewStrokes: busy ? undefined : result?.lines,
  });
}

// ---- form -----------------------------------------------------------------

function readForm(): GenerateOptions {
  const raw: Record<string, Record<string, unknown> | string> = {};
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name) continue;
    const [group, key] = el.name.split('.');
    const value = el.type === 'checkbox' ? el.checked : el.value;
    if (key === undefined) raw[group] = String(value);
    else ((raw[group] ??= {}) as Record<string, unknown>)[key] = value;
  }
  return sanitizeGenerateOptions(raw);
}

/** Up to 4 decimals, so 8/3 does not fill the field. */
const show = (v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? String(Number(v.toFixed(4))) : String(v));

function fillForm(): void {
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name) continue;
    const [group, key] = el.name.split('.');
    const value = key === undefined ? options[group as keyof GenerateOptions] : (options[group as keyof GenerateOptions] as unknown as Record<string, unknown>)[key];
    if (el.type === 'checkbox') el.checked = value === true;
    else el.value = show(value);
  }
  $('gen-size-out').textContent = `${Math.round(options.size)} %`;
  for (const kind of MAP_KINDS) {
    const p = options[kind];
    const match = MAP_PRESETS[kind].findIndex((q) => q.a === p.a && q.b === p.b && q.c === p.c && q.d === p.d);
    $<HTMLSelectElement>(`gen-${kind}-preset`).value = match < 0 ? '' : String(match);
  }
  for (const fs of Array.from(form.querySelectorAll<HTMLFieldSetElement>('fieldset.gen-style'))) fs.hidden = fs.dataset.style !== options.style;
}

function fillPresets(): void {
  for (const kind of MAP_KINDS) {
    const select = $<HTMLSelectElement>(`gen-${kind}-preset`);
    select.append(new Option('Custom', ''));
    MAP_PRESETS[kind].forEach((p, i) => select.append(new Option(p.name, String(i))));
    select.addEventListener('change', () => {
      const preset = MAP_PRESETS[kind][Number(select.value)];
      if (!select.value || !preset) return;
      options = { ...options, [kind]: { ...options[kind], a: preset.a, b: preset.b, c: preset.c, d: preset.d } };
      save();
      fillForm();
      regenerate();
    });
  }
}

// ---- dialog ---------------------------------------------------------------

let wired = false;
function wire(): void {
  wired = true;
  fillPresets();
  fillForm();
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', (e) => {
    // Preset menus have no name and apply themselves on change.
    if (!(e.target as HTMLInputElement).name) return;
    const styleChanged = readForm().style !== options.style;
    options = readForm();
    save();
    $('gen-size-out').textContent = `${Math.round(options.size)} %`;
    if (styleChanged) fillForm();
    clearTimeout(regenTimer);
    regenTimer = setTimeout(regenerate, styleChanged ? 0 : 250);
  });
  // Show the clamped values (and the matching preset) once editing a field is done.
  form.addEventListener('change', (e) => {
    if ((e.target as HTMLInputElement).name) fillForm();
  });

  $('gen-randomize').addEventListener('click', () => {
    options = randomizeOptions(options, rng((Math.random() * 2 ** 32) >>> 0));
    save();
    fillForm();
    regenerate();
  });
  $('gen-insert').addEventListener('click', () => {
    if (busy || !result || result.lines.length === 0) return;
    host.insert(result.lines);
    dialog.close();
  });
  $('gen-cancel').addEventListener('click', () => dialog.close());
  $('gen-close').addEventListener('click', () => dialog.close());

  const canvas = $<HTMLCanvasElement>('gen-preview');
  preview = new CanvasView(canvas);
  new ResizeObserver(() => {
    const p = host.paper();
    preview!.layout(p.width, p.height);
    renderPreview();
  }).observe(canvas);
}

export function openGenerate(h: GenerateHost): void {
  host = h;
  if (!wired) wire();
  dialog.showModal();
  const p = host.paper();
  preview!.layout(p.width, p.height);
  // Paper size or margin may have changed since the last visit.
  regenerate();
  renderPreview();
}
