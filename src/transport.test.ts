import { describe, it, expect, vi } from "vitest";
import { WebSocketTransport, WebTransportTransport } from "./transport.js";
import { StreamlineError } from "./types.js";

// --------------------------------------------------------------------------
// WebSocketTransport
// --------------------------------------------------------------------------

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(value: unknown): void {
    this.sent.push(value);
  }

  close(): void {
    this.closed = true;
  }
}

describe("WebSocketTransport", () => {
  it("converts http(s) URLs to ws(s) and sets binaryType", async () => {
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
    const transport = new WebSocketTransport("https://broker.example:9092");
    const connecting = transport.connect({ onFrame: vi.fn(), onDisconnect: vi.fn() });
    const sock = FakeWebSocket.instances[0]!;
    expect(sock.url).toBe("wss://broker.example:9092");
    expect(sock.binaryType).toBe("arraybuffer");
    sock.onopen?.();
    await connecting;
    delete (globalThis as Record<string, unknown>).WebSocket;
  });

  it("sends an auth frame on open when a token is configured", async () => {
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
    const transport = new WebSocketTransport("ws://broker:9092", "secret-token");
    const connecting = transport.connect({ onFrame: vi.fn(), onDisconnect: vi.fn() });
    const sock = FakeWebSocket.instances[0]!;
    sock.onopen?.();
    await connecting;

    expect(sock.sent).toEqual([JSON.stringify({ type: "auth", token: "secret-token" })]);
    delete (globalThis as Record<string, unknown>).WebSocket;
  });

  it("does not send an auth frame when no token is configured", async () => {
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
    const transport = new WebSocketTransport("ws://broker:9092");
    const connecting = transport.connect({ onFrame: vi.fn(), onDisconnect: vi.fn() });
    const sock = FakeWebSocket.instances[0]!;
    sock.onopen?.();
    await connecting;

    expect(sock.sent).toEqual([]);
    delete (globalThis as Record<string, unknown>).WebSocket;
  });

  it("forwards string and ArrayBuffer messages via onFrame, ignoring other types", async () => {
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
    const onFrame = vi.fn();
    const transport = new WebSocketTransport("ws://broker:9092");
    const connecting = transport.connect({ onFrame, onDisconnect: vi.fn() });
    const sock = FakeWebSocket.instances[0]!;
    sock.onopen?.();
    await connecting;

    const buf = new ArrayBuffer(4);
    sock.onmessage?.({ data: "hello" });
    sock.onmessage?.({ data: buf });
    sock.onmessage?.({ data: 42 }); // unsupported type, filtered out
    sock.onmessage?.({ data: { not: "supported" } });

    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onFrame).toHaveBeenNthCalledWith(1, "hello");
    expect(onFrame).toHaveBeenNthCalledWith(2, buf);
    delete (globalThis as Record<string, unknown>).WebSocket;
  });

  it("invokes onDisconnect when the socket closes", async () => {
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
    const onDisconnect = vi.fn();
    const transport = new WebSocketTransport("ws://broker:9092");
    const connecting = transport.connect({ onFrame: vi.fn(), onDisconnect });
    const sock = FakeWebSocket.instances[0]!;
    sock.onopen?.();
    await connecting;

    sock.onclose?.();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    delete (globalThis as Record<string, unknown>).WebSocket;
  });

  it("rejects connect() with a StreamlineError on socket error", async () => {
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
    const transport = new WebSocketTransport("ws://broker:9092");
    const connecting = transport.connect({ onFrame: vi.fn(), onDisconnect: vi.fn() });
    const sock = FakeWebSocket.instances[0]!;
    sock.onerror?.(new Error("boom"));

    await expect(connecting).rejects.toThrow(StreamlineError);
    await expect(connecting).rejects.toThrow(/WebSocket connection failed/);
    delete (globalThis as Record<string, unknown>).WebSocket;
  });

  it("sends binary frames over the open socket", async () => {
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
    const transport = new WebSocketTransport("ws://broker:9092");
    const connecting = transport.connect({ onFrame: vi.fn(), onDisconnect: vi.fn() });
    const sock = FakeWebSocket.instances[0]!;
    sock.onopen?.();
    await connecting;

    const payload = new ArrayBuffer(8);
    await transport.send(payload);
    expect(sock.sent).toContain(payload);
    delete (globalThis as Record<string, unknown>).WebSocket;
  });

  it("close() closes the underlying socket", async () => {
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
    const transport = new WebSocketTransport("ws://broker:9092");
    const connecting = transport.connect({ onFrame: vi.fn(), onDisconnect: vi.fn() });
    const sock = FakeWebSocket.instances[0]!;
    sock.onopen?.();
    await connecting;

    await transport.close();
    expect(sock.closed).toBe(true);
    delete (globalThis as Record<string, unknown>).WebSocket;
  });

  it("send() before connect() is a no-op (no throw)", async () => {
    const transport = new WebSocketTransport("ws://broker:9092");
    await expect(transport.send(new ArrayBuffer(1))).resolves.toBeUndefined();
  });

  it("close() before connect() is a no-op (no throw)", async () => {
    const transport = new WebSocketTransport("ws://broker:9092");
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it("exposes kind = 'websocket'", () => {
    const transport = new WebSocketTransport("ws://broker:9092");
    expect(transport.kind).toBe("websocket");
  });
});

// --------------------------------------------------------------------------
// WebTransportTransport
// --------------------------------------------------------------------------

/** Minimal fake WHATWG WritableStreamDefaultWriter. */
function makeFakeWriter() {
  const writes: Uint8Array[] = [];
  let closed = false;
  return {
    writes,
    get closed() {
      return closed;
    },
    write: vi.fn(async (chunk: Uint8Array) => {
      writes.push(chunk);
    }),
    close: vi.fn(async () => {
      closed = true;
    }),
  };
}

/** Minimal fake WHATWG ReadableStreamDefaultReader that yields queued chunks then blocks. */
function makeFakeReader(chunks: Uint8Array[]) {
  let i = 0;
  let blockedResolve: ((v: { value?: Uint8Array; done: boolean }) => void) | undefined;
  return {
    read: vi.fn(async () => {
      if (i < chunks.length) {
        return { value: chunks[i++], done: false };
      }
      // Block forever (simulating an open, idle stream) unless resolved externally.
      return new Promise<{ value?: Uint8Array; done: boolean }>((resolve) => {
        blockedResolve = resolve;
      });
    }),
    /** Test helper: end the stream, unblocking a pending read(). */
    finish() {
      blockedResolve?.({ done: true });
    },
  };
}

function installFakeWebTransport(opts: {
  writer: ReturnType<typeof makeFakeWriter>;
  reader: ReturnType<typeof makeFakeReader>;
  closed?: Promise<unknown>;
}) {
  const ctorSpy = vi.fn();
  class FakeWebTransport {
    ready = Promise.resolve();
    closed = opts.closed ?? new Promise(() => {});
    constructor(public url: string) {
      ctorSpy(url);
    }
    createBidirectionalStream() {
      return Promise.resolve({
        writable: { getWriter: () => opts.writer },
        readable: { getReader: () => opts.reader },
      });
    }
    close = vi.fn();
  }
  (globalThis as Record<string, unknown>).WebTransport = FakeWebTransport;
  return { ctorSpy, FakeWebTransport };
}

describe("WebTransportTransport", () => {
  it("opens a session with the configured URL", async () => {
    const writer = makeFakeWriter();
    const reader = makeFakeReader([]);
    const { ctorSpy } = installFakeWebTransport({ writer, reader });

    const transport = new WebTransportTransport("https://broker.example:9092");
    await transport.connect({ onFrame: vi.fn(), onDisconnect: vi.fn() });

    expect(ctorSpy).toHaveBeenCalledWith("https://broker.example:9092");
    delete (globalThis as Record<string, unknown>).WebTransport;
  });

  it("writes an auth frame to the bidi stream after stream creation when a token is set", async () => {
    const writer = makeFakeWriter();
    const reader = makeFakeReader([]);
    installFakeWebTransport({ writer, reader });

    const transport = new WebTransportTransport("https://broker:9092", "tok-123");
    await transport.connect({ onFrame: vi.fn(), onDisconnect: vi.fn() });

    expect(writer.writes).toHaveLength(1);
    const decoded = new TextDecoder().decode(writer.writes[0]);
    expect(JSON.parse(decoded)).toEqual({ type: "auth", token: "tok-123" });
    delete (globalThis as Record<string, unknown>).WebTransport;
  });

  it("does not write an auth frame when no token is configured", async () => {
    const writer = makeFakeWriter();
    const reader = makeFakeReader([]);
    installFakeWebTransport({ writer, reader });

    const transport = new WebTransportTransport("https://broker:9092");
    await transport.connect({ onFrame: vi.fn(), onDisconnect: vi.fn() });

    expect(writer.writes).toHaveLength(0);
    delete (globalThis as Record<string, unknown>).WebTransport;
  });

  it("dispatches incoming bidi stream chunks via onFrame", async () => {
    const writer = makeFakeWriter();
    const chunk = new Uint8Array([1, 2, 3]);
    const reader = makeFakeReader([chunk]);
    installFakeWebTransport({ writer, reader });

    const onFrame = vi.fn();
    const transport = new WebTransportTransport("https://broker:9092");
    await transport.connect({ onFrame, onDisconnect: vi.fn() });

    // Read loop runs in the background; flush microtasks.
    await new Promise((r) => setTimeout(r, 0));

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]?.[0]).toBe(chunk.buffer);
    reader.finish();
  });

  it("invokes onDisconnect when the session closes", async () => {
    const writer = makeFakeWriter();
    const reader = makeFakeReader([]);
    let resolveClosed: (() => void) | undefined;
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    installFakeWebTransport({ writer, reader, closed: closedPromise });

    const onDisconnect = vi.fn();
    const transport = new WebTransportTransport("https://broker:9092");
    await transport.connect({ onFrame: vi.fn(), onDisconnect });

    resolveClosed?.();
    await new Promise((r) => setTimeout(r, 0));

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    reader.finish();
  });

  it("invokes onDisconnect when the session's closed promise rejects", async () => {
    const writer = makeFakeWriter();
    const reader = makeFakeReader([]);
    let rejectClosed: ((e: unknown) => void) | undefined;
    const closedPromise = new Promise<void>((_resolve, reject) => {
      rejectClosed = reject;
    });
    installFakeWebTransport({ writer, reader, closed: closedPromise });

    const onDisconnect = vi.fn();
    const transport = new WebTransportTransport("https://broker:9092");
    await transport.connect({ onFrame: vi.fn(), onDisconnect });

    rejectClosed?.(new Error("session reset"));
    await new Promise((r) => setTimeout(r, 0));

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    reader.finish();
  });

  it("send() writes bytes through the stream writer", async () => {
    const writer = makeFakeWriter();
    const reader = makeFakeReader([]);
    installFakeWebTransport({ writer, reader });

    const transport = new WebTransportTransport("https://broker:9092");
    await transport.connect({ onFrame: vi.fn(), onDisconnect: vi.fn() });

    const payload = new Uint8Array([9, 8, 7]).buffer;
    await transport.send(payload);

    expect(writer.write).toHaveBeenLastCalledWith(new Uint8Array(payload));
    reader.finish();
  });

  it("close() closes the writer then the session", async () => {
    const writer = makeFakeWriter();
    const reader = makeFakeReader([]);
    installFakeWebTransport({ writer, reader });

    const transport = new WebTransportTransport("https://broker:9092");
    await transport.connect({ onFrame: vi.fn(), onDisconnect: vi.fn() });
    await transport.close();

    expect(writer.close).toHaveBeenCalledTimes(1);
    reader.finish();
  });

  it("propagates connect() failure when the bidi stream cannot be created (no wrapping)", async () => {
    class FailingWebTransport {
      ready = Promise.resolve();
      closed = new Promise(() => {});
      constructor(public url: string) {}
      createBidirectionalStream() {
        return Promise.reject(new Error("stub: no bidi stream"));
      }
      close = vi.fn();
    }
    (globalThis as Record<string, unknown>).WebTransport = FailingWebTransport;

    const transport = new WebTransportTransport("https://broker:9092");
    await expect(
      transport.connect({ onFrame: vi.fn(), onDisconnect: vi.fn() }),
    ).rejects.toThrow("stub: no bidi stream");
    delete (globalThis as Record<string, unknown>).WebTransport;
  });

  it("exposes kind = 'webtransport'", () => {
    const transport = new WebTransportTransport("https://broker:9092");
    expect(transport.kind).toBe("webtransport");
  });
});
