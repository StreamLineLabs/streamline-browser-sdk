/**
 * @streamlinelabs/browser-sdk — public entry point.
 *
 * Stability: Experimental (M3 P1). API will change before GA.
 */
export { Client } from "./client.js";
export type { ClientOptions, DrainCallback } from "./client.js";
export { Topic } from "./topic.js";
export { LocalStore } from "./storage.js";
export { StreamlineError, StreamlineErrorCode, validateTopicName } from "./types.js";
export type { Record, RecordHeaders, DrainProgress } from "./types.js";
export {
  SearchClient,
  MemoryReadClient,
  MoonshotError,
} from "./moonshot.js";
export type {
  MoonshotOptions,
  SearchHit,
  MemoryRecord,
  MemoryKind,
} from "./moonshot.js";
export { LWWRegister, compareHLC, incrementHLC } from "./crdt.js";
export type { HLC } from "./crdt.js";
