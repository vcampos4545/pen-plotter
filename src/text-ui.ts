import { parse } from 'opentype.js';
import type { GenerateHost } from './generate-ui';
import { estimatePhoto, PLANNER_STROKE_LIMIT, STORAGE_POINT_LIMIT } from './photo';
import { CUSTOM_FONT, DEFAULT_TEXT_OPTIONS, FONTS, sanitizeTextOptions, type TextOptions, type TextResult } from './text';
import type { TextReply, TextRequest } from './text-worker';
import { CanvasView } from './view';

// DOM wiring for the Text dialog: type some text, pick a font, fill and
// effects, preview it on the sheet. Layout runs in a worker. Loaded on first use.

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STORAGE_KEY = 'penplotter.text.v1';
/** Long jobs get a warning, seconds. */
const LONG_JOB = 2 * 3600;

function load(): TextOptions {
  try {
    const o = sanitizeTextOptions(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
    // The user's font file is not kept between visits.
    return o.font === CUSTOM_FONT ? { ...o, font: DEFAULT_TEXT_OPTIONS.font } : o;
  } catch {
    return sanitizeTextOptions(null);
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
let result: TextResult | undefined;
let worker: Worker | undefined;
let busy = false;
let requestId = 0;
let regenTimer: ReturnType<typeof setTimeout> | undefined;
let preview: CanvasView | undefined;
let custom: { key: string; name: string; bytes: ArrayBuffer } | undefined;

const dialog = $<HTMLDialogElement>('text-dialog');
const form = $<HTMLFormElement>('text-form');

function setStatus(text: string, failed = false): void {
  const el = $('text-status');
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

const fontKind = (id: string) => FONTS.find((f) => f.id === id)?.kind ?? 'outline';

// ---- generation -----------------------------------------------------------

function spawn(): Worker {
  const w = new Worker(new URL('./text-worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<TextReply>) => {
    if (e.data.id !== requestId) return;
    busy = false;
    if ('error' in e.data) {
      result = undefined;
      setStatus(`Could not lay out the text: ${e.data.error}`, true);
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
    setStatus(`The text tool stopped: ${e.message || 'unknown error'}`, true);
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
  const request: TextRequest = { id, area: host.area(), options };
  if (options.font === CUSTOM_FONT && custom) request.custom = { key: custom.key, bytes: custom.bytes };
  worker.postMessage(request);
  setStatus('Laying out…');
  updateInsert();
}

function showResult(ms: number): void {
  const warn = $('text-warning');
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
  if (e.lines > PLANNER_STROKE_LIMIT) warnings.push(`${e.lines.toLocaleString()} separate lines will make path planning slow. Wider fill spacing helps.`);
  warn.hidden = warnings.length === 0;
  warn.textContent = warnings.join(' ');
}

function updateInsert(): void {
  $<HTMLButtonElement>('text-insert').disabled = busy || !result || result.lines.length === 0;
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

function readForm(): TextOptions {
  const raw: Record<string, unknown> = {};
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name) continue;
    raw[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return sanitizeTextOptions(raw);
}

/** Up to 4 decimals, so a clamped value does not fill the field. */
const show = (v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? String(Number(v.toFixed(4))) : String(v));

function fillForm(): void {
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name) continue;
    const value = options[el.name as keyof TextOptions];
    if (el.type === 'checkbox') el.checked = value === true;
    // Rewriting the text while typing would move the caret.
    else if (el.name !== 'text' || el.value !== value) el.value = show(value);
  }
  const kind = fontKind(options.font);
  for (const fs of Array.from(form.querySelectorAll<HTMLFieldSetElement>('fieldset[data-kind]'))) fs.hidden = fs.dataset.kind !== kind;
}

function setCustomFont(name: string, bytes: ArrayBuffer, key: string): void {
  custom = { key, name, bytes };
  const select = $<HTMLSelectElement>('text-font');
  let option = select.querySelector<HTMLOptionElement>(`option[value="${CUSTOM_FONT}"]`);
  if (!option) {
    option = new Option('', CUSTOM_FONT);
    select.querySelector('optgroup[label="Outline"]')!.append(option);
  }
  option.textContent = `Your font: ${name}`;
  $('text-font-name').textContent = `Loaded: ${name}`;
  options = { ...options, font: CUSTOM_FONT };
  save();
  fillForm();
  regenerate();
}

async function loadFontFile(file: File): Promise<void> {
  try {
    const bytes = await file.arrayBuffer();
    // Parse here too, to reject a bad file before it reaches the worker and to name it.
    const font = parse(bytes.slice(0));
    const name = font.names.fullName?.en || font.names.fontFamily?.en || file.name;
    setCustomFont(name, bytes, `${file.name}:${file.size}:${file.lastModified}`);
  } catch (err) {
    setStatus(`Could not read ${file.name} as a font: ${(err as Error).message}`, true);
  }
}

// ---- dialog ---------------------------------------------------------------

let wired = false;
function wire(): void {
  wired = true;
  fillForm();
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', (e) => {
    if (!(e.target as HTMLInputElement).name) return;
    const next = readForm();
    const kindChanged = fontKind(next.font) !== fontKind(options.font);
    const fontChanged = next.font !== options.font;
    options = next;
    save();
    if (kindChanged) fillForm();
    clearTimeout(regenTimer);
    regenTimer = setTimeout(regenerate, fontChanged ? 0 : 250);
  });
  // Show the clamped values once editing a field is done.
  form.addEventListener('change', (e) => {
    if ((e.target as HTMLInputElement).name) fillForm();
  });

  const file = $<HTMLInputElement>('text-file');
  $('text-load-font').addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = '';
    if (f) void loadFontFile(f);
  });

  $('text-insert').addEventListener('click', () => {
    if (busy || !result || result.lines.length === 0) return;
    host.insert(result.lines);
    dialog.close();
  });
  $('text-cancel').addEventListener('click', () => dialog.close());
  $('text-close').addEventListener('click', () => dialog.close());

  const canvas = $<HTMLCanvasElement>('text-preview');
  preview = new CanvasView(canvas);
  new ResizeObserver(() => {
    const p = host.paper();
    preview!.layout(p.width, p.height);
    renderPreview();
  }).observe(canvas);
}

export function openText(h: GenerateHost): void {
  host = h;
  if (!wired) wire();
  dialog.showModal();
  const p = host.paper();
  preview!.layout(p.width, p.height);
  // Paper size or margin may have changed since the last visit.
  regenerate();
  renderPreview();
}
