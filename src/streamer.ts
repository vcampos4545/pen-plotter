import { classifyResponse, REALTIME, workPosition, type Axes, type StatusReport } from './protocol';
import { findExecutedCount, resumePreamble, trackProgram, type PreambleOptions, type ProgramPoint } from './resume';

// Line-by-line G-code streaming with "ok"-counting flow control. At most
// `maxInFlight` lines are unacknowledged at any time; every ok releases the
// next line. error:/ALARM: abort the job, which runs the same sequence as Stop:
// soft reset (0x18), wait for the banner, unlock, then lift the pen.
//
// A dropped connection does not end the job. FluidNC keeps running what it had
// queued, so the job goes to "reconnecting" (and "interrupted" after the grace
// window or once the link is back). Resume then waits for the machine to come to
// rest, works out from its position which line it stopped after, lifts the pen,
// travels back, and continues from the next line. See src/resume.ts.

export type StreamState =
  | 'idle'
  | 'running'
  | 'paused'
  /** Every line acked; waiting for the machine to finish moving. */
  | 'draining'
  /** Soft reset sent; waiting for the controller to come back. */
  | 'stopping'
  /** The link dropped mid-job; waiting for it to come back (grace window). */
  | 'reconnecting'
  /** The link dropped mid-job. Resume once the plotter is connected again. */
  | 'interrupted'
  /** Resume pressed: waiting for the machine to stop moving, then placing the restart. */
  | 'resyncing'
  | 'done'
  | 'stopped'
  | 'failed';

export interface StreamProgress {
  state: StreamState;
  total: number;
  sent: number;
  acked: number;
  error?: string;
  /** Plain-language detail for reconnecting / interrupted / resyncing. */
  note?: string;
  /** Interrupted and ready: the link is back and the machine has reported in. */
  canResume?: boolean;
}

export interface StreamerIO {
  sendLine(line: string): void;
  sendRealtime(ch: string): void;
}

export interface StreamerOptions {
  maxInFlight: number;
  /** Sent after the post-stop unlock, e.g. "G21 G90 G0 Z5". */
  penUpLine: string;
  /** How long to wait for the reset banner before lifting the pen anyway. */
  resetTimeoutMs?: number;
  /** How long a dropped link shows as "reconnecting" before "interrupted". */
  graceMs?: number;
  /** How to lift, travel and lower the pen when resuming after a drop. */
  resume?: PreambleOptions;
  onUpdate?: (p: StreamProgress) => void;
}

export const isActive = (s: StreamState) =>
  s === 'running' ||
  s === 'paused' ||
  s === 'draining' ||
  s === 'stopping' ||
  s === 'reconnecting' ||
  s === 'interrupted' ||
  s === 'resyncing';

const DEFAULT_PREAMBLE: PreambleOptions = { penUpZ: 5, penDwell: 0, travelUseG1: false, travelFeed: 6000 };

export class Streamer {
  private state: StreamState = 'idle';
  /** Next job line to send. */
  private sent = 0;
  /** Job lines acknowledged (they are acknowledged in order). */
  private acked = 0;
  /** Lines sent and not yet acknowledged: a job line index, or -1 for a resume preamble line. */
  private inFlight: number[] = [];
  /** Resume preamble lines waiting to be sent before the job continues. */
  private preamble: string[] = [];
  private error?: string;
  private note?: string;
  private resumeTo: StreamState = 'running';
  private resetTimer?: ReturnType<typeof setTimeout>;
  private graceTimer?: ReturnType<typeof setTimeout>;
  private linkUp = true;
  /** A status report arrived since the link came back. */
  private status?: StatusReport;
  private wco?: Axes;
  private points?: ProgramPoint[] | null;

  constructor(
    readonly lines: readonly string[],
    private readonly io: StreamerIO,
    private readonly opts: StreamerOptions,
  ) {}

  get progress(): StreamProgress {
    return {
      state: this.state,
      total: this.lines.length,
      sent: this.sent,
      acked: this.acked,
      ...(this.error ? { error: this.error } : {}),
      ...(this.note ? { note: this.note } : {}),
      ...(this.state === 'interrupted' ? { canResume: this.canResume } : {}),
    };
  }

  get active(): boolean {
    return isActive(this.state);
  }

  get canResume(): boolean {
    return this.state === 'interrupted' && this.linkUp && !!this.status;
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.state = this.lines.length > 0 ? 'running' : 'done';
    this.pump();
    this.emit();
  }

  pause(): void {
    if (this.state !== 'running' && this.state !== 'draining') return;
    this.io.sendRealtime(REALTIME.feedHold);
    this.resumeTo = this.state;
    this.state = 'paused';
    this.emit();
  }

  resume(): void {
    if (this.state === 'paused') {
      this.io.sendRealtime(REALTIME.cycleStart);
      this.state = this.resumeTo;
      this.pump();
      this.emit();
    } else if (this.canResume) {
      this.state = 'resyncing';
      this.error = undefined;
      this.note = 'Waiting for the plotter to finish its buffered moves';
      this.emit();
      if (this.status) this.resync(this.status);
    }
  }

  /** Abort: soft reset now, then unlock and lift the pen once the controller is back. */
  stop(reason?: string): void {
    if (!this.active || this.state === 'stopping') return;
    if (reason) this.error = reason;
    clearTimeout(this.graceTimer);
    this.note = undefined;
    if (!this.linkUp) {
      // Nothing can reach the controller. Give up on the job; the machine
      // finishes whatever it had queued with the pen where it is.
      this.state = this.error ? 'failed' : 'stopped';
      this.emit();
      return;
    }
    this.io.sendRealtime(REALTIME.softReset);
    this.state = 'stopping';
    this.resetTimer = setTimeout(() => this.finishStop(), this.opts.resetTimeoutMs ?? 2500);
    this.emit();
  }

  /** Feed every console line from the controller through here. */
  handleLine(line: string): void {
    const r = classifyResponse(line);
    switch (r.type) {
      case 'ok':
        if (this.state === 'running' || this.state === 'paused' || this.state === 'draining') {
          const idx = this.inFlight.shift();
          if (idx !== undefined && idx >= 0) this.acked = idx + 1;
          if (this.acked === this.lines.length && this.state === 'running') this.state = 'draining';
          if (this.acked === this.lines.length && this.state === 'paused') this.resumeTo = 'draining';
          this.pump();
          this.emit();
        }
        break;
      case 'error':
      case 'alarm':
        // While stopping, ALARM:3 (reset during motion) and late errors are expected.
        if (this.state === 'running' || this.state === 'paused' || this.state === 'draining') {
          const idx = this.inFlight[0];
          const at =
            r.type === 'error'
              ? idx === -1
                ? ' while resuming'
                : ` after line ${this.acked + 1}: ${this.lines[this.acked] ?? ''}`
              : '';
          this.stop(`${r.text}${at}`);
        } else if (r.type === 'alarm' && (this.state === 'interrupted' || this.state === 'resyncing')) {
          this.fail(`${r.text} while reconnected; the plotter's position can no longer be trusted`);
        }
        break;
      case 'greeting':
        if (this.state === 'stopping') this.finishStop();
        else if (this.state === 'interrupted' || this.state === 'resyncing') {
          this.fail('The controller restarted during the drop, so its position is lost');
        }
        break;
      case 'status':
        this.handleStatus(r.status);
        break;
      default:
        break;
    }
  }

  handleStatus(s: StatusReport): void {
    if (s.wco) this.wco = s.wco;
    if (this.state === 'draining' && s.state === 'Idle') {
      this.state = 'done';
      this.emit();
    } else if ((this.state === 'running' || this.state === 'draining') && s.state === 'Alarm') {
      this.stop('Machine entered Alarm state');
    } else if (this.state === 'interrupted' && this.linkUp) {
      const first = !this.status;
      this.status = s;
      // Everything was acknowledged before the drop: nothing to resume.
      if (this.acked === this.lines.length && s.state === 'Idle') {
        this.finish();
      } else if (first) {
        this.note = `Reconnected. Press Resume to continue from where the plotter stopped (${this.where()})`;
        this.emit();
      }
    } else if (this.state === 'resyncing') {
      this.status = s;
      this.resync(s);
    }
  }

  /** The socket dropped: nothing more can be sent or acknowledged. */
  connectionLost(): void {
    if (!this.linkUp) return;
    this.linkUp = false;
    this.status = undefined;
    if (!this.active) return;
    clearTimeout(this.resetTimer);
    if (this.state === 'stopping') {
      // The reset already went out; the unlock and pen lift cannot.
      this.state = this.error ? 'failed' : 'stopped';
      this.note = 'Connection lost while stopping, so the pen may still be down';
      this.emit();
      return;
    }
    this.inFlight = [];
    this.preamble = [];
    this.state = 'reconnecting';
    this.note = `Connection lost at ${this.where()}. Reconnecting…`;
    clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      if (this.state !== 'reconnecting') return;
      this.state = 'interrupted';
      this.note = `Connection lost at ${this.where()}. Resume becomes available when the plotter reconnects`;
      this.emit();
    }, this.opts.graceMs ?? 30000);
    this.emit();
  }

  /** The socket is back and FluidNC answered a status query. */
  connectionRestored(): void {
    if (this.linkUp) return;
    this.linkUp = true;
    this.status = undefined;
    if (this.state !== 'reconnecting' && this.state !== 'interrupted') return;
    clearTimeout(this.graceTimer);
    this.state = 'interrupted';
    this.note = 'Reconnected. Waiting for the plotter to report its state';
    this.emit();
  }

  /** Resume pressed after a drop: let the machine settle, then place the restart. */
  private resync(s: StatusReport): void {
    if (s.state === 'Alarm') {
      this.fail("The plotter is in Alarm after the drop, so its position can't be trusted");
      return;
    }
    if (s.state === 'Hold') {
      // Held before or during the drop: let the buffered moves finish first.
      if (s.subState === undefined || s.subState === '0') this.io.sendRealtime(REALTIME.cycleStart);
      return;
    }
    if (s.state !== 'Idle') {
      if (s.state === 'Run' || s.state === 'Jog') return; // still finishing buffered moves
      this.fail(`The plotter is in ${s.state} state, so the job can't be resumed`);
      return;
    }
    if (this.points === undefined) this.points = trackProgram(this.lines) ?? null;
    if (!this.points) {
      this.fail('This job uses G-code the resume logic does not model, so it cannot be resumed safely');
      return;
    }
    const pos = workPosition(s, this.wco);
    const n = pos ? findExecutedCount(this.points, this.acked, this.sent, { x: pos[0], y: pos[1] }) : undefined;
    if (n === undefined) {
      const at = pos ? ` X${pos[0].toFixed(2)} Y${pos[1].toFixed(2)}` : '';
      this.fail(
        `The plotter is at${at}, which is not where any of lines ${this.acked + 1}–${this.sent} ends. ` +
          'It may have restarted or lost steps, so the job was not resumed',
      );
      return;
    }
    if (n >= this.lines.length) {
      this.acked = this.sent = n;
      this.finish();
      return;
    }
    this.acked = this.sent = n;
    this.inFlight = [];
    this.preamble = resumePreamble(this.points[n], this.opts.resume ?? DEFAULT_PREAMBLE);
    this.note = `Resumed at line ${n + 1} of ${this.lines.length}`;
    this.state = 'running';
    this.pump();
    this.emit();
  }

  private where(): string {
    return `line ${this.acked + 1} of ${this.lines.length}`;
  }

  private finish(): void {
    clearTimeout(this.graceTimer);
    this.state = 'done';
    this.note = undefined;
    this.emit();
  }

  private fail(reason: string): void {
    clearTimeout(this.graceTimer);
    this.error = reason;
    this.note = undefined;
    this.state = 'failed';
    this.emit();
  }

  private finishStop(): void {
    if (this.state !== 'stopping') return;
    clearTimeout(this.resetTimer);
    // A reset during motion leaves FluidNC in Alarm; unlock so the pen can lift.
    this.io.sendLine('$X');
    this.io.sendLine(this.opts.penUpLine);
    this.state = this.error ? 'failed' : 'stopped';
    this.emit();
  }

  private pump(): void {
    if (this.state !== 'running') return;
    while (this.inFlight.length < this.opts.maxInFlight) {
      const pre = this.preamble.shift();
      if (pre !== undefined) {
        this.inFlight.push(-1);
        this.io.sendLine(pre);
      } else if (this.sent < this.lines.length) {
        this.inFlight.push(this.sent);
        this.io.sendLine(this.lines[this.sent++]);
      } else {
        break;
      }
    }
  }

  private emit(): void {
    this.opts.onUpdate?.(this.progress);
  }
}
