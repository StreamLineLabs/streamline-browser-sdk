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
import { decodeIncomingRecord } from "./wire.js";
import type { Transport, TransportKind } from "./transport.js";
import { WebSocketTransport, WebTransportTransport } from "./transport.js";

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

/** Callback invoked during pending write drain. */
export type DrainCallback = (progress: DrainProgress) => void;

export class Client {
  private transport?: Transport;
  private store: LocalStore;
  private opts: ClientOptions;

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
    const transport = this.createTransport(this.opts.preferTransport ?? this.detectTransport());
    await transport.connect({
      onFrame: (data) => this.handleIncoming(data),
      onDisconnect: () => this.handleDisconnect(),
    });
    this.transport = transport;
    this.connected = true;

    // Drain any writes buffered while offline.
    this.drainPending().catch(() => {
      /* best-effort; next connect will retry */
    });
  }

  private detectTransport(): TransportKind {
    return "WebTransport" in globalThis ? "webtransport" : "websocket";
  }

  /** Instantiate the transport implementation for the resolved transport kind. */
  private createTransport(kind: TransportKind): Transport {
    if (kind === "webtransport" && "WebTransport" in globalThis) {
      return new WebTransportTransport(this.opts.url, this.opts.token);
    }
    return new WebSocketTransport(this.opts.url, this.opts.token);
  }

  // --------------------------------------------------------------------------
  // Reconnect & disconnect
  // --------------------------------------------------------------------------

  private handleDisconnect(): void {
    this.connected = false;
    if (this.reconnecting) return;
    this.reconnecting = true;
    void this.autoReconnect();
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
    if (!this.transport) {
      throw new StreamlineError(
        "No active transport — call connect() first",
        StreamlineErrorCode.Connection,
        { retryable: true },
      );
    }
    await this.transport.send(data);
  }

  /**
   * Dispatch an incoming binary frame to registered topic listeners.
   * Expects a JSON-encoded record envelope.
   */
  private handleIncoming(data: ArrayBuffer | string): void {
    const record = decodeIncomingRecord(data);
    if (!record) return;

    const listeners = this.topicListeners.get(record.topic);
    if (listeners) {
      for (const callback of listeners) {
        callback(record);
      }
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
    await this.transport?.close();
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
