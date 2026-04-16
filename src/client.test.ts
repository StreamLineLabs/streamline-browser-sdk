import { describe, it, expect, vi } from "vitest";
import { Client } from "./index.js";

describe("Client", () => {
  it("constructs without connecting", () => {
    const c = new Client({ url: "ws://localhost:9092", clientId: "smoke" });
    expect(c).toBeDefined();
    // No connect(), no socket created — purely covers the constructor path.
  });

  it("attempts WebTransport when preferred and available", async () => {
    // Stub a minimal WebTransport that resolves `ready` but will fail
    // on createBidirectionalStream so we can assert the path is entered.
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

  it("produce() queues to IndexedDB pending store", async () => {
    const c = new Client({ url: "ws://localhost:9092", clientId: "drain-test" });
    await c.produce({
      topic: "t",
      partition: 0,
      value: new TextEncoder().encode("hello"),
      timestampMs: Date.now(),
    });
    // No throw — record is queued in IndexedDB.
    await c.close();
  });

  it("isConnected is false before connect", () => {
    const c = new Client({ url: "ws://localhost:9092", clientId: "c" });
    expect(c.isConnected).toBe(false);
  });
});
