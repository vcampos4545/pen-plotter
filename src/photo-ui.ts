import type { Point, Polyline, Rect } from './geometry';
import {
  estimatePhoto,
  framePhoto,
  PLANNER_STROKE_LIMIT,
  sanitizePhotoOptions,
  STORAGE_POINT_LIMIT,
  type Frame,
  type PhotoOptions,
  type PhotoResult,
} from './photo';
import type { PhotoReply, PhotoRequest } from './photo-worker';
import type { Settings } from './settings';
import { adjustTone, luminance } from './tone';
import { CanvasView } from './view';

// DOM wiring for the Photo dialog: load an image, adjust it, pick a style and
// preview the lines on the sheet. Generation runs in a worker. Loaded on first use.

export interface PhotoHost {
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
const STORAGE_KEY = 'penplotter.photo.v1';
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** Long jobs get a warning, seconds. */
const LONG_JOB = 2 * 3600;

function load(): PhotoOptions {
  try {
    return sanitizePhotoOptions(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return sanitizePhotoOptions(null);
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
let host: PhotoHost;
let image: ImageBitmap | undefined;
let imageName = '';
let frame: Frame | undefined;
/** Luminance of the framed photo, at the frame's grid size. */
let lum: Float32Array | undefined;
/** Key of the area + fit that `frame` and `lum` were made for. */
let frameKey = '';
let result: PhotoResult | undefined;
let worker: Worker | undefined;
let busy = false;
let requestId = 0;
let regenTimer: ReturnType<typeof setTimeout> | undefined;
let preview: CanvasView | undefined;

const dialog = $<HTMLDialogElement>('photo-dialog');
const form = $<HTMLFormElement>('photo-form');

function setStatus(text: string, failed = false): void {
  const el = $('photo-status');
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

// ---- image ----------------------------------------------------------------

async function loadFile(file: File): Promise<void> {
  const typeOk = TYPES.includes(file.type) || (!file.type && /\.(jpe?g|png|webp)$/i.test(file.name));
  if (!typeOk) {
    setStatus(`${file.name} is not a JPEG, PNG or WebP image.`, true);
    return;
  }
  let bitmap: ImageBitmap;
  try {
    // Decoded locally; 'from-image' applies the camera's EXIF rotation.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    setStatus(`Could not read ${file.name}. The file may be damaged or in a format this browser cannot decode.`, true);
    return;
  }
  image?.close();
  image = bitmap;
  imageName = file.name;
  frameKey = '';
  result = undefined;
  $('photo-empty').hidden = true;
  $('photo-name').textContent = `${file.name} · ${bitmap.width} × ${bitmap.height} px`;
  regenerate();
}

/** Crop and scale the photo to the processing grid; cached until the area or framing changes. */
function ensureFrame(): boolean {
  if (!image) return false;
  const area = host.area();
  const key = `${area.minX},${area.minY},${area.maxX},${area.maxY}|${options.fit}|${imageName}`;
  if (key === frameKey && lum) return true;
  const f = framePhoto(image.width, image.height, area, options.fit);
  const canvas = document.createElement('canvas');
  canvas.width = f.gridWidth;
  canvas.height = f.gridHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, f.source.x, f.source.y, f.source.width, f.source.height, 0, 0, f.gridWidth, f.gridHeight);
  lum = luminance(ctx.getImageData(0, 0, f.gridWidth, f.gridHeight).data, f.gridWidth, f.gridHeight);
  frame = f;
  frameKey = key;
  return true;
}

/** Show the photo as the generator sees it: cropped, toned, greyscale. */
function renderThumb(): void {
  const canvas = $<HTMLCanvasElement>('photo-thumb');
  if (!frame || !lum) {
    canvas.hidden = true;
    return;
  }
  const { gridWidth: w, gridHeight: h } = frame;
  const tone = adjustTone(lum, w, h, options.tone);
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.round((1 - tone.values[i]) * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  canvas.hidden = false;
}

// ---- generation -----------------------------------------------------------

function spawn(): Worker {
  const w = new Worker(new URL('./photo-worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<PhotoReply>) => {
    if (e.data.id !== requestId) return;
    busy = false;
    if ('error' in e.data) {
      result = undefined;
      setStatus(`Could not make lines from this photo: ${e.data.error}`, true);
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
    setStatus(`The line generator stopped: ${e.message || 'unknown error'}`, true);
    worker?.terminate();
    worker = undefined;
    updateInsert();
    renderPreview();
  };
  return w;
}

function regenerate(): void {
  clearTimeout(regenTimer);
  if (!ensureFrame()) return;
  renderThumb();
  // Only the newest request matters: drop a run that is still busy on old settings.
  if (busy && worker) {
    worker.terminate();
    worker = undefined;
  }
  worker ??= spawn();
  busy = true;
  const id = ++requestId;
  const request: PhotoRequest = {
    id,
    input: { luminance: lum!, width: frame!.gridWidth, height: frame!.gridHeight, place: frame!.place, area: host.area(), options },
  };
  worker.postMessage(request);
  setStatus(options.style === 'tsp' ? `Stippling and finding a path (up to ${options.tsp.timeLimit} s)…` : 'Generating lines…');
  updateInsert();
}

function showResult(ms: number): void {
  const warn = $('photo-warning');
  if (!result || result.lines.length === 0) {
    setStatus(
      options.style === 'outline'
        ? 'No edges found. Lower the edge threshold, smooth less, or drop fewer short lines.'
        : 'No lines: the photo is blank at these settings. Try more contrast, a lower brightness or Invert.',
      true,
    );
    warn.hidden = true;
    return;
  }
  const e = estimatePhoto(result.lines, host.machine());
  const notes: string[] = [];
  if (result.dropped > 0) notes.push(`${result.dropped.toLocaleString()} edges under ${options.outline.minLength} mm dropped.`);
  if (result.timedOut) notes.push(`Path optimization stopped at the ${options.tsp.timeLimit} s limit; a longer limit gives a shorter path.`);
  setStatus(
    `${e.lines.toLocaleString()} line${e.lines === 1 ? '' : 's'} · ${e.points.toLocaleString()} points\n` +
      `Pen-down ${mm(e.drawLength)} · pen-up about ${mm(e.travel)}\n` +
      `About ${duration(e.seconds)} to draw · made in ${(ms / 1000).toFixed(1)} s` +
      (notes.length ? `\n${notes.join('\n')}` : ''),
  );
  const warnings: string[] = [];
  if (e.seconds > LONG_JOB) warnings.push(`This is a long job: about ${duration(e.seconds)} of plotting.`);
  if (e.points > STORAGE_POINT_LIMIT) {
    warnings.push(`${e.points.toLocaleString()} points is too big for the browser to autosave. Export the drawing as JSON to keep it.`);
  }
  if (e.lines > PLANNER_STROKE_LIMIT) warnings.push(`${e.lines.toLocaleString()} separate lines will make path planning slow. Fewer layers or wider spacing helps.`);
  warn.hidden = warnings.length === 0;
  warn.textContent = warnings.join(' ');
}

function updateInsert(): void {
  $<HTMLButtonElement>('photo-insert').disabled = busy || !result || result.lines.length === 0;
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

function readForm(): PhotoOptions {
  const raw: Record<string, Record<string, unknown> | string> = {};
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name) continue;
    const [group, key] = el.name.split('.');
    const value = el.type === 'checkbox' ? el.checked : el.value;
    if (key === undefined) raw[group] = String(value);
    else ((raw[group] ??= {}) as Record<string, unknown>)[key] = value;
  }
  return sanitizePhotoOptions(raw);
}

function fillForm(): void {
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name) continue;
    const [group, key] = el.name.split('.');
    const value = key === undefined ? options[group as keyof PhotoOptions] : (options[group as keyof PhotoOptions] as unknown as Record<string, unknown>)[key];
    if (el.type === 'checkbox') el.checked = value === true;
    else el.value = String(value);
  }
  showToneValues();
  for (const fs of Array.from(form.querySelectorAll<HTMLFieldSetElement>('fieldset.photo-style'))) fs.hidden = fs.dataset.style !== options.style;
}

function showToneValues(): void {
  const t = options.tone;
  $('photo-brightness-out').textContent = String(t.brightness);
  $('photo-contrast-out').textContent = String(t.contrast);
  $('photo-gamma-out').textContent = t.gamma.toFixed(2);
}

// ---- dialog ---------------------------------------------------------------

let wired = false;
function wire(): void {
  wired = true;
  fillForm();
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', () => {
    const styleChanged = readForm().style !== options.style;
    options = readForm();
    save();
    showToneValues();
    if (styleChanged) fillForm();
    // Tone shows at once on the thumbnail; lines follow after a pause.
    if (ensureFrame()) renderThumb();
    clearTimeout(regenTimer);
    regenTimer = setTimeout(regenerate, styleChanged ? 0 : 250);
  });
  // Show the clamped values once editing a field is done.
  form.addEventListener('change', fillForm);

  const file = $<HTMLInputElement>('photo-file');
  const choose = () => file.click();
  $('photo-choose').addEventListener('click', choose);
  $('photo-choose-big').addEventListener('click', choose);
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = '';
    if (f) void loadFile(f);
  });

  // Drop anywhere on the dialog; the preview area highlights.
  const drop = $('photo-drop');
  const hasFile = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  dialog.addEventListener('dragover', (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    drop.classList.add('dragging');
  });
  dialog.addEventListener('dragleave', (e) => {
    if (!dialog.contains(e.relatedTarget as Node | null)) drop.classList.remove('dragging');
  });
  dialog.addEventListener('drop', (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();
    drop.classList.remove('dragging');
    const f = e.dataTransfer?.files[0];
    if (f) void loadFile(f);
  });

  $('photo-insert').addEventListener('click', () => {
    if (busy || !result || result.lines.length === 0) return;
    host.insert(result.lines);
    dialog.close();
  });
  $('photo-cancel').addEventListener('click', () => dialog.close());
  $('photo-close').addEventListener('click', () => dialog.close());

  const canvas = $<HTMLCanvasElement>('photo-preview');
  preview = new CanvasView(canvas);
  new ResizeObserver(() => {
    const p = host.paper();
    preview!.layout(p.width, p.height);
    renderPreview();
  }).observe(canvas);
}

/** Open the dialog, optionally with a photo already chosen (e.g. dropped on the main canvas). */
export function openPhoto(h: PhotoHost, file?: File): void {
  host = h;
  if (!wired) wire();
  dialog.showModal();
  const p = host.paper();
  preview!.layout(p.width, p.height);
  if (file) void loadFile(file);
  // Paper size or margin may have changed since the last visit.
  else if (image) regenerate();
  renderPreview();
}
