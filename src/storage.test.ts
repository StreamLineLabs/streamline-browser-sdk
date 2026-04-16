import { describe, it, expect } from "vitest";
import { LocalStore } from "./storage.js";
import type { Record } from "./types.js";

function rec(offset: bigint, value = "hello"): Record {
  return {
    topic: "t",
    partition: 0,
    offset,
    value: new TextEncoder().encode(value),
    timestampMs: Date.now(),
  };
}

describe("LocalStore (IndexedDB via fake-indexeddb)", () => {
  it("appends pending writes without throwing", async () => {
    const store = new LocalStore("test-db-pending");
    await store.appendPending(rec(-1n, "first"));
    await store.appendPending(rec(-1n, "second"));
    await store.close();
  });

  it("iter() yields nothing for an empty topic", async () => {
    const store = new LocalStore("test-db-empty");
    const out: Record[] = [];
    for await (const r of store.iter("never-written")) {
      out.push(r);
    }
    expect(out).toEqual([]);
    await store.close();
  });

  it("getPending() returns records with keys", async () => {
    const store = new LocalStore("test-db-getpending");
    await store.appendPending(rec(-1n, "a"));
    await store.appendPending(rec(-1n, "b"));
    const pending = await store.getPending();
    expect(pending).toHaveLength(2);
    expect(pending[0].key).toBeDefined();
    expect(new TextDecoder().decode(pending[0].record.value)).toBe("a");
    expect(new TextDecoder().decode(pending[1].record.value)).toBe("b");
    await store.close();
  });

  it("removePending() deletes a single pending record", async () => {
    const store = new LocalStore("test-db-removepending");
    await store.appendPending(rec(-1n, "x"));
    await store.appendPending(rec(-1n, "y"));
    const before = await store.getPending();
    expect(before).toHaveLength(2);
    await store.removePending(before[0].key);
    const after = await store.getPending();
    expect(after).toHaveLength(1);
    expect(new TextDecoder().decode(after[0].record.value)).toBe("y");
    await store.close();
  });
});
