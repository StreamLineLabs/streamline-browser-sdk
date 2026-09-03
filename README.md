# Streamline Browser SDK

[![CI](https://github.com/streamlinelabs/streamline-browser-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/streamlinelabs/streamline-browser-sdk/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4%2B-blue.svg)](https://www.typescriptlang.org/)
[![Docs](https://img.shields.io/badge/docs-streamlinelabs.dev-blue.svg)](https://streamlinelabs.dev/docs/sdks/browser)
[![Release](https://img.shields.io/github/v/release/streamlinelabs/streamline-browser-sdk?label=release)](https://github.com/streamlinelabs/streamline-browser-sdk/releases)

> ⚠️ **Experimental (M3)** — APIs and the browser wire contract may change between releases.

An ESM-only browser client for Streamline with WebSocket/WebTransport transports,
an IndexedDB-backed outbound queue, topic handles, and standalone CRDT
primitives.

## Runtime requirements

The package targets browser applications. It requires:

- IndexedDB, `TextEncoder`, `TextDecoder`, and `BigInt`
- WebSocket, or WebTransport when explicitly preferred and available
- `fetch` and `AbortController` only when using the Moonshot HTTP clients

Node.js 18+ is supported for development tooling, not as a production SDK
runtime.

No browser/version compatibility matrix or Streamline server-version matrix is
currently verified in CI. This repository also has no validated
browser-compatible Streamline server fixture. A raw Kafka TCP endpoint is not
sufficient.

## Installation

```bash
npm install @streamlinelabs/browser-sdk
```

## Quick start

`Client.connect()` resolves when the browser transport opens. It does not wait
for an authentication acknowledgement or broker-level readiness response.

<!-- example: examples/quick-start.ts -->
```typescript
import { Client } from "@streamlinelabs/browser-sdk";

const client = new Client({
  url: "wss://streamline.example.com/browser",
  clientId: "checkout-ui",
  preferTransport: "websocket",
});
const events = client.topic("events");

await client.connect();

try {
  await events.append({
    key: "page:/home",
    value: { action: "click", page: "/home" },
  });
  console.log("The record was written to the local pending queue.");
} finally {
  await client.close();
}
```

`Topic.append()` first commits the record to the client's IndexedDB pending
queue. When connected, a background drain attempts to hand queued records to
the selected browser transport.

**There is currently no broker acknowledgement protocol in this SDK.** A
pending record is removed after `WebSocket.send()` returns or a WebTransport
writer accepts the frame. This is not acknowledgement-backed durability,
delivery confirmation, or exactly-once delivery. Applications that require
those guarantees must wait for a future acknowledged protocol or implement
confirmation through an application-specific server API.

## Public API

### Client and Topic

- `new Client({ url, clientId, token?, preferTransport?, reconnectDelayMs? })`
- `client.connect()`, `client.close()`, and `client.isConnected`
- `client.topic(name)` returns a `Topic`
- `topic.append({ key?, value })` queues an outbound record
- `topic.consume()` reads the local `records` object store only
- `topic.tail()` replays that local store and then waits for compatible
  incoming frames already delivered by the transport

The client currently populates the pending outbound store but does not
automatically persist incoming records into the local `records` store.
Consequently, `consume()` and the replay phase of `tail()` return records only
if that store was populated by compatible application or migration code.
`tail()` does not send a broker subscription command, so it must not be treated
as a working server-side consume round trip.

### LocalStore

`LocalStore` is exported for applications that need direct access to the
IndexedDB pending queue. Its records use `Uint8Array` payloads and `bigint`
offsets.

<!-- example: examples/local-store.ts -->
```typescript
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
```

Directly removing pending entries has the same limitation as the client drain:
the store itself has no broker acknowledgement concept.

### LWWRegister

`LWWRegister` is an in-memory Last-Writer-Wins register using Hybrid Logical
Clock timestamps. It does not connect to `Client`, persist itself, discover
peers, or synchronize automatically. Applications must transport snapshots and
call `merge()` explicitly.

<!-- example: examples/lww-register.ts -->
```typescript
import { LWWRegister } from "@streamlinelabs/browser-sdk";

const browserA = new LWWRegister<string>("browser-a");
browserA.set("dark");

const value = browserA.get();
if (value !== undefined) {
  const browserB = new LWWRegister<string>("browser-b");
  const result = browserB.merge({
    value,
    timestamp: browserA.timestamp,
  });

  console.log(result.chosen, browserB.get());
}
```

## Transport and offline behavior

- Automatic selection chooses WebTransport when the global API exists;
  otherwise it chooses WebSocket.
- Explicit WebTransport preference falls back to WebSocket when WebTransport
  is unavailable.
- Reconnection retries indefinitely with exponential backoff, up to 30 seconds
  between attempts.
- Outbound records can be queued while disconnected and survive reloads in
  IndexedDB.
- Queue draining is best-effort and has no broker acknowledgement, delivery
  receipt, deduplication, or exactly-once guarantee.
- CRDT merging is a separate local primitive; reconnecting does not trigger
  CRDT synchronization.

## Security considerations

- Use `wss://` or `https://` endpoints in production. Plaintext examples are
  suitable only for controlled local development.
- A configured token is available to page JavaScript and is sent in the first
  application-level transport frame. Use short-lived, least-privilege browser
  credentials and a restrictive Content Security Policy.
- `connect()` does not verify that the server accepted the token.
- IndexedDB contents are not encrypted by this package. Do not queue secrets or
  sensitive payloads unless the application encrypts them first and manages
  keys outside the stored data.
- The Moonshot browser clients intentionally expose read-only search and memory
  recall operations. Keep administrative, signing, and write credentials in a
  server-side gateway.

See [SECURITY.md](SECURITY.md) for supported release lines and vulnerability
reporting.

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run check
```

This repository has no validated browser-protocol fixture or live test suite.
The integration command therefore fails intentionally:

```bash
npm run test:integration
```

Opening a WebSocket and returning from `send()` is not accepted as an
integration result because it cannot prove authentication, server acceptance,
subscription behavior, or acknowledgement. The release workflow remains
blocked until an explicit compatible suite verifies those semantics and fails
on server errors, rejected authentication, missing acknowledgements,
disconnects, and timeouts. The command never falls back to unit tests.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0
