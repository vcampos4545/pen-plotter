import { classifyResponse, REALTIME, type StatusReport } from './protocol';

// Line-by-line G-code streaming with "ok"-counting flow control. At most
// `maxInFlight` lines are unacknowledged at any time; every ok releases the
// next line. error:/ALARM: abort the job, which runs the same sequence as Stop:
// soft reset (0x18), wait for the banner, unlock, then lift the pen.

export type StreamState =
  | 'idle'
  | 'running'
  | 'paused'
  /** Every line acked; waiting for the machine to finish moving. */
  | 'draining'
  /** Soft reset sent; waiting for the controller to come back. */
  | 'stopping'
  | 'done'
  | 'stopped'
  | 'failed';

export interface StreamProgress {
  state: StreamState;
  total: number;
  sent: number;
  acked: number;
  error?: string;
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
  onUpdate?: (p: StreamProgress) => void;
}

export const isActive = (s: StreamState) => s === 'running' || s === 'paused' || s === 'draining' || s === 'stopping';

export class Streamer {
  private state: StreamState = 'idle';
  private sent = 0;
  private acked = 0;
  private error?: string;
  private resumeTo: StreamState = 'running';
  private resetTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly lines: readonly string[],
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
    };
  }

  get active(): boolean {
    return isActive(this.state);
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
    if (this.state !== 'paused') return;
    this.io.sendRealtime(REALTIME.cycleStart);
    this.state = this.resumeTo;
    this.pump();
    this.emit();
  }

  /** Abort: soft reset now, then unlock and lift the pen once the controller is back. */
  stop(reason?: string): void {
    if (!this.active || this.state === 'stopping') return;
    if (reason) this.error = reason;
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
          if (this.acked < this.sent) this.acked++;
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
          const at = r.type === 'error' ? ` after line ${this.acked + 1}: ${this.lines[this.acked] ?? ''}` : '';
          this.stop(`${r.text}${at}`);
        }
        break;
      case 'greeting':
        if (this.state === 'stopping') this.finishStop();
        break;
      case 'status':
        this.handleStatus(r.status);
        break;
      default:
        break;
    }
  }

  handleStatus(s: StatusReport): void {
    if (this.state === 'draining' && s.state === 'Idle') {
      this.state = 'done';
      this.emit();
    } else if ((this.state === 'running' || this.state === 'draining') && s.state === 'Alarm') {
      this.stop('Machine entered Alarm state');
    }
  }

  /** The socket dropped: nothing more can be sent or acknowledged. */
  connectionLost(): void {
    if (!this.active) return;
    clearTimeout(this.resetTimer);
    this.error = this.error ?? 'Connection lost during job';
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
    while (this.sent < this.lines.length && this.sent - this.acked < this.opts.maxInFlight) {
      this.io.sendLine(this.lines[this.sent++]);
    }
  }

  private emit(): void {
    this.opts.onUpdate?.(this.progress);
  }
}
