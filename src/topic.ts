import type { LocalStore } from "./storage.js";
import type { Client } from "./client.js";
import type { Record } from "./types.js";

/** A topic handle scoped to a {@link Client}. */
export class Topic {
  constructor(
    public readonly name: string,
    private store: LocalStore,
    private client: Client,
  ) {}

  // --------------------------------------------------------------------------
  // consume — legacy cache-only iterator (preserved for compat)
  // --------------------------------------------------------------------------

  /** Async iterator of records from local cache only. */
  async *consume(): AsyncIterable<Record> {
    for await (const r of this.store.iter(this.name)) {
      yield r;
    }
  }

  // --------------------------------------------------------------------------
  // append — write a record (online ⇒ send, offline ⇒ queue)
  // --------------------------------------------------------------------------

  /**
   * Append a record to this topic.
   *
   * If the client is connected the record is sent immediately and also
   * buffered locally. When offline it is written to the IndexedDB pending
   * store and will be drained on the next successful connect.
   *
   * @param entry.key   Optional record key (UTF-8 string convenience).
   * @param entry.value Arbitrary payload — objects are JSON-serialized,
   *                    strings are UTF-8 encoded, Uint8Array is sent as-is.
   */
  async append(entry: { key?: string; value: unknown }): Promise<void> {
    const value = serializeValue(entry.value);
    const rec: Record = {
      topic: this.name,
      partition: 0,
      offset: -1n, // assigned by broker
      key: entry.key ? new TextEncoder().encode(entry.key) : undefined,
      value,
      timestampMs: Date.now(),
    };
    await this.client.produce(rec);
  }

  // --------------------------------------------------------------------------
  // tail — cache replay + live stream
  // --------------------------------------------------------------------------

  /**
   * Async generator that first yields all cached records for this topic from
   * IndexedDB and then pivots to a live stream of records arriving on the
   * broker transport.
   *
   * The generator runs indefinitely until the caller breaks out of the loop
   * or calls `.return()` on the iterator.
   *
   * ```ts
   * for await (const event of topic.tail()) {
   *   console.log(event);
   * }
   * ```
   */
  async *tail(): AsyncGenerator<Record, void, undefined> {
    // Phase 1: replay local cache.
    for await (const r of this.store.iter(this.name)) {
      yield r;
    }

    // Phase 2: live stream — park on an unbounded async queue fed by the
    // client's incoming-record dispatcher.
    const queue: Record[] = [];
    let resolve: (() => void) | null = null;

    const push = (rec: Record): void => {
      queue.push(rec);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    this.client.subscribe(this.name, push);

    try {
      for (;;) {
        // Yield everything already queued.
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        // Wait for the next record.
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    } finally {
      // Cleanup when the consumer breaks out.
      this.client.unsubscribe(this.name, push);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeValue(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return new TextEncoder().encode(v);
  return new TextEncoder().encode(JSON.stringify(v));
}
