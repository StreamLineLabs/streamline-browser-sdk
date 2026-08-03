/**
 * Internal transport implementations for {@link Client}.
 *
 * Both transports implement the small {@link Transport} contract so the
 * client can select, connect, and delegate `send`/`close` without knowing
 * which wire mechanism is in use. Reconnect policy, persistence, and topic
 * dispatch remain the responsibility of {@link Client} — these units only
 * own their respective connection's lifecycle framing.
 */
import { StreamlineError, StreamlineErrorCode } from "./types.js";

export type TransportKind = "webtransport" | "websocket";

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
  /** Establish the connection and wire the given callbacks; resolves once ready to send. */
  connect(callbacks: TransportCallbacks): Promise<void>;
  /** Send a binary frame over this transport. */
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

  constructor(
    private readonly url: string,
    private readonly token?: string,
  ) {}

  connect(callbacks: TransportCallbacks): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.url.replace(/^http/, "ws");
      const sock = new WebSocket(wsUrl);
      sock.binaryType = "arraybuffer";
      sock.onopen = () => {
        if (this.token) {
          sock.send(JSON.stringify({ type: "auth", token: this.token }));
        }
        this.socket = sock;

        sock.onmessage = (event: MessageEvent<unknown>) => {
          if (typeof event.data === "string" || event.data instanceof ArrayBuffer) {
            callbacks.onFrame(event.data);
          }
        };
        sock.onclose = () => callbacks.onDisconnect();

        resolve();
      };
      sock.onerror = (e) => reject(new StreamlineError(
        `WebSocket connection failed: ${String(e)}`,
        StreamlineErrorCode.Transport,
        { retryable: true, hint: "Check that the Streamline server is running and accessible" },
      ));
    });
  }

  send(data: ArrayBuffer): Promise<void> {
    this.socket?.send(data);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.socket?.close();
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
