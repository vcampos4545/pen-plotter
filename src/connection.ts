import { classifyResponse, isControlMessage, LineAssembler, REALTIME, type StatusReport } from './protocol';

// Browser-side link to FluidNC's WebSocket. Polls "?" and only reports
// "connected" while the socket is open AND a status report arrived recently.
// Reconnects with exponential backoff until disconnect() is called.

export type ConnState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionOptions {
  /** Interval between "?" status queries, ms. */
  pollMs?: number;
  /** A status report older than this no longer counts as "connected", ms. */
  staleMs?: number;
  /** Give up on a socket with no status reply for this long and reconnect, ms. */
  timeoutMs?: number;
  /** Max time for the WebSocket handshake, ms. */
  openTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Injected for tests; defaults to the global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
  onState?: (state: ConnState, detail: string) => void;
  onLine?: (line: string) => void;
  onStatus?: (status: StatusReport) => void;
}

export class FluidNCConnection {
  private ws?: WebSocket;
  private url = '';
  private wanted = false;
  private state: ConnState = 'disconnected';
  private detail = '';
  private attempt = 0;
  private openedAt = 0;
  private lastStatusAt = 0;
  private pollTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private openTimer?: ReturnType<typeof setTimeout>;
  private assembler = new LineAssembler();
  private decoder = new TextDecoder();
  private readonly o: Required<Omit<ConnectionOptions, 'onState' | 'onLine' | 'onStatus' | 'WebSocketImpl'>>;

  constructor(private readonly opts: ConnectionOptions = {}) {
    this.o = {
      pollMs: opts.pollMs ?? 500,
      staleMs: opts.staleMs ?? 2500,
      timeoutMs: opts.timeoutMs ?? 5000,
      openTimeoutMs: opts.openTimeoutMs ?? 6000,
      backoffMinMs: opts.backoffMinMs ?? 1000,
      backoffMaxMs: opts.backoffMaxMs ?? 15000,
    };
  }

  get connState(): ConnState {
    return this.state;
  }

  get stateDetail(): string {
    return this.detail;
  }

  get currentUrl(): string {
    return this.url;
  }

  /** Socket open and FluidNC answered a recent status query. */
  get isConnected(): boolean {
    return this.state === 'connected';
  }

  connect(url: string): void {
    this.url = url;
    this.wanted = true;
    this.attempt = 0;
    this.teardown();
    this.open();
  }

  disconnect(): void {
    this.wanted = false;
    this.teardown();
    this.setState('disconnected', '');
  }

  /** Send one G-code/command line. Returns false when the socket is not open. */
  sendLine(line: string): boolean {
    return this.raw(`${line}\n`);
  }

  /** Send a single realtime character (?, !, ~, 0x18); these bypass the line buffer. */
  sendRealtime(ch: string): boolean {
    return this.raw(ch);
  }

  private raw(data: string): boolean {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) return false;
    this.ws.send(data);
    return true;
  }

  private open(): void {
    const Impl = this.opts.WebSocketImpl ?? globalThis.WebSocket;
    this.setState('connecting', `Connecting to ${this.url}`);
    let ws: WebSocket;
    try {
      ws = new Impl(this.url);
    } catch (e) {
      this.fail(`Bad WebSocket URL: ${(e as Error).message}`);
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.assembler.reset();
    this.decoder = new TextDecoder();
    this.lastStatusAt = 0;

    this.openTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== 1) this.fail('Timed out opening the WebSocket');
    }, this.o.openTimeoutMs);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      clearTimeout(this.openTimer);
      this.openedAt = Date.now();
      this.setState('connecting', 'Socket open, waiting for status reply');
      this.sendRealtime(REALTIME.status);
      this.pollTimer = setInterval(() => this.tick(), this.o.pollMs);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      if (typeof ev.data === 'string') {
        if (isControlMessage(ev.data)) return;
        this.consume(ev.data);
      } else if (ev.data instanceof ArrayBuffer) {
        this.consume(this.decoder.decode(ev.data, { stream: true }));
      }
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.fail(ev.reason ? `Connection closed: ${ev.reason}` : 'Connection closed');
    };
    // onclose always follows onerror; handle the outcome there.
    ws.onerror = () => {};
  }

  private consume(text: string): void {
    for (const line of this.assembler.push(text)) {
      const r = classifyResponse(line);
      if (r.type === 'status') {
        this.lastStatusAt = Date.now();
        if (this.state !== 'connected') {
          this.attempt = 0;
          this.setState('connected', 'FluidNC is answering');
        }
        this.opts.onStatus?.(r.status);
      }
      this.opts.onLine?.(line);
    }
  }

  private tick(): void {
    const now = Date.now();
    const last = this.lastStatusAt || this.openedAt;
    if (now - last > this.o.timeoutMs) {
      this.fail('No status reply from FluidNC');
      return;
    }
    if (this.state === 'connected' && now - this.lastStatusAt > this.o.staleMs) {
      this.setState('connecting', 'Waiting for status reply');
    }
    this.sendRealtime(REALTIME.status);
  }

  /** Drop the socket and, if still wanted, retry with backoff. */
  private fail(reason: string): void {
    this.teardown();
    if (!this.wanted) {
      this.setState('disconnected', '');
      return;
    }
    const delay = Math.min(this.o.backoffMaxMs, this.o.backoffMinMs * 2 ** this.attempt);
    this.attempt++;
    this.setState('error', `${reason}. Retrying in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      if (this.wanted) this.open();
    }, delay);
  }

  private teardown(): void {
    clearInterval(this.pollTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.openTimer);
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }

  private setState(state: ConnState, detail: string): void {
    const changed = state !== this.state || detail !== this.detail;
    this.state = state;
    this.detail = detail;
    if (changed) this.opts.onState?.(state, detail);
  }
}
