import {
  LocalStore,
  type Record as StreamlineRecord,
} from "@streamlinelabs/browser-sdk";

const store = new LocalStore("my-app-streamline");
const record: StreamlineRecord = {
  topic: "events",
  partition: 0,
  offset: -1n,
  value: new TextEncoder().encode("queued"),
  timestampMs: Date.now(),
};

await store.appendPending(record);
const pending = await store.getPending();
console.log(`Queued records: ${pending.length}`);
await store.close();
