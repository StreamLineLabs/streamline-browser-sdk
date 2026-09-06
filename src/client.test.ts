import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client, LocalStore, StreamlineError, StreamlineErrorCode, validateTopicName } from "./index.js";

describe("StreamlineError", () => {
  it("has code, message, and retryable flag", () => {
    const err = new StreamlineError("connection lost", StreamlineErrorCode.Connection, {
      retryable: true,
      hint: "Check network",
    });
    expect(err.code).toBe(StreamlineErrorCode.Connection);
    expect(err.retryable).toBe(true);
    expect(err.hint).toBe("Check network");
    expect(err.message).toBe("connection lost");
    expect(err.name).toBe("StreamlineError");
    expect(err).toBeInstanceOf(Error);
  });
  it("defaults to Unknown code and non-retryable", () => {
    const err = new StreamlineError("oops");
    expect(err.code).toBe(StreamlineErrorCode.Unknown);
    expect(err.retryable).toBe(false);
    expect(err.hint).toBeUndefined();
  });
});

describe("validateTopicName", () => {
  it("accepts valid topic names", () => {
    expect(() => validateTopicName("events")).not.toThrow();
    expect(() => validateTopicName("user.actions")).not.toThrow();
    expect(() => validateTopicName("my-topic_v2")).not.toThrow();
    expect(() => validateTopicName("A")).not.toThrow();
  });

  it("rejects empty topic name", () => {
    expect(() => validateTopicName("")).toThrow(StreamlineError);
    expect(() => validateTopicName("")).toThrow(/cannot be empty/);
  });

  it("rejects '.' and '..' topic names", () => {
    expect(() => validateTopicName(".")).toThrow(StreamlineError);
    expect(() => validateTopicName("..")).toThrow(StreamlineError);
  });

  it("rejects topic names with invalid characters", () => {
    expect(() => validateTopicName("topic name")).toThrow(/invalid characters/);
    expect(() => validateTopicName("topic/path")).toThrow(/invalid characters/);
    expect(() => validateTopicName("topic:name")).toThrow(/invalid characters/);
  });

  it("rejects topic names exceeding 249 characters", () => {
    const longName = "a".repeat(250);
    expect(() => validateTopicName(longName)).toThrow(/maximum length/);
  });

  it("throws StreamlineError with Configuration code", () => {
    try {
      validateTopicName("");
    } catch (e) {
      expect(e).toBeInstanceOf(StreamlineError);
      expect((e as StreamlineError).code).toBe(StreamlineErrorCode.Configuration);
    }
  });
});

describe("Client", () => {
  it("constructs without connecting", () => {
    const c = new Client({ url: "ws://localhost:9092", clientId: "smoke" });
    expect(c).toBeDefined();
  });

  it("attempts WebTransport when preferred and available", async () => {
    const readyPromise = Promise.resolve();
    const closedPromise = new Promise<{ closeCode: number; reason: string }>(() => {});
    const fakeWT = vi.fn().mockImplementation(() => ({
      ready: readyPromise,
      closed: closedPromise,
      createBidirectionalStream: () =>
        Promise.reject(new Error("stub: no bidi stream")),
      close: vi.fn(),
    }));
    (globalThis as Record<string, unknown>).WebTransport = fakeWT;

    const c = new Client({
      url: "https://localhost:9092",
      clientId: "smoke-wt",
      preferTransport: "webtransport",
    });

    await expect(c.connect()).rejects.toThrow("stub: no bidi stream");
    expect(fakeWT).toHaveBeenCalledWith("https://localhost:9092");
    delete (globalThis as Record<string, unknown>).WebTransport;
  });

  it("topic() returns a Topic bound to the client", () => {
    const c = new Client({ url: "ws://localhost:9092", clientId: "t" });
    const t = c.topic("my-topic");
    expect(t.name).toBe("my-topic");
  });

  it("topic() rejects invalid topic names", () => {
    const c = new Client({ url: "ws://localhost:9092", clientId: "t" });
    expect(() => c.topic("")).toThrow(StreamlineError);
    expect(() => c.topic("bad topic")).toThrow(StreamlineError);
  });

  it("produce() queues to IndexedDB pending store", async () => {
    const c = new Client({ url: "ws://localhost:9092", clientId: "drain-test" });
    await c.produce({
      topic: "t",
      partition: 0,
      value: new TextEncoder().encode("hello"),
      timestampMs: Date.now(),
    });
    await c.close();
  });

  it("produce() rejects invalid topic names", async () => {
    const c = new Client({ url: "ws://localhost:9092", clientId: "t" });
    await expect(
      c.produce({
        topic: "",
        partition: 0,
        value: new TextEncoder().encode("hello"),
        timestampMs: Date.now(),
      }),
    ).rejects.toThrow(StreamlineError);
  });

  it("isConnected is false before connect", () => {
    const c = new Client({ url: "ws://localhost:9092", clientId: "c" });
    expect(c.isConnected).toBe(false);
  });

  it("normalizes incoming WebSocket records before dispatch", async () => {
    const originalWebSocket = globalThis.WebSocket;
    let socket: FakeWebSocket | undefined;
    class FakeWebSocket {
      binaryType = "";
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: ((error: unknown) => void) | null = null;
      readonly sent: unknown[] = [];

      constructor(_url: string) {
        socket = this;
      }

      send(value: unknown): void {
        this.sent.push(value);
      }

      close(): void {}
    }

    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    try {
      const client = new Client({
        url: "ws://localhost:9092",
        clientId: "incoming",
        preferTransport: "websocket",
      });
      const connecting = client.connect();
      socket?.onopen?.();
      await connecting;

      const received: Array<{
        topic: string;
        partition: number;
        offset: bigint;
        value: Uint8Array;
      }> = [];
      client.subscribe("events", (record) => received.push(record));
      socket?.onmessage?.({
        data: JSON.stringify({
          topic: "events",
          partition: 2,
          offset: "42",
          value: [104, 105],
          timestampMs: 123,
        }),
      });

      expect(received).toHaveLength(1);
      expect(received[0]?.topic).toBe("events");
      expect(received[0]?.partition).toBe(2);
      expect(received[0]?.offset).toBe(42n);
      expect(Array.from(received[0]?.value ?? [])).toEqual([104, 105]);
      await client.close();
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("ignores malformed incoming WebSocket frames", async () => {
    const originalWebSocket = globalThis.WebSocket;
    let socket: FakeWebSocket | undefined;
    class FakeWebSocket {
      binaryType = "";
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: ((error: unknown) => void) | null = null;

      constructor(_url: string) {
        socket = this;
      }

      send(_value: unknown): void {}
      close(): void {}
    }

    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    try {
      const client = new Client({
        url: "ws://localhost:9092",
        clientId: "malformed",
        preferTransport: "websocket",
      });
      const connecting = client.connect();
      socket?.onopen?.();
      await connecting;

      const listener = vi.fn();
      client.subscribe("events", listener);
      socket?.onmessage?.({ data: "{not json" });

      expect(listener).not.toHaveBeenCalled();
      await client.close();
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });
});

// --------------------------------------------------------------------------
// Client — close() cancellation semantics (regression coverage)
//
// These exercise the two related races fixed alongside WebSocketTransport's
// fail-closed send(): (1) explicit close() must terminate an in-progress
// autoReconnect backoff immediately rather than letting it fire later, and
// (2) a connect() attempt already in flight when close() runs must be
// discarded — it must not resurrect a transport or touch the (by-then
// possibly closed) IndexedDB store.
// --------------------------------------------------------------------------

/** Minimal fake WebSocket with a realistic readyState state machine. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;
  readyState: number = FakeWebSocket.CONNECTING;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  /** Simulate the browser transitioning the socket to OPEN and firing `open`. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Simulate a server/network-initiated close. */
  simulateClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  send(value: unknown): void {
    this.sent.push(value);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }
}

describe("Client — close() cancellation semantics", () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it("terminates autoReconnect immediately on close(), without waiting out the backoff delay", async () => {
    // Only fake the timer APIs autoReconnect's backoff actually uses; leave
    // setImmediate (used internally by the fake-indexeddb polyfill) real so
    // IndexedDB operations triggered during close() still complete.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const client = new Client({
      url: "ws://localhost:9092",
      clientId: "cancel-reconnect",
      preferTransport: "websocket",
      reconnectDelayMs: 1000,
    });

    const connecting = client.connect();
    FakeWebSocket.instances[0]!.open();
    await connecting;
    expect(client.isConnected).toBe(true);

    // Unexpected disconnect — this schedules an autoReconnect backoff sleep.
    FakeWebSocket.instances[0]!.simulateClose();
    expect(client.isConnected).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1); // no reconnect attempt yet — still sleeping

    // Close while autoReconnect is asleep, well before the 1s delay elapses.
    await client.close();

    // Advance well past the backoff delay: if cancellation failed, this
    // would trigger a new `new WebSocket(...)` reconnect attempt.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeWebSocket.instances).toHaveLength(1); // still just the original socket
    expect(client.isConnected).toBe(false);
  });

  it("discards a connect() attempt already in flight when close() runs, without touching the store", async () => {
    const client = new Client({
      url: "ws://localhost:9092",
      clientId: "cancel-inflight-connect",
      preferTransport: "websocket",
    });

    const connecting = client.connect(); // pending: socket has not opened yet
    const sock = FakeWebSocket.instances[0]!;

    await client.close(); // closes the (not-yet-assigned) transport slot and the store

    sock.open(); // the handshake completes *after* close() already ran

    await expect(connecting).rejects.toThrow(StreamlineError);
    await expect(client.connect()).rejects.toThrow(/closed/); // still permanently closed

    // The late-opening socket must have been torn down, not left dangling open.
    expect(sock.closed).toBe(true);
    expect(client.isConnected).toBe(false);

    // The store is closed too; further produce() must fail closed rather
    // than attempt an IndexedDB transaction on a closed connection.
    await expect(
      client.produce({
        topic: "t",
        partition: 0,
        value: new TextEncoder().encode("x"),
        timestampMs: Date.now(),
      }),
    ).rejects.toThrow(/closed/);
  });

  it("ignores a disconnect event that arrives after close() has already run", async () => {
    const client = new Client({
      url: "ws://localhost:9092",
      clientId: "close-then-late-disconnect",
      preferTransport: "websocket",
    });

    const connecting = client.connect();
    const sock = FakeWebSocket.instances[0]!;
    sock.open();
    await connecting;

    await client.close();

    // A close event that arrives late (already superseded) must not
    // resurrect autoReconnect.
    sock.simulateClose();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("send() rejects once the client is closed", async () => {
    const client = new Client({
      url: "ws://localhost:9092",
      clientId: "send-after-close",
      preferTransport: "websocket",
    });

    const connecting = client.connect();
    FakeWebSocket.instances[0]!.open();
    await connecting;

    await client.close();

    await expect(client.send(new ArrayBuffer(1))).rejects.toThrow(StreamlineError);
    await expect(client.send(new ArrayBuffer(1))).rejects.toThrow(/closed/);
  });

  it("close() is idempotent and safe to call more than once", async () => {
    const client = new Client({
      url: "ws://localhost:9092",
      clientId: "double-close",
      preferTransport: "websocket",
    });

    const connecting = client.connect();
    FakeWebSocket.instances[0]!.open();
    await connecting;

    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// Client — drainPending latch/loop (regression coverage)
//
// The previous implementation took a single snapshot of the pending store
// per `drainPending()` call and returned early (no-op) if another call
// arrived while it was already running. A record appended by `produce()`
// while a drain was mid-flight — inside `getPending()`, `send()`, or
// `removePending()` — was therefore invisible to that snapshot *and* its
// own triggering `drainPending()` call was swallowed by the `draining`
// guard, so nothing ever came back to process it. It sat in IndexedDB
// until some unrelated future `produce()`/`connect()` happened to run.
//
// These tests gate each of the three await points in turn, append a
// second record while the drain is paused there, release the gate, and
// assert the later record is drained in the *same* session — with no
// second external trigger — while also proving passes never overlap, a
// rejected send() never authorizes deletion, and close()/disconnect
// boundaries never touch the store or transport after the fact.
// --------------------------------------------------------------------------

describe("Client — drainPending latch (concurrent append handling)", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeRecord(value: string) {
    return {
      topic: "t",
      partition: 0,
      value: new TextEncoder().encode(value),
      timestampMs: Date.now(),
    };
  }

  function decodeSentValue(buf: unknown): string {
    const parsed = JSON.parse(new TextDecoder().decode(buf as ArrayBuffer)) as {
      value: number[];
    };
    return new TextDecoder().decode(new Uint8Array(parsed.value));
  }

  /** Connects a Client over a FakeWebSocket and returns both handles. */
  async function connectedClient(clientId: string): Promise<{ client: Client; sock: FakeWebSocket }> {
    const client = new Client({
      url: "ws://localhost:9092",
      clientId,
      preferTransport: "websocket",
    });
    const connecting = client.connect();
    const sock = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    sock.open();
    await connecting;
    return { client, sock };
  }

  it("drains records queued before connect() once the socket opens, in insertion order", async () => {
    const client = new Client({
      url: "ws://localhost:9092",
      clientId: "drain-before-connect",
      preferTransport: "websocket",
    });

    await client.produce(makeRecord("a")); // buffered locally; not yet connected
    await client.produce(makeRecord("b"));

    const connecting = client.connect();
    const sock = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    sock.open();
    await connecting;

    await vi.waitFor(() => {
      expect(sock.sent.length).toBe(2);
    });

    expect(sock.sent.map(decodeSentValue)).toEqual(["a", "b"]);
    expect(await client.localStore.getPending()).toHaveLength(0);

    await client.close();
  });

  it("drains a record appended while getPending() is still resolving, in the same drain session", async () => {
    const { client, sock } = await connectedClient("drain-latch-get");
    const store = client.localStore;
    const removeSpy = vi.spyOn(store, "removePending");
    const originalGetPending = store.getPending.bind(store);

    let releaseGetPending!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGetPending = resolve;
    });

    vi.spyOn(store, "getPending").mockImplementationOnce(async () => {
      const result = await originalGetPending(); // snapshot taken: ["a"] only
      await gate; // held here — mirrors "produce() lands before this returns"
      return result;
    });

    const producing = client.produce(makeRecord("a")); // starts the drain
    await producing; // resolves as soon as the local write lands, not the drain

    // The drain is now paused holding a stale ["a"] snapshot. Append a
    // second record — the exact race the old single-pass drain lost.
    await client.produce(makeRecord("b"));

    releaseGetPending(); // let the paused getPending() return its stale snapshot

    await vi.waitFor(() => {
      expect(removeSpy).toHaveBeenCalledTimes(2);
    });

    expect(sock.sent.map(decodeSentValue)).toEqual(["a", "b"]);
    expect(await store.getPending()).toHaveLength(0);

    await client.close();
  });

  it("drains a record appended while send() is still resolving, in the same drain session", async () => {
    const { client, sock } = await connectedClient("drain-latch-send");
    const store = client.localStore;
    const removeSpy = vi.spyOn(store, "removePending");
    const originalSend = client.send.bind(client);

    let releaseSend!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let intercepted = false;

    vi.spyOn(client, "send").mockImplementation(async (data: ArrayBuffer) => {
      if (!intercepted) {
        intercepted = true;
        await gate; // pause before "a"'s frame is handed to the transport
      }
      return originalSend(data);
    });

    const producing = client.produce(makeRecord("a"));
    await producing; // returns immediately; the drain is paused before send()

    await client.produce(makeRecord("b")); // appended while "a"'s send() is in flight

    releaseSend();

    await vi.waitFor(() => {
      expect(removeSpy).toHaveBeenCalledTimes(2);
    });

    expect(sock.sent.map(decodeSentValue)).toEqual(["a", "b"]);
    expect(await store.getPending()).toHaveLength(0);

    await client.close();
  });

  it("drains a record appended while removePending() is still resolving, in the same drain session", async () => {
    const { client, sock } = await connectedClient("drain-latch-remove");
    const store = client.localStore;
    const originalRemovePending = store.removePending.bind(store);

    let releaseRemove!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    let intercepted = false;

    vi.spyOn(store, "removePending").mockImplementation(async (key: IDBValidKey) => {
      if (!intercepted) {
        intercepted = true;
        await gate; // pause after "a" was sent, before it's deleted from the store
      }
      return originalRemovePending(key);
    });

    const producing = client.produce(makeRecord("a"));
    await producing;

    // Wait until "a" has actually been handed to the transport (i.e. the
    // drain is now paused inside the gated removePending()).
    await vi.waitFor(() => {
      expect(sock.sent).toHaveLength(1);
    });

    await client.produce(makeRecord("b")); // appended while "a"'s removePending() is in flight

    releaseRemove();

    await vi.waitFor(() => {
      expect(sock.sent).toHaveLength(2);
    });

    expect(sock.sent.map(decodeSentValue)).toEqual(["a", "b"]);
    expect(await store.getPending()).toHaveLength(0);

    await client.close();
  });

  it("never runs two overlapping getPending() passes even when several produce() calls race in", async () => {
    const { client, sock } = await connectedClient("drain-no-overlap");
    const store = client.localStore;
    const originalGetPending = store.getPending.bind(store);
    let active = 0;
    let overlapDetected = false;

    const spy = vi.spyOn(store, "getPending").mockImplementation(async () => {
      active++;
      if (active > 1) overlapDetected = true;
      try {
        return await originalGetPending();
      } finally {
        active--;
      }
    });

    await Promise.all(["a", "b", "c", "d", "e"].map((v) => client.produce(makeRecord(v))));

    await vi.waitFor(() => {
      expect(sock.sent.length).toBe(5);
    });

    spy.mockRestore(); // stop tracking before using getPending() for the assertion below

    expect(overlapDetected).toBe(false);
    expect(sock.sent.map(decodeSentValue)).toEqual(["a", "b", "c", "d", "e"]);
    expect(await store.getPending()).toHaveLength(0);

    await client.close();
  });

  it("does not delete a pending record, or process subsequent ones, when send() rejects", async () => {
    const { client, sock } = await connectedClient("drain-send-reject");
    const store = client.localStore;

    const sendSpy = vi.spyOn(client, "send").mockImplementationOnce(async () => {
      throw new StreamlineError("boom", StreamlineErrorCode.Transport, { retryable: true });
    });

    await client.produce(makeRecord("a"));
    await client.produce(makeRecord("b"));

    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(sock.sent).toHaveLength(0); // the rejected send() never reached the socket

    const pending = await store.getPending();
    expect(pending).toHaveLength(2); // neither record was removed
    expect(new TextDecoder().decode(pending[0].record.value)).toBe("a");
    expect(new TextDecoder().decode(pending[1].record.value)).toBe("b");

    await client.close();
  });

  it("stops draining and leaves remaining records in the store when the transport disconnects mid-drain", async () => {
    const { client, sock } = await connectedClient("drain-disconnect-mid");
    const store = client.localStore;
    const originalSend = client.send.bind(client);
    let firstCall = true;

    vi.spyOn(client, "send").mockImplementation(async (data: ArrayBuffer) => {
      if (firstCall) {
        firstCall = false;
        await originalSend(data); // "a" is genuinely handed off...
        sock.simulateClose(); // ...then the transport drops before "b" is attempted
        return;
      }
      return originalSend(data);
    });

    await client.produce(makeRecord("a"));
    await client.produce(makeRecord("b"));

    await vi.waitFor(() => {
      expect(sock.sent).toHaveLength(1); // only "a" got through before the disconnect
    });
    await Promise.resolve();
    await Promise.resolve();

    const pending = await store.getPending();
    expect(pending).toHaveLength(1); // "b" was never attempted
    expect(new TextDecoder().decode(pending[0].record.value)).toBe("b");
    expect(client.isConnected).toBe(false);

    await client.close();
  });

  it("does not remove a pending record when close() races in between send() succeeding and removePending(), leaving it for redelivery", async () => {
    const clientId = "drain-close-mid-remove";
    const { client, sock } = await connectedClient(clientId);
    const dbName = `streamline:${clientId}`;
    const store = client.localStore;
    const removeSpy = vi.spyOn(store, "removePending");
    const originalSend = client.send.bind(client);

    let releaseSend!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });

    vi.spyOn(client, "send").mockImplementationOnce(async (data: ArrayBuffer) => {
      await originalSend(data); // frame handed off to the socket
      await gate; // ...but drainPending won't see the result until released
    });

    const producing = client.produce(makeRecord("a"));
    await producing; // returns immediately; the drain itself runs in the background

    // Wait until the frame has genuinely been handed to the socket (i.e.
    // the drain is now paused at the gate, right after send() succeeded)
    // before racing close() in — otherwise close() could run before the
    // drain even reaches send().
    await vi.waitFor(() => {
      expect(sock.sent).toHaveLength(1);
    });

    await client.close(); // races in exactly at the guarded boundary

    releaseSend();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(removeSpy).not.toHaveBeenCalled(); // never touched the store post-close
    expect(sock.sent).toHaveLength(1); // the frame *was* handed off before the close raced in

    // A fresh connection to the same IndexedDB database (the original was
    // closed by client.close()) proves the record was left in place rather
    // than silently dropped.
    const reopened = new LocalStore(dbName);
    const pending = await reopened.getPending();
    expect(pending).toHaveLength(1);
    expect(new TextDecoder().decode(pending[0].record.value)).toBe("a");
    await reopened.close();
  });

  it("close() racing in right after getPending() resolves stops the drain before any send or store mutation", async () => {
    const clientId = "drain-close-after-get";
    const { client } = await connectedClient(clientId);
    const dbName = `streamline:${clientId}`;
    const store = client.localStore;
    const originalGetPending = store.getPending.bind(store);
    const sendSpy = vi.spyOn(client, "send");
    const removeSpy = vi.spyOn(store, "removePending");

    let releaseAfterGet!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAfterGet = resolve;
    });

    vi.spyOn(store, "getPending").mockImplementationOnce(async () => {
      const result = await originalGetPending(); // the real read has already completed
      await gate; // ...but control doesn't return to drainPending until released
      return result;
    });

    const producing = client.produce(makeRecord("a"));
    await producing; // drain started, now paused right after its getPending() snapshot

    await client.close(); // closes while the snapshot is held but not yet acted on

    releaseAfterGet();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sendSpy).not.toHaveBeenCalled(); // never attempted to send after the close raced in
    expect(removeSpy).not.toHaveBeenCalled();

    const reopened = new LocalStore(dbName);
    const pending = await reopened.getPending();
    expect(pending).toHaveLength(1);
    expect(new TextDecoder().decode(pending[0].record.value)).toBe("a");
    await reopened.close();
  });
});
