/**
 * Streamline browser client.
 *
 * Transport order of preference:
 *   1. WebTransport (Chrome/Edge/Firefox; bidi streams over QUIC)
 *   2. WebSocket    (universal fallback)
 *
 * Persistence: IndexedDB via {@link LocalStore} for offline-first reads
 * and pending-write durability across reloads.
 *
 * See ADR `0023-edge-transport.md` for transport selection rationale.
 */
import { LocalStore } from "./storage.js";
import { Topic } from "./topic.js";
import type { Record, DrainProgress } from "./types.js";
import { StreamlineError, StreamlineErrorCode, validateTopicName } from "./types.js";

export interface ClientOptions {
  /** ws(s):// or https:// (WebTransport) URL of the broker. */
  url: string;
  /** Optional bearer token for `streamline join`-issued credentials. */
  token?: string;
  /** Logical client id (used for offset tracking). */
  clientId: string;
  /** Force a transport, otherwise auto-negotiate. */
  preferTransport?: "webtransport" | "websocket";
  /** Base delay (ms) between reconnect attempts (doubled each retry, max 30 s). */
  reconnectDelayMs?: number;
}

type TransportKind = "webtransport" | "websocket";

/** Callback invoked during pending write drain. */
export type DrainCallback = (progress: DrainProgress) => void;

export class Client {
  private socket?: WebSocket;
  private store: LocalStore;
  private opts: ClientOptions;

  /** Active transport type after connect(). */
  private transportKind?: TransportKind;

  // WebTransport bookkeeping
  private wtConn?: WebTransport;
  private wtWriter?: WritableStreamDefaultWriter<Uint8Array>;
  private wtReader?: ReadableStreamDefaultReader<Uint8Array>;

  /** Whether the client currently has a live transport to the broker. */
  private connected = false;

  /** Guard against recursive reconnect loops. */
  private reconnecting = false;

  /** Topic-level listeners for incoming records dispatched by the read loop. */
  private topicListeners = new Map<string, Set<(rec: Record) => void>>();

  /** Optional drain-progress callback. */
  onDrainProgress?: DrainCallback;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.store = new LocalStore(`streamline:${opts.clientId}`);
  }

  // --------------------------------------------------------------------------
  // Connection
  // --------------------------------------------------------------------------

  /** Connect; returns a promise that resolves when the broker handshake completes. */
  async connect(): Promise<void> {
    const wt = this.opts.preferTransport ?? this.detectTransport();
    if (wt === "webtransport" && "WebTransport" in globalThis) {
      await this.connectWebTransport();
    } else {
      await this.connectWebSocket();
    }
    this.connected = true;

    // Drain any writes buffered while offline.
    this.drainPending().catch(() => {
      /* best-effort; next connect will retry */
    });
  }

  private detectTransport(): TransportKind {
    return "WebTransport" in globalThis ? "webtransport" : "websocket";
  }

  // --------------------------------------------------------------------------
  // WebSocket transport
  // --------------------------------------------------------------------------

  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.opts.url.replace(/^http/, "ws");
      const sock = new WebSocket(url);
      sock.binaryType = "arraybuffer";
      sock.onopen = () => {
        if (this.opts.token) {
          sock.send(JSON.stringify({ type: "auth", token: this.opts.token }));
        }
        this.socket = sock;
        this.transportKind = "websocket";

        sock.onmessage = (ev: MessageEvent) => this.handleIncoming(ev.data);
        sock.onclose = () => this.handleDisconnect();

        resolve();
      };
      sock.onerror = (e) => reject(new StreamlineError(
        `WebSocket connection failed: ${String(e)}`,
        StreamlineErrorCode.Transport,
        { retryable: true, hint: "Check that the Streamline server is running and accessible" },
      ));
    });
  }

  // --------------------------------------------------------------------------
  // WebTransport transport
  // --------------------------------------------------------------------------

  /**
   * Open a WebTransport session to the broker, create a bidirectional stream
   * for the Streamline wire protocol, and send the auth token if configured.
   */
  private async connectWebTransport(): Promise<void> {
    const WT = (globalThis as unknown as { WebTransport: typeof WebTransport }).WebTransport;
    const conn = new WT(this.opts.url);
    await conn.ready;
    this.wtConn = conn;

    const bidi = await conn.createBidirectionalStream();
    this.wtWriter = bidi.writable.getWriter();
    this.wtReader = bidi.readable.getReader();

    if (this.opts.token) {
      const authFrame = new TextEncoder().encode(
        JSON.stringify({ type: "auth", token: this.opts.token }),
      );
      await this.wtWriter.write(authFrame);
    }

    this.transportKind = "webtransport";

    // Start background read loop for incoming records.
    this.readWebTransportLoop();

    // Auto-reconnect when the session closes.
    conn.closed.then(() => this.handleDisconnect()).catch(() => this.handleDisconnect());
  }

  /** Continuously read from the WebTransport bidi stream and dispatch. */
  private async readWebTransportLoop(): Promise<void> {
    if (!this.wtReader) return;
    try {
      for (;;) {
        const { value, done } = await this.wtReader.read();
        if (done) break;
        this.handleIncoming(value.buffer as ArrayBuffer);
      }
    } catch {
      // Stream broken — handled via handleDisconnect.
    }
  }

  // --------------------------------------------------------------------------
  // Reconnect & disconnect
  // --------------------------------------------------------------------------

  private handleDisconnect(): void {
    this.connected = false;
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.autoReconnect();
  }

  private async autoReconnect(): Promise<void> {
    const baseDelay = this.opts.reconnectDelayMs ?? 1000;
    const maxDelay = 30_000;
    let delay = baseDelay;
    for (;;) {
      await this.sleep(delay);
      try {
        await this.connect();
        this.reconnecting = false;
        return;
      } catch {
        delay = Math.min(delay * 2, maxDelay);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Unified send / incoming dispatch
  // --------------------------------------------------------------------------

  /**
   * Send a binary frame over whichever transport is active.
   * Throws if no transport is connected.
   */
  async send(data: ArrayBuffer): Promise<void> {
    if (this.transportKind === "websocket" && this.socket) {
      this.socket.send(data);
      return;
    }
    if (this.transportKind === "webtransport" && this.wtWriter) {
      await this.wtWriter.write(new Uint8Array(data));
      return;
    }
    throw new StreamlineError(
      "No active transport — call connect() first",
      StreamlineErrorCode.Connection,
      { retryable: true },
    );
  }

  /**
   * Dispatch an incoming binary frame to registered topic listeners.
   * Expects a JSON-encoded record envelope.
   */
  private handleIncoming(data: ArrayBuffer | string): void {
    try {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      const parsed = JSON.parse(text);

      // Normalise into a Record.
      const rec: Record = {
        topic: parsed.topic ?? "",
        partition: parsed.partition ?? 0,
        offset: BigInt(parsed.offset ?? 0),
        key: parsed.key ? new Uint8Array(parsed.key) : undefined,
        value:
          parsed.value instanceof Uint8Array
            ? parsed.value
            : new TextEncoder().encode(
                typeof parsed.value === "string" ? parsed.value : JSON.stringify(parsed.value),
              ),
        timestampMs: parsed.timestampMs ?? Date.now(),
        headers: parsed.headers,
      };

      const listeners = this.topicListeners.get(rec.topic);
      if (listeners) {
        for (const cb of listeners) {
          cb(rec);
        }
      }
    } catch {
      // Malformed frame — silently ignore.
    }
  }

  // --------------------------------------------------------------------------
  // Topic subscriptions
  // --------------------------------------------------------------------------

  /**
   * Register a listener for incoming records on a specific topic.
   * Called internally by {@link Topic.tail} to wire live streaming.
   */
  subscribe(topic: string, callback: (rec: Record) => void): void {
    validateTopicName(topic);
    let set = this.topicListeners.get(topic);
    if (!set) {
      set = new Set();
      this.topicListeners.set(topic, set);
    }
    set.add(callback);
  }

  /**
   * Remove a previously registered topic listener.
   */
  unsubscribe(topic: string, callback: (rec: Record) => void): void {
    const set = this.topicListeners.get(topic);
    if (set) {
      set.delete(callback);
      if (set.size === 0) this.topicListeners.delete(topic);
    }
  }

  // --------------------------------------------------------------------------
  // Topics & produce
  // --------------------------------------------------------------------------

  /** Create a {@link Topic} handle bound to this client. */
  topic(name: string): Topic {
    validateTopicName(name);
    return new Topic(name, this.store, this);
  }

  /** Persist a record to IndexedDB; flushed to broker when online. */
  async produce(rec: Omit<Record, "offset"> & { offset?: bigint }): Promise<void> {
    validateTopicName(rec.topic);
    await this.store.appendPending({ ...rec, offset: rec.offset ?? -1n });
    if (this.connected) {
      this.drainPending().catch(() => {
        /* next drain cycle will retry */
      });
    }
  }

  // --------------------------------------------------------------------------
  // Pending write drain
  // --------------------------------------------------------------------------

  private draining = false;

  /**
   * Read all pending writes from IndexedDB and send them to the broker in
   * insertion order. Each record is removed from the pending store only after
   * it has been handed to the transport layer.
   *
   * Safe to call concurrently — a guard prevents overlapping runs.
   */
  private async drainPending(): Promise<void> {
    if (this.draining || !this.connected) return;
    this.draining = true;
    try {
      const pending = await this.store.getPending();
      if (pending.length === 0) return;

      let sent = 0;
      for (const { key, record } of pending) {
        if (!this.connected) break; // transport dropped mid-drain
        const frame = new TextEncoder().encode(JSON.stringify({
          type: "produce",
          topic: record.topic,
          partition: record.partition,
          key: record.key ? Array.from(record.key) : undefined,
          value: Array.from(record.value),
          timestampMs: record.timestampMs,
          headers: record.headers,
        }));
        await this.send(frame.buffer);
        await this.store.removePending(key);
        sent++;
        this.onDrainProgress?.({ sent, total: pending.length });
      }
    } finally {
      this.draining = false;
    }
  }

  // --------------------------------------------------------------------------
  // Lifecycle helpers
  // --------------------------------------------------------------------------

  /** Whether the client has an active broker connection. */
  get isConnected(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {
    this.connected = false;
    this.reconnecting = true; // prevent reconnect after close
    this.socket?.close();
    try {
      this.wtWriter?.close();
    } catch { /* already closed */ }
    try {
      this.wtConn?.close();
    } catch { /* already closed */ }
    await this.store.close();
  }

  /** Internal access to the store — used by {@link Topic}. */
  get localStore(): LocalStore {
    return this.store;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
