import { describe, it, expect, vi } from "vitest";
import { Client, StreamlineError, StreamlineErrorCode, validateTopicName } from "./index.js";

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
});
