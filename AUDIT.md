# Clean Code and SRP Audit

## Summary

- **Highest-leverage split:** remove WebSocket/WebTransport ownership from
  `Client` into two transport implementations behind one internal transport
  contract.
- `Client` currently changes for browser transport APIs, reconnect policy,
  incoming wire decoding, topic subscriptions, offline persistence, and drain
  orchestration.
- Incoming frame normalization is a meaningful protocol decision and should be
  independently tested outside transport callbacks.
- `LocalStore` is cohesive despite managing two object stores: both exist for
  one IndexedDB persistence actor and share one database lifecycle.
- CRDT and Moonshot modules are long enough to inspect but each has one actor
  and should remain independent.

## Findings

| ID | Location | Category | Severity | Actors in conflict | Cost | Size | Behavior risk |
|---|---|---|---|---|---|---|---|
| BROWSER-SRP-1 | `src/client.ts:36-375` | SRP, mixed class | P1 | browser transport maintainers; reconnect policy; wire protocol; offline product; topic consumers | A browser API change and a persistence/drain change edit the same stateful client and lifecycle methods. | L | Medium |
| BROWSER-SRP-2 | `src/client.ts:226-245,378-417` | Function/module SRP | P2 | wire-contract consumers; transport callbacks | JSON parsing, validation/defaults, byte conversion, and listener dispatch are interleaved; malformed frames are silently discarded at the transport boundary. | M | Medium |
| BROWSER-CC-1 | `src/client.ts:175-196` | Hidden lifecycle side effect | P2 | application lifecycle; reconnect policy | Any close starts an unbounded reconnect loop unless the separate `reconnecting` flag was set by `close()`. | S | Medium |

## Actor and State Partition

| Partition | Fields/methods | Actor |
|---|---|---|
| Transport state | socket, WebTransport connection/reader/writer, connect/send/read/close | browser platform |
| Reconnect state | connected, reconnecting, delay policy | reliability |
| Wire codec | incoming JSON normalization, byte/header/offset conversion | protocol |
| Subscriptions | topic listener map, subscribe/unsubscribe/dispatch | SDK consumer |
| Offline drain | LocalStore, draining guard, pending replay/progress | offline-first product |

Resulting internal units:

- `WebSocketTransport` and `WebTransportTransport`, both owning real connection
  state and implementing the same internal transport operations.
- `decodeIncomingRecord` in `wire.ts`, returning a typed record or `undefined`.
- `Client` retaining reconnect, subscription, offline drain, and public API
  orchestration.

## Ordered Refactor Sequence

1. Characterize incoming record decoding and both transport lifecycle paths.
2. Move wire normalization unchanged into `wire.ts`.
3. Improve the decoder using explicit typed boundaries while preserving current
   defaults and malformed-frame behavior.
4. Move WebSocket and WebTransport state/methods into two transport units.
5. Keep reconnect and offline draining in `Client`; do not create a forwarding
   service layer.
6. Run tests, lint, typecheck, and build after every commit.

## Deferred

- Reconnect attempt limits and cancellation policy are product behavior and are
  not changed by this structural pass.
- WebTransport integration requires a real browser/server environment; unit
  tests use platform fakes.

## Out of Scope

- `LocalStore`: one persistence actor and one database lifecycle.
- `Topic`: one topic-handle abstraction over local history and live tailing.
- `LWWRegister`/HLC code: one CRDT actor.
- Moonshot read-only clients: one gateway-safe HTTP contract.
