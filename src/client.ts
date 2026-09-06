/**
 * Streamline browser client.
 *
 * Transport order of preference:
 *   1. WebTransport when the global API is available
 *   2. WebSocket fallback
 *
 * Persistence: IndexedDB via {@link LocalStore} for pending writes across
 * reloads. Pending entries are removed after transport handoff; the current
 * wire protocol does not provide broker acknowledgements, so `send()`
 * rejecting (rather than resolving) is the only signal that a handoff did
 * not happen — {@link drainPending} relies on that to decide whether a
 * pending record may be deleted.
 *
 * `close()` is terminal: it cancels any in-flight `autoReconnect` backoff
 * immediately (no waiting out the current delay), fences off any
 * already-in-flight `connect()` attempt, and closes the transport and the
 * IndexedDB store. A closed client never reconnects and never touches the
 * store again — construct a new {@link Client} to reconnect.
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
  /** Optional token sent as the first application-level transport frame. */
  token?: string;
  /** Logical client id used to scope the local IndexedDB database. */
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

  /**
   * Set once `close()` has been called. A closed client can never
   * reconnect, so this both stops `autoReconnect` and fences any
   * already-in-flight `connect()` attempt from resurrecting a transport or
   * touching the (possibly already-closed) IndexedDB store.
   */
  private closed = false;

  /**
   * Monotonic fence bumped by `close()` (and at the start of each
   * `connect()`). A `connect()` call compares its own value against the
   * current one after its async transport handshake resolves; a mismatch
   * means it was superseded (typically by `close()`) while awaiting.
   */
  private connectGeneration = 0;

  /** Handle for the in-flight reconnect backoff timer, if any. */
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  /** Cancels an in-flight reconnect backoff sleep immediately; set only while sleeping. */
  private reconnectCancel?: () => void;

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

  /** Connect; resolves when the browser transport opens, without a server acknowledgement. */
  async connect(): Promise<void> {
    if (this.closed) {
      throw new StreamlineError(
        "Client is closed — create a new Client to reconnect",
        StreamlineErrorCode.Connection,
        { retryable: false },
      );
    }
    const generation = ++this.connectGeneration;
    const transport = this.createTransport(this.opts.preferTransport ?? this.detectTransport());
    await transport.connect({
      onFrame: (data) => this.handleIncoming(data),
      onDisconnect: () => this.handleDisconnect(),
    });

    // The client may have been closed — or a newer connect() started — while
    // this transport was opening. Discard it rather than resurrecting a
    // connection, and never touch the store (it may already be closed too).
    if (this.closed || generation !== this.connectGeneration) {
      await transport.close().catch(() => {
        /* best-effort teardown of a discarded transport */
      });
      throw new StreamlineError(
        "Client was closed while connecting",
        StreamlineErrorCode.Connection,
        { retryable: false },
      );
    }

    this.transport = transport;
    this.connected = true;

    // Drain any writes buffered while offline.
    this.requestDrain();
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
    if (this.closed) return; // explicit close already tore everything down
    this.connected = false;
    if (this.reconnecting) return;
    this.reconnecting = true;
    void this.autoReconnect();
  }

  private async autoReconnect(): Promise<void> {
    const baseDelay = this.opts.reconnectDelayMs ?? 1000;
    const maxDelay = 30_000;
    let delay = baseDelay;
    try {
      for (;;) {
        if (this.closed) return; // cancelled — do not reconnect, do not touch the store
        await this.sleep(delay);
        if (this.closed) return; // close() may have fired while sleeping
        try {
          await this.connect();
          return;
        } catch {
          if (this.closed) return; // connect() itself detected a close race
          delay = Math.min(delay * 2, maxDelay);
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Sleep for `ms`, resolving early if {@link close} cancels the pending
   * timer. Cancellation lets `close()` terminate `autoReconnect` immediately
   * instead of waiting out the current backoff delay.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.reconnectCancel = undefined;
        resolve();
      }, ms);
      this.reconnectCancel = () => {
        if (this.reconnectTimer !== undefined) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = undefined;
        }
        this.reconnectCancel = undefined;
        resolve();
      };
    });
  }

  // --------------------------------------------------------------------------
  // Unified send / incoming dispatch
  // --------------------------------------------------------------------------

  /**
   * Send a binary frame over whichever transport is active.
   * Throws if the client has been closed, or if no transport is connected.
   */
  async send(data: ArrayBuffer): Promise<void> {
    if (this.closed) {
      throw new StreamlineError(
        "Client is closed — cannot send",
        StreamlineErrorCode.Connection,
        { retryable: false },
      );
    }
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

  /**
   * Persist a record to IndexedDB and schedule a best-effort transport drain
   * when connected. Resolution confirms the local write, not broker delivery.
   */
  async produce(rec: Omit<Record, "offset"> & { offset?: bigint }): Promise<void> {
    validateTopicName(rec.topic);
    if (this.closed) {
      throw new StreamlineError(
        "Client is closed — cannot produce",
        StreamlineErrorCode.Connection,
        { retryable: false },
      );
    }
    await this.store.appendPending({ ...rec, offset: rec.offset ?? -1n });
    if (this.connected) {
      this.requestDrain();
    }
  }

  // --------------------------------------------------------------------------
  // Pending write drain
  // --------------------------------------------------------------------------

  /** True for the whole duration of a (possibly multi-pass) drain session. */
  private draining = false;

  /**
   * Set whenever a caller asks for a drain (via {@link requestDrain}) while
   * one is already in progress. `drainPending`'s loop checks this after each
   * pass and, if set, clears it and runs another pass instead of exiting —
   * this is the latch that guarantees a record appended mid-drain (during
   * `getPending()`, `send()`, or `removePending()`) is still processed
   * before the drain session ends, without a lost wakeup and without a
   * second overlapping drain loop.
   */
  private drainRequested = false;

  /**
   * Request a drain pass. If a drain is already running, this only raises
   * the {@link drainRequested} latch — the active session's loop will pick
   * it up and run another pass itself — rather than starting a second,
   * overlapping call to {@link drainPending}. Never throws; drain failures
   * are best-effort and retried on the next request.
   */
  private requestDrain(): void {
    if (this.closed || !this.connected) return;
    if (this.draining) {
      this.drainRequested = true;
      return;
    }
    this.drainPending().catch(() => {
      /* best-effort; next produce()/connect()/reconnect will retry */
    });
  }

  /**
   * Read all pending writes from IndexedDB and send them to the broker in
   * insertion order, looping for as many passes as {@link drainRequested}
   * demands so that records appended by a concurrent `produce()` while this
   * session is mid-flight (awaiting `getPending()`, `send()`, or
   * `removePending()`) are still drained before this call returns, instead
   * of being stranded until some unrelated future event happens to call
   * `produce()`/`connect()` again.
   *
   * A record is removed from the pending store only after it has been
   * handed to the transport layer; if `send()` rejects, the loop stops
   * (the exception propagates to the caller) and the record — along with
   * anything after it in this pass — is left in the store for a later
   * drain to retry. No broker acknowledgement is available in the current
   * protocol, so a resolved `send()` is the only signal used to authorize
   * deletion.
   *
   * Every await point re-checks `closed`/`connected` so that a `close()` or
   * disconnect racing with an in-flight pass neither touches the (possibly
   * already-closed) IndexedDB store nor keeps sending on a dead transport.
   * A record whose `send()` succeeded right before a close boundary is
   * deliberately left in place rather than deleted — a rare duplicate
   * redelivery on the next connection is preferable to silently losing it.
   *
   * Not reentrant — only ever call via {@link requestDrain}, which is the
   * sole gate that prevents overlapping drain sessions.
   */
  private async drainPending(): Promise<void> {
    if (this.draining) {
      this.drainRequested = true;
      return;
    }
    if (this.closed || !this.connected) return;
    this.draining = true;
    try {
      do {
        this.drainRequested = false;
        if (this.closed || !this.connected) break;

        const pending = await this.store.getPending();
        if (this.closed || !this.connected) break; // raced closed/disconnected while fetching
        if (pending.length === 0) continue; // nothing to do this pass; re-check the latch below

        let sent = 0;
        for (const { key, record } of pending) {
          if (this.closed || !this.connected) break; // transport dropped, or client closed, mid-drain
          const frame = new TextEncoder().encode(JSON.stringify({
            type: "produce",
            topic: record.topic,
            partition: record.partition,
            key: record.key ? Array.from(record.key) : undefined,
            value: Array.from(record.value),
            timestampMs: record.timestampMs,
            headers: record.headers,
          }));
          // Reject (rather than resolve) is the transport's only signal that
          // the frame did not hand off — never delete on a rejected send.
          await this.send(frame.buffer);
          if (this.closed) break; // do not touch the (possibly closing) store post-close
          await this.store.removePending(key);
          sent++;
          this.onDrainProgress?.({ sent, total: pending.length });
        }
      } while (this.drainRequested && this.connected && !this.closed);
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

  /**
   * Close the client permanently: cancels any in-flight/pending
   * `autoReconnect` (immediately, via {@link reconnectCancel}, without
   * waiting out the current backoff delay), fences off any in-flight
   * `connect()` attempt so it cannot resurrect a transport or touch the
   * store after this returns, closes the active transport, and closes the
   * IndexedDB store. A closed client can never reconnect — construct a new
   * {@link Client} to connect again.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    this.reconnecting = true; // defense in depth: block any late handleDisconnect
    this.connectGeneration++; // fence any in-flight connect() awaiting transport.connect()
    this.reconnectCancel?.(); // wake a sleeping autoReconnect immediately, no backoff wait
    await this.transport?.close();
    this.transport = undefined;
    await this.store.close();
  }

  /** Internal access to the store — used by {@link Topic}. */
  get localStore(): LocalStore {
    return this.store;
  }
}
