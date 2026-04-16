// Polyfill IndexedDB for Node-based vitest runs so LocalStore tests can
// exercise the real `indexedDB.open(...)` code path.
import "fake-indexeddb/auto";
