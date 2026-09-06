/**
 * Internal transport implementations for {@link Client}.
 *
 * Both transports implement the small {@link Transport} contract so the
 * client can select, connect, and delegate `send`/`close` without knowing
 * which wire mechanism is in use. Reconnect policy, persistence, and topic
 * dispatch remain the responsibility of {@link Client} — these units only
 * own their respective connection's lifecycle framing.
 *
 * Send/ack handoff contract: `send()` resolving means only that the frame
 * was handed to the local browser transport for transmission — the wire
 * protocol carries no broker acknowledgement. `Client` treats a resolved
 * `send()` as authorization to delete the record from its IndexedDB pending
 * store, so a transport MUST reject `send()` (fail closed) whenever it
 * cannot be certain the frame was actually written to a live, current
 * connection. Resolving optimistically — e.g. on a closing/closed/replaced
 * socket — would silently drop the record with no way to recover it.
 */
import { StreamlineError, StreamlineErrorCode } from "./types.js";

export type TransportKind = "webtransport" | "websocket";

/**
 * `WebSocket.OPEN` per the WHATWG spec. The numeric readyState values
 * (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED) are stable across
 * implementations, so we compare against the literal rather than the
 * constructor's static property — the latter may be absent on minimal
 * test doubles that stand in for the global `WebSocket`.
 */
const WS_OPEN = 1;

/** Callbacks a {@link Transport} invokes on the owning {@link Client}. */
export interface TransportCallbacks {
  /** Invoked for each incoming frame (raw string or ArrayBuffer) from the broker. */
  onFrame: (data: ArrayBuffer | string) => void;
  /** Invoked when the transport disconnects, intentionally or not. */
  onDisconnect: () => void;
}

/**
 * Contract shared by {@link WebSocketTransport} and {@link WebTransportTransport}.
 */
export interface Transport {
  readonly kind: TransportKind;
  /** Establish the browser transport; resolves once the local API is ready to send. */
  connect(callbacks: TransportCallbacks): Promise<void>;
  /**
   * Send a binary frame over this transport. Resolution means only "handed
   * off to the local transport", not "acknowledged by the broker" — there is
   * no ack in the wire protocol. Implementations MUST reject rather than
   * resolve if the frame cannot be sent on a live, current connection.
   */
  send(data: ArrayBuffer): Promise<void>;
  /** Close the transport. Safe to call even if already closed. */
  close(): Promise<void>;
}

// --------------------------------------------------------------------------
// WebSocket transport
// --------------------------------------------------------------------------

export class WebSocketTransport implements Transport {
  readonly kind: TransportKind = "websocket";

  private socket?: WebSocket;
  private socketGeneration?: number;

  /**
   * Monotonic fence incremented by `close()` (and at the start of each
   * `connect()` attempt) to invalidate any in-flight socket's callbacks.
   * Without this, a socket whose `open` event fires *after* the transport
   * has been closed (or superseded by a newer `connect()`) would silently
   * resurrect itself as `this.socket`, letting a later `send()` succeed
   * against a connection the owner believes is gone.
   */
  private generation = 0;

  /** Set by `close()`; once true this transport can never send/connect again. */
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly token?: string,
  ) {}

  connect(callbacks: TransportCallbacks): Promise<void> {
    if (this.closed) {
      return Promise.reject(new StreamlineError(
        "Cannot connect() a closed WebSocketTransport",
        StreamlineErrorCode.Connection,
        { retryable: false },
      ));
    }
    const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      const wsUrl = this.url.replace(/^http/, "ws");
      const sock = new WebSocket(wsUrl);
      sock.binaryType = "arraybuffer";
      sock.onopen = () => {
        // This attempt may have been superseded by close() or a newer
        // connect() while the socket was still opening. Discard it instead
        // of resurrecting a connection the transport no longer owns.
        if (this.closed || generation !== this.generation) {
          try {
            sock.close();
          } catch {
            /* already closed */
          }
          return;
        }
        if (this.token) {
          sock.send(JSON.stringify({ type: "auth", token: this.token }));
        }
        this.socket = sock;
        this.socketGeneration = generation;

        sock.onmessage = (event: MessageEvent<unknown>) => {
          if (generation !== this.generation) return;
          if (typeof event.data === "string" || event.data instanceof ArrayBuffer) {
            callbacks.onFrame(event.data);
          }
        };
        sock.onclose = () => {
          if (generation !== this.generation) return;
          this.socket = undefined;
          this.socketGeneration = undefined;
          callbacks.onDisconnect();
        };

        resolve();
      };
      sock.onerror = (e) => reject(new StreamlineError(
        `WebSocket connection failed: ${String(e)}`,
        StreamlineErrorCode.Transport,
        { retryable: true, hint: "Check that the Streamline server is running and accessible" },
      ));
    });
  }

  /**
   * Send a binary frame over the socket, iff it is this transport's current
   * generation *and* actually OPEN at the moment of sending.
   *
   * There is no broker acknowledgement in the current wire protocol — the
   * caller (see {@link Client.produce}) removes the record from durable
   * IndexedDB storage as soon as `send()` resolves. A silent no-op or a
   * send against a stale/closing/closed socket would therefore cause data
   * loss, so this fails closed (rejects) rather than swallowing the error.
   */
  send(data: ArrayBuffer): Promise<void> {
    const sock = this.socket;
    if (
      this.closed ||
      !sock ||
      this.socketGeneration !== this.generation ||
      sock.readyState !== WS_OPEN
    ) {
      return Promise.reject(new StreamlineError(
        "WebSocket is not open — refusing to send",
        StreamlineErrorCode.Connection,
        { retryable: true, hint: "Wait for reconnect before retrying the send" },
      ));
    }
    try {
      sock.send(data);
    } catch (e) {
      return Promise.reject(new StreamlineError(
        `WebSocket send failed: ${String(e)}`,
        StreamlineErrorCode.Transport,
        { retryable: true },
      ));
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.generation++; // fence any in-flight connect()'s onopen/onmessage/onclose
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = undefined;
    this.socketGeneration = undefined;
    return Promise.resolve();
  }
}

// --------------------------------------------------------------------------
// WebTransport transport
// --------------------------------------------------------------------------

export class WebTransportTransport implements Transport {
  readonly kind: TransportKind = "webtransport";

  private conn?: WebTransport;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;

  constructor(
    private readonly url: string,
    private readonly token?: string,
  ) {}

  /**
   * Open a WebTransport session to the broker, create a bidirectional stream
   * for the Streamline wire protocol, and send the auth token if configured.
   */
  async connect(callbacks: TransportCallbacks): Promise<void> {
    const WT = (globalThis as unknown as { WebTransport: typeof WebTransport }).WebTransport;
    const conn = new WT(this.url);
    await conn.ready;
    this.conn = conn;

    const bidi = await conn.createBidirectionalStream();
    this.writer = bidi.writable.getWriter();
    this.reader = bidi.readable.getReader();

    if (this.token) {
      const authFrame = new TextEncoder().encode(
        JSON.stringify({ type: "auth", token: this.token }),
      );
      await this.writer.write(authFrame);
    }

    // Start background read loop for incoming records.
    void this.readLoop(callbacks);

    // Auto-reconnect (via the client) when the session closes.
    void conn.closed.then(() => callbacks.onDisconnect()).catch(() => callbacks.onDisconnect());
  }

  /** Continuously read from the WebTransport bidi stream and dispatch. */
  private async readLoop(callbacks: TransportCallbacks): Promise<void> {
    if (!this.reader) return;
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        callbacks.onFrame(value.buffer as ArrayBuffer);
      }
    } catch {
      // Stream broken — handled via the closed-session callback above.
    }
  }

  async send(data: ArrayBuffer): Promise<void> {
    if (!this.writer) return;
    await this.writer.write(new Uint8Array(data));
  }

  async close(): Promise<void> {
    try {
      await this.writer?.close();
    } catch { /* already closed */ }
    try {
      this.conn?.close();
    } catch { /* already closed */ }
  }
}
