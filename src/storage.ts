import type { Record } from "./types.js";

/**
 * IndexedDB-backed durable cache for browser clients.
 *
 * Schema:
 *   * Object store `records` keyed by `[topic, partition, offset]`.
 *   * Object store `pending` keyed by auto-incrementing id (writes that
 *     haven't been ack'd by the broker yet).
 */
export class LocalStore {
  private dbPromise: Promise<IDBDatabase>;

  constructor(dbName: string) {
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("records")) {
          db.createObjectStore("records", {
            keyPath: ["topic", "partition", "offset"],
          });
        }
        if (!db.objectStoreNames.contains("pending")) {
          db.createObjectStore("pending", { autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async appendPending(rec: Record): Promise<void> {
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("pending", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore("pending").add(serialize(rec));
    });
  }

  async *iter(topic: string): AsyncIterable<Record> {
    const db = await this.dbPromise;
    const tx = db.transaction("records", "readonly");
    const store = tx.objectStore("records");
    const range = IDBKeyRange.bound([topic], [topic, []], false, false);
    const req = store.openCursor(range);

    const records: Record[] = [];
    await new Promise<void>((resolve, reject) => {
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          records.push(deserialize(cursor.value));
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => reject(req.error);
    });
    for (const r of records) {
      yield r;
    }
  }

  /**
   * Read all pending records along with their IDB keys, ordered by insertion.
   * Used by the drain loop to replay buffered writes.
   */
  async getPending(): Promise<Array<{ key: IDBValidKey; record: Record }>> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("pending", "readonly");
      const store = tx.objectStore("pending");
      const req = store.openCursor();
      const results: Array<{ key: IDBValidKey; record: Record }> = [];

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          results.push({ key: cursor.key, record: deserialize(cursor.value) });
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Remove a single pending record by its auto-increment key.
   * Called after a pending write has been ack'd by the broker.
   */
  async removePending(key: IDBValidKey): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("pending", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore("pending").delete(key);
    });
  }

  async close(): Promise<void> {
    const db = await this.dbPromise;
    db.close();
  }
}

function serialize(rec: Record): unknown {
  return { ...rec, offset: rec.offset.toString() };
}

function deserialize(raw: any): Record {
  return { ...raw, offset: BigInt(raw.offset) };
}
