import { fmt } from './gcode';
import { classifyResponse, type StatusReport } from './protocol';

// "Set origin": make the pen's current spot X0 Y0 so that FluidNC's soft
// limits move with it. Soft limits are checked in machine coordinates (MPos),
// so a work offset alone (G10 L20 / G92) leaves them counting from wherever the
// machine was at power-on. The only thing in FluidNC v4.1.1 that sets MPos
// without moving is a homing cycle of -1 (set_mpos_only): $H then assigns
// mpos_mm to that axis on the spot. firmware/config.yaml gives X and Y cycle -1.
//
// Sequence, one line at a time, each waiting for its ok:
//   G10 L2 P0 X0 Y0   zero the active work offset on X/Y, so WPos = MPos
//   G92.1             drop any G92 offset
//   $H                X/Y MPos := 0 here (no motion), pen lifts (Z cycle), and
//                     the parser and planner positions are re-synced
// Then the next status report must show MPos X0 Y0. With an older config.yaml
// (X/Y cycle 0) $H only lifts the pen, so MPos is unchanged; fall back to a work
// offset, G10 L20 P0 X0 Y0, and report how far the limits now are from the pen.

export const SET_ORIGIN_LINES = ['G10 L2 P0 X0 Y0', 'G92.1', '$H'] as const;
export const OFFSET_ORIGIN_LINE = 'G10 L20 P0 X0 Y0';

export type OriginState = 'idle' | 'sending' | 'verifying' | 'fallback' | 'done' | 'failed';

export type OriginResult =
  /** MPos is now X0 Y0: soft limits run from the new origin. */
  | { mode: 'machine' }
  /**
   * Only the work offset moved. `offset` is the machine position of the new
   * origin (when known), so soft limits (machine 0..max_travel) now cover work
   * -offset..max_travel-offset.
   */
  | { mode: 'offset'; offset?: { x: number; y: number }; reason: string };

export interface OriginProgress {
  state: OriginState;
  result?: OriginResult;
  error?: string;
}

export interface OriginOptions {
  /** Give up if the controller has not answered within this long. */
  timeoutMs?: number;
  onUpdate?: (p: OriginProgress) => void;
}

/** Machine positions within this of zero count as zero (one step at 80 steps/mm is 0.0125). */
const ZERO_MM = 0.01;

export class OriginSetter {
  private state: OriginState = 'idle';
  private queue: string[] = [];
  private current?: string;
  private result?: OriginResult;
  private error?: string;
  /** Machine X/Y from the latest status report seen while active. */
  private lastPos?: { x: number; y: number };
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly sendLine: (line: string) => void,
    private readonly opts: OriginOptions = {},
  ) {}

  get progress(): OriginProgress {
    return {
      state: this.state,
      ...(this.result ? { result: this.result } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  get active(): boolean {
    return this.state === 'sending' || this.state === 'verifying' || this.state === 'fallback';
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.state = 'sending';
    this.queue = [...SET_ORIGIN_LINES];
    this.next();
    this.emit();
  }

  /** Feed every console line from the controller through here, status reports included. */
  handleLine(line: string): void {
    if (!this.active) return;
    const r = classifyResponse(line);
    if (r.type === 'ok') {
      if (this.current === undefined) return;
      this.current = undefined;
      this.next();
    } else if (r.type === 'error' && this.current !== undefined) {
      if (this.current === '$H' && this.state === 'sending') {
        // No usable homing setup at all: the work offset is all we can do.
        this.current = undefined;
        this.beginFallback(this.lastPos, `$H was refused (${r.text})`);
      } else {
        this.fail(`${r.text} after ${this.current}`);
      }
    } else if (r.type === 'alarm') {
      this.fail(r.text);
    } else if (r.type === 'status') {
      if (r.status.mpos) this.lastPos = { x: r.status.mpos[0], y: r.status.mpos[1] };
      if (this.state === 'verifying') this.verify(r.status);
    }
  }

  /** The socket dropped mid-sequence. */
  connectionLost(): void {
    if (this.active) this.fail('Connection lost while setting the origin');
  }

  private next(): void {
    this.arm();
    const line = this.queue.shift();
    if (line !== undefined) {
      this.current = line;
      this.sendLine(line);
    } else if (this.state === 'sending') {
      // Wait for a status report sent after the last ok.
      this.state = 'verifying';
      this.emit();
    } else if (this.state === 'fallback') {
      this.finish(this.result!);
    }
  }

  private verify(s: StatusReport): void {
    // Work offsets were just zeroed, so a WPos-only report equals MPos here.
    const pos = s.mpos ?? s.wpos;
    if (!pos) return;
    if (Math.abs(pos[0]) < ZERO_MM && Math.abs(pos[1]) < ZERO_MM) {
      this.finish({ mode: 'machine' });
      return;
    }
    this.beginFallback(
      { x: pos[0], y: pos[1] },
      '$H did not move the machine position, so config.yaml on the controller still has homing cycle 0 for X/Y',
    );
  }

  private beginFallback(offset: { x: number; y: number } | undefined, reason: string): void {
    this.state = 'fallback';
    this.result = { mode: 'offset', ...(offset ? { offset } : {}), reason };
    this.queue = [OFFSET_ORIGIN_LINE];
    this.next();
    this.emit();
  }

  private finish(result: OriginResult): void {
    clearTimeout(this.timer);
    this.result = result;
    this.state = 'done';
    this.emit();
  }

  private fail(error: string): void {
    clearTimeout(this.timer);
    this.error = error;
    this.state = 'failed';
    this.emit();
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.active) this.fail(`No reply from the controller${this.current ? ` to ${this.current}` : ''}`);
    }, this.opts.timeoutMs ?? 10000);
  }

  private emit(): void {
    this.opts.onUpdate?.(this.progress);
  }
}

/** One or two sentences for the console/alert describing how the origin was set. */
export function describeOrigin(result: OriginResult, maxTravel = 400): string {
  if (result.mode === 'machine') return 'Origin set: the pen is at X0 Y0 and the travel limits now count from here.';
  const o = result.offset;
  const window = o
    ? ` Reachable now: X ${fmt(-o.x)} to ${fmt(maxTravel - o.x)}, Y ${fmt(-o.y)} to ${fmt(maxTravel - o.y)} (with max_travel_mm ${fmt(maxTravel)}).`
    : '';
  return (
    `Origin set as a work offset only: ${result.reason}. ` +
    `The travel limits still count from where the machine was at power-on.${window} ` +
    'Upload the current firmware/config.yaml and restart the controller so Set origin moves the limits too.'
  );
}
