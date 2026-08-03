import { describe, expect, it } from "vitest";
import { decodeIncomingRecord } from "./wire.js";

describe("decodeIncomingRecord", () => {
  it("decodes string envelopes", () => {
    const record = decodeIncomingRecord(JSON.stringify({
      topic: "events",
      partition: 2,
      offset: "42",
      key: [1, 2],
      value: [104, 105],
      timestampMs: 123,
      headers: { source: "test" },
    }));

    expect(record).toEqual({
      topic: "events",
      partition: 2,
      offset: 42n,
      key: new Uint8Array([1, 2]),
      value: new Uint8Array([104, 105]),
      timestampMs: 123,
      headers: { source: "test" },
    });
  });

  it("decodes ArrayBuffer envelopes", () => {
    const data = new TextEncoder().encode(JSON.stringify({
      topic: "events",
      value: "hello",
    }));

    const record = decodeIncomingRecord(data.buffer);
    expect(record?.topic).toBe("events");
    expect(new TextDecoder().decode(record?.value)).toBe("hello");
  });

  it("preserves current defaults for missing fields", () => {
    const before = Date.now();
    const record = decodeIncomingRecord("{}");

    expect(record?.topic).toBe("");
    expect(record?.partition).toBe(0);
    expect(record?.offset).toBe(0n);
    expect(record?.value).toEqual(new Uint8Array());
    expect(record?.timestampMs).toBeGreaterThanOrEqual(before);
  });

  it("returns undefined for malformed frames", () => {
    expect(decodeIncomingRecord("{not json")).toBeUndefined();
  });
});
