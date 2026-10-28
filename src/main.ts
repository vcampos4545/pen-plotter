import { FluidNCConnection, type ConnState } from './connection';
import { Drawing, fromJSON, fromSVG, loadDrawing, newId, saveDrawing, toJSON, toSVG, type StrokeKind } from './drawing';
import { clampPoint, dist, distToPolyline, drawableRect, type Point, type Polyline } from './geometry';
import { fmt, fromMachine } from './gcode';
import { buildJob, type Job } from './job';
import { describeOrigin, OriginSetter, type OriginProgress } from './origin';
import { workPosition, type Axes, type StatusReport } from './protocol';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  sanitizeSettings,
  saveSettings,
  websocketUrl,
  type Settings,
} from './settings';
import { constrainAngle, constrainSquare, ellipseShape, lineShape, rectShape } from './shapes';
import { Streamer, type StreamProgress } from './streamer';
import { CanvasView } from './view';

type Tool = StrokeKind | 'eraser';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- state --------------------------------------------------------------

let settings: Settings = loadSettings();
const drawing = new Drawing(loadDrawing());
const view = new CanvasView($<HTMLCanvasElement>('canvas'));
let tool: Tool = 'freehand';

let job: Job | undefined;
let jobKey = '';
let planTimer: ReturnType<typeof setTimeout> | undefined;

let streamer: Streamer | undefined;
let originSetter: OriginSetter | undefined;
let machineState = '';
let lastWco: Axes | undefined;
/** Last reported pen position in machine mm, shown on the sheet while connected. */
let headPos: Point | undefined;

const AUTOCONNECT_KEY = 'penplotter.autoconnect';

// ---- drawing interaction ------------------------------------------------

interface Gesture {
  pointerId: number;
  start: Point;
  points: Point[];
  current: Point;
  shift: boolean;
}
let gesture: Gesture | undefined;
let eraserAt: Point | undefined;
const erasing = new Set<string>();

const area = () => drawableRect(settings.paperWidth, settings.paperHeight, settings.margin);
const clampToArea = (p: Point) => clampPoint(p, area());
const eraserRadius = () => 8 / view.pxPerMm;

function shapeFor(kind: StrokeKind, g: Gesture): Polyline {
  switch (kind) {
    case 'line':
      return lineShape(g.start, g.shift ? clampToArea(constrainAngle(g.start, g.current)) : g.current);
    case 'rect':
      return rectShape(g.start, g.shift ? clampToArea(constrainSquare(g.start, g.current)) : g.current);
    case 'ellipse':
      return ellipseShape(g.start, g.shift ? clampToArea(constrainSquare(g.start, g.current)) : g.current);
    default:
      return g.points;
  }
}

let lastErase: Point | undefined;

/** Mark strokes under the eraser, sweeping from the previous sample so fast drags miss nothing. */
function eraseAt(p: Point): void {
  const r = eraserRadius();
  const from = lastErase ?? p;
  const steps = Math.max(1, Math.ceil(dist(from, p) / (r / 2)));
  for (let i = 1; i <= steps; i++) {
    const q = { x: from.x + ((p.x - from.x) * i) / steps, y: from.y + ((p.y - from.y) * i) / steps };
    for (const s of drawing.strokes) {
      if (!erasing.has(s.id) && distToPolyline(q, s.points) <= r) erasing.add(s.id);
    }
  }
  lastErase = p;
}

const canvas = view.canvas;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || gesture) return;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // The pointer may already be gone (or be synthetic); drawing still works without capture.
  }
  const p = clampToArea(view.toPaper(e.clientX, e.clientY));
  gesture = { pointerId: e.pointerId, start: p, points: [p], current: p, shift: e.shiftKey };
  if (tool === 'eraser') {
    eraserAt = view.toPaper(e.clientX, e.clientY);
    lastErase = undefined;
    eraseAt(eraserAt);
  }
  render();
});

canvas.addEventListener('pointermove', (e) => {
  const raw = view.toPaper(e.clientX, e.clientY);
  $('cursor-pos').textContent = `${raw.x.toFixed(1)}, ${raw.y.toFixed(1)} mm`;
  if (tool === 'eraser') eraserAt = raw;
  if (!gesture || e.pointerId !== gesture.pointerId) {
    if (tool === 'eraser') render();
    return;
  }
  gesture.shift = e.shiftKey;
  const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
  for (const ev of events.length ? events : [e]) {
    const p = view.toPaper(ev.clientX, ev.clientY);
    if (tool === 'eraser') {
      eraseAt(p);
      continue;
    }
    const c = clampToArea(p);
    gesture.current = c;
    if (tool === 'freehand' && dist(c, gesture.points[gesture.points.length - 1]) >= 0.05) gesture.points.push(c);
  }
  render();
});

function endGesture(e: PointerEvent, cancelled: boolean): void {
  if (!gesture || e.pointerId !== gesture.pointerId) return;
  const g = gesture;
  gesture = undefined;
  if (tool === 'eraser') {
    if (!cancelled && erasing.size > 0) drawing.remove(erasing);
    erasing.clear();
  } else if (!cancelled) {
    if (tool === 'freehand') {
      drawing.add({ id: newId(), kind: 'freehand', points: g.points });
    } else {
      const shape = shapeFor(tool, g);
      const size = Math.max(...shape.map((p) => dist(p, shape[0])));
      // Ignore accidental clicks with a shape tool.
      if (size >= 0.5) drawing.add({ id: newId(), kind: tool, points: shape });
    }
  }
  render();
}
canvas.addEventListener('pointerup', (e) => endGesture(e, false));
canvas.addEventListener('pointercancel', (e) => endGesture(e, true));
canvas.addEventListener('pointerleave', () => {
  $('cursor-pos').textContent = '';
  if (tool === 'eraser' && !gesture) {
    eraserAt = undefined;
    render();
  }
});

function setTool(t: Tool): void {
  tool = t;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tool')) {
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(b.dataset.tool === t));
  }
  canvas.classList.toggle('erasing', t === 'eraser');
  if (t !== 'eraser') eraserAt = undefined;
  render();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.tool')) {
  b.addEventListener('click', () => setTool(b.dataset.tool as Tool));
}

// ---- rendering ----------------------------------------------------------

function travelSegments(j: Job): Polyline[] {
  const segs: Polyline[] = [];
  let pos: Point = { x: 0, y: 0 };
  for (const s of j.plan.strokes) {
    segs.push([pos, s[0]]);
    pos = s[s.length - 1];
  }
  segs.push([pos, { x: 0, y: 0 }]);
  return segs.map((seg) => seg.map((p) => fromMachine(p, settings)));
}

function render(): void {
  const strokes = drawing.strokes.filter((s) => !erasing.has(s.id)).map((s) => s.points);
  const showTravel = $<HTMLInputElement>('show-travel').checked && job && jobKey === currentJobKey();
  view.render({
    paperWidth: settings.paperWidth,
    paperHeight: settings.paperHeight,
    margin: settings.margin,
    origin: fromMachine({ x: 0, y: 0 }, settings),
    strokes,
    preview: gesture && tool !== 'eraser' ? shapeFor(tool, gesture) : undefined,
    travel: showTravel ? travelSegments(job!) : undefined,
    eraser: tool === 'eraser' && eraserAt ? { at: eraserAt, radius: eraserRadius() } : undefined,
    head: headPos ? fromMachine(headPos, settings) : undefined,
  });
}

function resize(): void {
  view.layout(settings.paperWidth, settings.paperHeight);
  render();
}
new ResizeObserver(resize).observe(canvas);

// ---- planning -----------------------------------------------------------

const currentJobKey = () => `${drawing.revision}|${JSON.stringify(settings)}`;

/** Plan + G-code for the drawing as it is now; cached until it or the settings change. */
function currentJob(): Job {
  const key = currentJobKey();
  if (!job || jobKey !== key) {
    job = buildJob([...drawing.strokes], settings);
    jobKey = key;
    renderStats();
  }
  return job;
}

function schedulePlan(): void {
  clearTimeout(planTimer);
  planTimer = setTimeout(() => {
    currentJob();
    render();
  }, 300);
}

const mm = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} m` : `${n.toFixed(0)} mm`);
function duration(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function renderStats(): void {
  const stats = $('stats');
  const warn = $('bounds-warning');
  if (!job || drawing.strokes.length === 0) {
    stats.innerHTML = '<dt>Strokes</dt><dd>0</dd>';
    warn.hidden = true;
    updateControls();
    return;
  }
  const p = job.plan;
  const saved = p.travelBefore > 0 ? Math.round((1 - p.travelAfter / p.travelBefore) * 100) : 0;
  const rows: Array<[string, string]> = [
    ['Strokes', `${p.inputCount} → ${p.mergedCount} after merging`],
    ['Points', String(job.pointCount)],
    ['Pen-down length', mm(p.drawLength)],
    ['Pen-up travel, as drawn', mm(p.travelBefore)],
    ['Pen-up travel, optimized', `${mm(p.travelAfter)} (−${saved}%)`],
    ['G-code lines', String(job.gcode.length)],
    ['Estimated time', duration(job.estimatedSeconds)],
  ];
  if (p.timedOut) rows.push(['Optimizer', `stopped at ${settings.optimizeTimeMs} ms limit`]);
  stats.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  stats.dataset.travelBefore = p.travelBefore.toFixed(3);
  stats.dataset.travelAfter = p.travelAfter.toFixed(3);
  if (!job.bounds.ok) {
    warn.hidden = false;
    warn.textContent = `${job.bounds.outside} point(s) in ${job.bounds.strokes} stroke(s) are outside the drawable area (paper minus margin). Erase or move them; the plotter will not be sent an out-of-bounds job.`;
  } else {
    warn.hidden = true;
  }
  updateControls();
}

drawing.onChange(() => {
  saveDrawing(drawing.strokes, settings.paperWidth, settings.paperHeight);
  updateControls();
  schedulePlan();
  render();
});

// ---- connection ---------------------------------------------------------

const conn = new FluidNCConnection({
  onState: () => {
    if (streamer?.active && (conn.connState === 'error' || conn.connState === 'disconnected')) {
      streamer.connectionLost();
    }
    if (conn.connState === 'error' || conn.connState === 'disconnected') originSetter?.connectionLost();
    updateIndicator();
    updateControls();
  },
  onStatus: (s) => renderMachine(s),
  onLine: (line) => {
    logLine(line);
    streamer?.handleLine(line);
    originSetter?.handleLine(line);
  },
});

function renderMachine(s: StatusReport): void {
  machineState = s.state;
  if (s.wco) lastWco = s.wco;
  const pos = workPosition(s, lastWco);
  const prevHead = headPos;
  headPos = pos ? { x: pos[0], y: pos[1] } : undefined;
  if (headPos?.x !== prevHead?.x || headPos?.y !== prevHead?.y) render();
  const sub = s.subState !== undefined ? `:${s.subState}` : '';
  $('machine-status').textContent = pos
    ? `${s.state}${sub}  X ${pos[0].toFixed(2)}  Y ${pos[1].toFixed(2)}  Z ${pos[2].toFixed(2)}`
    : `${s.state}${sub}`;
  $('machine-status').dataset.state = s.state;
  updateControls();
}

const LABELS: Record<ConnState | 'streaming', string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  streaming: 'Streaming',
  error: 'Error',
};

function updateIndicator(): void {
  const st = streamer?.progress.state;
  const streaming = streamer?.active && conn.connState !== 'error' && conn.connState !== 'disconnected';
  const state = streaming ? 'streaming' : conn.connState;
  let detail = conn.stateDetail;
  if (streaming) detail = st === 'paused' ? 'Paused' : st === 'stopping' ? 'Stopping…' : `to ${settings.host}`;
  else if (state === 'connected') detail = conn.currentUrl;
  $('conn').dataset.state = state;
  $('conn-label').textContent = LABELS[state];
  $('conn-detail').textContent = detail;
  $('conn-detail').title = detail;
  if (state !== 'connected' && state !== 'streaming') {
    $('machine-status').textContent = 'Machine: unknown';
    machineState = '';
    if (headPos) {
      headPos = undefined;
      render();
    }
  }
  const wanted = state !== 'disconnected';
  $('connect-btn').textContent = wanted ? 'Disconnect' : 'Connect';
}

function connect(): void {
  localStorage.setItem(AUTOCONNECT_KEY, '1');
  conn.connect(websocketUrl(settings));
}

$('connect-btn').addEventListener('click', () => {
  if (conn.connState === 'disconnected') {
    connect();
  } else {
    if (streamer?.active && !confirm('A job is running. Disconnecting stops streaming but the machine will finish its buffered moves. Disconnect anyway?')) return;
    localStorage.setItem(AUTOCONNECT_KEY, '0');
    conn.disconnect();
  }
});

// ---- console ------------------------------------------------------------

const consoleEl = $('console');
const consoleLines: string[] = [];
function logLine(line: string, kind: 'in' | 'out' | 'info' = 'in'): void {
  // Status replies arrive several times a second; ok floods during a job.
  if (kind === 'in' && (line.startsWith('<') || (line === 'ok' && streamer?.active))) return;
  consoleLines.push(kind === 'out' ? `> ${line}` : kind === 'info' ? `# ${line}` : line);
  if (consoleLines.length > 300) consoleLines.splice(0, consoleLines.length - 300);
  const atBottom = consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 4;
  consoleEl.textContent = consoleLines.join('\n');
  if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
}

/** A job or the Set origin sequence owns the controller. */
const machineBusy = () => !!streamer?.active || !!originSetter?.active;

function sendCommand(line: string): void {
  if (!conn.isConnected || machineBusy()) return;
  if (conn.sendLine(line)) logLine(line, 'out');
}

$('console-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('console-input');
  const line = input.value.trim();
  if (!line) return;
  sendCommand(line);
  input.value = '';
});
$('unlock-btn').addEventListener('click', () => sendCommand('$X'));
$('penup-btn').addEventListener('click', () => sendCommand(`G21 G90 G0 Z${fmt(settings.penUpZ)}`));
$('pendown-btn').addEventListener('click', () => sendCommand(`G21 G90 G0 Z${fmt(settings.penDownZ)}`));
$('home-btn').addEventListener('click', () => {
  sendCommand(`G21 G90 G0 Z${fmt(settings.penUpZ)}`);
  sendCommand('G0 X0 Y0');
});
$('origin-btn').addEventListener('click', () => {
  if (!conn.isConnected || machineBusy()) return;
  if (machineState !== 'Idle') {
    alert(
      machineState === 'Alarm'
        ? 'The machine is in Alarm. Press Unlock ($X) first.'
        : `The machine is ${machineState || 'not reporting its state'}. Wait until it is Idle.`,
    );
    return;
  }
  if (!confirm('Make the pen\'s current position X0 Y0? The pen lifts, and drawings and the travel limits count from this spot.')) return;
  logLine('setting origin at the current position', 'info');
  originSetter = new OriginSetter(
    (l) => {
      if (conn.sendLine(l)) logLine(l, 'out');
    },
    { onUpdate: renderOrigin },
  );
  originSetter.start();
});

function renderOrigin(p: OriginProgress): void {
  if (p.state === 'done' && p.result) {
    // FluidNC only repeats WCO every tenth status report, so update it here
    // rather than showing a stale offset for several seconds.
    const z = lastWco?.[2] ?? 0;
    const o = p.result.mode === 'offset' ? p.result.offset : { x: 0, y: 0 };
    lastWco = o ? [o.x, o.y, z] : undefined;
    headPos = { x: 0, y: 0 };
    render();
    const msg = describeOrigin(p.result);
    logLine(msg, 'info');
    if (p.result.mode === 'offset') alert(msg);
  } else if (p.state === 'failed') {
    logLine(`set origin failed: ${p.error}`, 'info');
    alert(`Set origin failed: ${p.error}`);
  }
  updateControls();
}

// ---- job ----------------------------------------------------------------

function renderJob(p: StreamProgress): void {
  const pct = p.total ? Math.floor((p.acked / p.total) * 100) : 0;
  $<HTMLProgressElement>('job-progress').value = pct;
  const words: Record<string, string> = {
    running: 'Streaming',
    paused: 'Paused',
    draining: 'All lines acknowledged, finishing moves',
    stopping: 'Stopping: soft reset sent',
    done: 'Done',
    stopped: 'Stopped, pen lifted',
    failed: 'Failed',
    idle: 'Ready',
  };
  const text = $('job-text');
  text.textContent = `${words[p.state]} · ${p.sent}/${p.total} sent · ${p.acked}/${p.total} acked · ${pct}%${p.error ? `\n${p.error}` : ''}`;
  text.classList.toggle('failed', p.state === 'failed');
  text.dataset.state = p.state;
  if (p.state === 'done' || p.state === 'stopped' || p.state === 'failed') {
    logLine(`job ${p.state}${p.error ? `: ${p.error}` : ''}`, 'info');
  }
  updateIndicator();
  updateControls();
}

$('send-btn').addEventListener('click', () => {
  if (!conn.isConnected || machineBusy()) return;
  const j = currentJob();
  if (!j.bounds.ok) {
    alert('Some strokes are outside the drawable area. Nothing was sent.');
    return;
  }
  if (j.gcode.length === 0) return;
  if (machineState === 'Alarm') {
    alert('The machine is in Alarm. Press Unlock ($X) first.');
    return;
  }
  logLine(`sending job: ${j.gcode.length} lines`, 'info');
  streamer = new Streamer(
    j.gcode,
    { sendLine: (l) => conn.sendLine(l), sendRealtime: (c) => conn.sendRealtime(c) },
    {
      maxInFlight: settings.maxInFlight,
      penUpLine: `G21 G90 G0 Z${fmt(settings.penUpZ)}`,
      onUpdate: renderJob,
    },
  );
  streamer.start();
});

$('pause-btn').addEventListener('click', () => streamer?.pause());
$('resume-btn').addEventListener('click', () => streamer?.resume());
$('stop-btn').addEventListener('click', () => streamer?.stop());

$('download-btn').addEventListener('click', () => {
  const j = currentJob();
  if (!j.bounds.ok) {
    alert('Some strokes are outside the drawable area. Fix them before exporting G-code.');
    return;
  }
  download('drawing.gcode', `${j.gcode.join('\n')}\n`, 'text/plain');
});

function updateControls(): void {
  const st = streamer?.progress.state;
  const active = !!streamer?.active;
  const busy = machineBusy();
  const outOfBounds = !!job && jobKey === currentJobKey() && !job.bounds.ok;
  const canSend = conn.isConnected && !busy && drawing.strokes.length > 0 && !outOfBounds;
  $<HTMLButtonElement>('send-btn').disabled = !canSend;
  $<HTMLButtonElement>('download-btn').disabled = drawing.strokes.length === 0;
  $('send-hint').textContent = !conn.isConnected
    ? 'Connect to the plotter to send.'
    : active
      ? 'A job is running.'
      : busy
        ? 'Setting the origin.'
        : drawing.strokes.length === 0
        ? 'Draw something first.'
        : outOfBounds
          ? 'The drawing is out of bounds.'
          : `Ready to send to ${settings.host}.`;
  $<HTMLButtonElement>('pause-btn').disabled = !(st === 'running' || st === 'draining');
  $<HTMLButtonElement>('resume-btn').disabled = st !== 'paused';
  $<HTMLButtonElement>('stop-btn').disabled = !active || st === 'stopping';
  for (const b of document.querySelectorAll<HTMLButtonElement>('.machine-cmd')) b.disabled = !conn.isConnected || busy;
  $<HTMLInputElement>('console-input').disabled = !conn.isConnected || busy;
  $<HTMLButtonElement>('undo-btn').disabled = !drawing.canUndo;
  $<HTMLButtonElement>('redo-btn').disabled = !drawing.canRedo;
  $<HTMLButtonElement>('clear-btn').disabled = drawing.strokes.length === 0;
}

// ---- edit / file actions ------------------------------------------------

$('undo-btn').addEventListener('click', () => drawing.undo());
$('redo-btn').addEventListener('click', () => drawing.redo());
$('clear-btn').addEventListener('click', () => {
  if (drawing.strokes.length > 0 && confirm('Clear the whole drawing? (Undo can bring it back.)')) drawing.clear();
});

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('export-svg-btn').addEventListener('click', () =>
  download('drawing.svg', toSVG(drawing.strokes, settings.paperWidth, settings.paperHeight), 'image/svg+xml'),
);
$('export-json-btn').addEventListener('click', () =>
  download(
    'drawing.json',
    JSON.stringify(toJSON(drawing.strokes, settings.paperWidth, settings.paperHeight), null, 1),
    'application/json',
  ),
);
$('import-btn').addEventListener('click', () => $<HTMLInputElement>('import-file').click());
$<HTMLInputElement>('import-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const strokes = text.trimStart().startsWith('{') ? fromJSON(JSON.parse(text)) : fromSVG(text);
    if (strokes.length === 0) throw new Error('No strokes found in the file');
    if (drawing.strokes.length > 0 && !confirm(`Replace the current drawing with ${strokes.length} imported stroke(s)?`)) return;
    drawing.replace(strokes);
  } catch (err) {
    alert(`Import failed: ${(err as Error).message}`);
  }
});

// ---- topo and photo -----------------------------------------------------

// What the generator dialogs need from the app: the sheet, the drawing, and a
// way to add their lines as one undo step.
const sheetHost = {
  area,
  paper: () => ({
    width: settings.paperWidth,
    height: settings.paperHeight,
    margin: settings.margin,
    origin: fromMachine({ x: 0, y: 0 }, settings),
  }),
  machine: () => settings,
  strokes: () => drawing.strokes.map((s) => s.points),
  insert: (lines: Polyline[]) => drawing.addMany(lines.map((points) => ({ id: newId(), kind: 'freehand', points }))),
};

$('topo-btn').addEventListener('click', async () => {
  try {
    const { openTopo } = await import('./topo-ui');
    openTopo(sheetHost);
  } catch (err) {
    alert(`Could not open the Topo map: ${(err as Error).message}`);
  }
});

async function openPhotoDialog(file?: File): Promise<void> {
  try {
    const { openPhoto } = await import('./photo-ui');
    openPhoto(sheetHost, file);
  } catch (err) {
    alert(`Could not open the Photo tool: ${(err as Error).message}`);
  }
}
$('photo-btn').addEventListener('click', () => void openPhotoDialog());
// Dropping an image on the sheet opens the Photo tool with it.
const stage = canvas.parentElement!;
stage.addEventListener('dragover', (e) => {
  if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
});
stage.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  e.preventDefault();
  if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') void openPhotoDialog(file);
  else alert('Drop a JPEG, PNG or WebP photo here to trace it. Use Import for SVG and JSON drawings.');
});

$('streets-btn').addEventListener('click', async () => {
  try {
    const { openStreets } = await import('./streets-ui');
    openStreets(sheetHost);
  } catch (err) {
    alert(`Could not open the Streets map: ${(err as Error).message}`);
  }
});

$('gen-btn').addEventListener('click', async () => {
  try {
    const { openGenerate } = await import('./generate-ui');
    openGenerate(sheetHost);
  } catch (err) {
    alert(`Could not open the Generate tool: ${(err as Error).message}`);
  }
});

// ---- keyboard -----------------------------------------------------------

const TOOL_KEYS: Record<string, Tool> = { p: 'freehand', l: 'line', r: 'rect', o: 'ellipse', e: 'eraser' };
window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('input, select, textarea, dialog')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) drawing.redo();
    else drawing.undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    drawing.redo();
  } else if (!mod && !e.altKey && TOOL_KEYS[e.key.toLowerCase()]) {
    setTool(TOOL_KEYS[e.key.toLowerCase()]);
  }
});

// ---- settings -----------------------------------------------------------

interface Field {
  key: keyof Settings;
  label: string;
  type: 'text' | 'number' | 'checkbox' | 'select';
  step?: number;
  options?: Array<[string, string]>;
}
const FIELDS: Array<Field | string> = [
  'Connection',
  { key: 'host', label: 'Host', type: 'text' },
  { key: 'port', label: 'WebSocket port', type: 'number', step: 1 },
  { key: 'path', label: 'WebSocket path', type: 'text' },
  'Paper',
  { key: 'paperWidth', label: 'Width (mm)', type: 'number', step: 1 },
  { key: 'paperHeight', label: 'Height (mm)', type: 'number', step: 1 },
  { key: 'margin', label: 'Margin (mm)', type: 'number', step: 1 },
  {
    key: 'originCorner',
    label: 'Machine X0 Y0 corner',
    type: 'select',
    options: [
      ['bottom-left', 'Bottom-left'],
      ['top-left', 'Top-left'],
    ],
  },
  'Pen and motion',
  { key: 'penUpZ', label: 'Pen up Z', type: 'number', step: 0.1 },
  { key: 'penDownZ', label: 'Pen down Z', type: 'number', step: 0.1 },
  { key: 'penDwell', label: 'Dwell after pen move (s)', type: 'number', step: 0.05 },
  { key: 'drawFeed', label: 'Draw feed (mm/min)', type: 'number', step: 100 },
  { key: 'travelFeed', label: 'Travel feed (mm/min)', type: 'number', step: 100 },
  { key: 'travelUseG1', label: 'Pen-up moves as G1 at travel feed', type: 'checkbox' },
  'Planning and streaming',
  { key: 'simplifyTolerance', label: 'Freehand simplify (mm)', type: 'number', step: 0.05 },
  { key: 'mergeTolerance', label: 'Join endpoints within (mm)', type: 'number', step: 0.05 },
  { key: 'optimizeTimeMs', label: 'Optimizer time limit (ms)', type: 'number', step: 100 },
  { key: 'maxInFlight', label: 'Lines in flight', type: 'number', step: 1 },
];

const form = $<HTMLFormElement>('settings-form');
function buildSettingsForm(): void {
  form.innerHTML = '';
  for (const f of FIELDS) {
    if (typeof f === 'string') {
      const h = document.createElement('h3');
      h.textContent = f;
      form.append(h);
      continue;
    }
    const label = document.createElement('label');
    label.textContent = f.label;
    label.htmlFor = `set-${f.key}`;
    let input: HTMLInputElement | HTMLSelectElement;
    if (f.type === 'select') {
      input = document.createElement('select');
      for (const [value, text] of f.options!) input.add(new Option(text, value));
    } else {
      input = document.createElement('input');
      input.type = f.type;
      if (f.step) input.step = String(f.step);
    }
    input.id = `set-${f.key}`;
    input.name = f.key;
    form.append(label, input);
  }
}

function fillSettingsForm(): void {
  for (const f of FIELDS) {
    if (typeof f === 'string') continue;
    const el = form.elements.namedItem(f.key) as HTMLInputElement | HTMLSelectElement;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(settings[f.key]);
    else el.value = String(settings[f.key]);
  }
}

function applySettings(next: Settings): void {
  const prev = settings;
  settings = next;
  saveSettings(settings);
  fillSettingsForm();
  if (prev.paperWidth !== next.paperWidth || prev.paperHeight !== next.paperHeight) {
    saveDrawing(drawing.strokes, settings.paperWidth, settings.paperHeight);
  }
  resize();
  schedulePlan();
  updateControls();
  if (websocketUrl(prev) !== websocketUrl(next) && conn.connState !== 'disconnected' && !streamer?.active) connect();
}

form.addEventListener('change', () => {
  const raw: Record<string, unknown> = {};
  for (const f of FIELDS) {
    if (typeof f === 'string') continue;
    const el = form.elements.namedItem(f.key) as HTMLInputElement | HTMLSelectElement;
    raw[f.key] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
  }
  applySettings(sanitizeSettings(raw));
});
form.addEventListener('submit', (e) => e.preventDefault());
$('reset-settings-btn').addEventListener('click', () => {
  if (confirm('Reset all settings to defaults?')) applySettings({ ...DEFAULT_SETTINGS });
});
$<HTMLInputElement>('show-travel').addEventListener('change', () => {
  currentJob();
  render();
});

// ---- boot ---------------------------------------------------------------

buildSettingsForm();
fillSettingsForm();
setTool('freehand');
resize();
currentJob();
updateIndicator();
updateControls();
if (localStorage.getItem(AUTOCONNECT_KEY) !== '0') connect();

// Exposed for debugging from the devtools console.
Object.assign(window, { plotter: { drawing, conn, get streamer() { return streamer; }, get settings() { return settings; }, currentJob } });
