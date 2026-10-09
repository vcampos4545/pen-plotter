import type { Point, Polyline } from './geometry';

// Canvas rendering. The sheet is drawn at a fixed aspect ratio, scaled to fit
// the stage. All inputs are paper mm; this class owns the mm <-> pixel mapping.

export interface Scene {
  paperWidth: number;
  paperHeight: number;
  margin: number;
  /** Paper-space position of machine X0 Y0. */
  origin: Point;
  strokes: Polyline[];
  /** Shape or stroke being drawn right now. */
  preview?: Polyline;
  /** Pen-up moves, each a 2-point segment, in drawing order. */
  travel?: Polyline[];
  /** Eraser cursor, in mm. */
  eraser?: { at: Point; radius: number };
  /** Live machine pen position, paper mm. */
  head?: Point;
}

const PAD_PX = 24;
const PEN_WIDTH_MM = 0.6;

export class CanvasView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale = 1; // px per mm (CSS pixels)
  private offX = 0;
  private offY = 0;
  private cssW = 0;
  private cssH = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  /** Pixels per mm at the current size. */
  get pxPerMm(): number {
    return this.scale;
  }

  /** Fit the sheet into the canvas' CSS box, keeping its aspect ratio. */
  layout(paperWidth: number, paperHeight: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.cssW = Math.max(1, rect.width);
    this.cssH = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.scale = Math.max(0.01, Math.min((this.cssW - 2 * PAD_PX) / paperWidth, (this.cssH - 2 * PAD_PX) / paperHeight));
    this.offX = (this.cssW - paperWidth * this.scale) / 2;
    this.offY = (this.cssH - paperHeight * this.scale) / 2;
  }

  toPaper(clientX: number, clientY: number): Point {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.offX) / this.scale,
      y: (clientY - rect.top - this.offY) / this.scale,
    };
  }

  private px(p: Point): [number, number] {
    return [this.offX + p.x * this.scale, this.offY + p.y * this.scale];
  }

  private path(points: Polyline): void {
    const ctx = this.ctx;
    ctx.beginPath();
    if (points.length === 1) {
      const [x, y] = this.px(points[0]);
      ctx.moveTo(x, y);
      ctx.lineTo(x + 0.01, y);
      return;
    }
    points.forEach((p, i) => {
      const [x, y] = this.px(p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
  }

  render(scene: Scene): void {
    const ctx = this.ctx;
    const s = this.scale;
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    // Sheet with shadow and outline.
    const [px0, py0] = this.px({ x: 0, y: 0 });
    const pw = scene.paperWidth * s;
    const ph = scene.paperHeight * s;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#fff';
    ctx.fillRect(px0, py0, pw, ph);
    ctx.restore();
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.strokeRect(px0 + 0.5, py0 + 0.5, pw - 1, ph - 1);

    // Margin (drawable area).
    if (scene.margin > 0) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#b8c4d6';
      const m = scene.margin * s;
      ctx.strokeRect(px0 + m, py0 + m, pw - 2 * m, ph - 2 * m);
      ctx.restore();
    }

    // Machine origin marker.
    const [ox, oy] = this.px(scene.origin);
    ctx.fillStyle = '#d33';
    ctx.beginPath();
    ctx.arc(ox, oy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('X0 Y0', ox + 6, oy + (scene.origin.y > scene.paperHeight / 2 ? -6 : 14));

    // Strokes.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = Math.max(1.25, PEN_WIDTH_MM * s);
    for (const st of scene.strokes) {
      this.path(st);
      ctx.stroke();
    }
    if (scene.preview) {
      ctx.strokeStyle = '#2563eb';
      this.path(scene.preview);
      ctx.stroke();
    }

    // Pen-up travel overlay.
    if (scene.travel) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(220, 38, 38, 0.8)';
      ctx.lineWidth = 1;
      for (const seg of scene.travel) {
        this.path(seg);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (scene.head) {
      const [hx, hy] = this.px(scene.head);
      ctx.save();
      ctx.strokeStyle = '#16a34a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(hx, hy, 6, 0, Math.PI * 2);
      ctx.moveTo(hx - 10, hy);
      ctx.lineTo(hx + 10, hy);
      ctx.moveTo(hx, hy - 10);
      ctx.lineTo(hx, hy + 10);
      ctx.stroke();
      ctx.restore();
    }

    if (scene.eraser) {
      const [ex, ey] = this.px(scene.eraser.at);
      ctx.save();
      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ex, ey, scene.eraser.radius * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}
