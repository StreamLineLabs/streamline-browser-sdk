# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]

### Fixed
- `WebSocketTransport.send()` now rejects unless its socket is both `OPEN` and
  belongs to the current connection generation, preventing a superseded or
  closing socket from authorizing deletion of a pending IndexedDB record.
- `Client.close()` is terminal: it cancels reconnect backoff immediately,
  fences in-flight connection attempts, and prevents stale disconnect
  callbacks from reconnecting or touching the closed store.
- `Client`'s internal `drainPending()` no longer takes a single stale
  snapshot of the pending store per invocation. Previously, a record
  appended by `produce()` while a drain was already mid-flight (awaiting
  `getPending()`, `send()`, or `removePending()`) was invisible to that
  snapshot, and the `produce()` call's own attempt to trigger a drain was a
  no-op because a `draining` guard silently discarded it — the record could
  sit in IndexedDB indefinitely, until some unrelated later `produce()`/
  `connect()` happened to run. `drainPending()` now loops on a
  `drainRequested` latch: a drain request that arrives while one is already
  running sets the latch instead of being dropped, and the active session
  checks it after every pass and runs another pass (re-fetching from the
  store) before returning, so a concurrently appended record is always
  drained in the same session with no external trigger required. This does
  not introduce overlapping drain loops (the latch, not a second call,
  drives the extra pass), does not delete a record when `send()` rejects
  (the loop still only removes a record once its `send()` has resolved),
  and re-checks the client's closed/connected state at every await point so
  a `close()` or disconnect racing with an in-flight pass never issues a
  new store operation on a closed IndexedDB connection and never keeps
  sending on a dead transport. A record whose `send()` succeeded immediately
  before a close boundary is deliberately left in the store rather than
  deleted — an occasional duplicate redelivery on the next connection is
  preferable to silently losing it.

### Changed
- Rewrote `README.md` to remove unimplemented API examples (`StreamlineBrowser`,
  `CrdtMap`, edge sync config) and replace them with compiling examples that
  are checked against `examples/*.ts` in CI (`npm run check:examples`).
  Documentation now states explicitly that `connect()` does not wait for a
  broker acknowledgement, that queued records are removed on transport
  handoff (not on broker ack), and that `LWWRegister`/CRDT sync is a
  standalone in-memory primitive that does not auto-synchronize.
- Rewrote `CONTRIBUTING.md`, which incorrectly described the Go SDK's
  toolchain (`go build`, `go test`, `staticcheck`) instead of this
  repository's Node/TypeScript workflow.
- Rewrote `SECURITY.md` to reference the current `0.4.x` support line (was
  still listing `0.2.x`) and to document token exposure, IndexedDB
  encryption, and acknowledgement boundaries.
- `.github/workflows/integration.yml` no longer runs on every push/PR against
  a best-effort `ghcr.io/streamlinelabs/streamline:latest` container and no
  longer falls back to `npm test` when integration tests are absent or fail.
  It is now a manually dispatched, fail-closed live-integration gate.
- `.github/workflows/publish.yml` now triggers on `v*` tags instead of
  GitHub Releases, and gates `npm publish` behind `validate` (tag/version
  match), `quality` (`npm run check`), and `integration`
  (`npm run test:integration`) jobs so a release cannot proceed on a version
  or protocol mismatch, and publishes with `--provenance`.

### Added
- `scripts/validate-release.mjs` (+ `check:metadata` / `check:release`) —
  validates `package.json`/`package-lock.json` name, version, and
  non-private status, and that release tags (`vX.Y.Z`) match the package
  version.
- `scripts/check-package.mjs` (`check:package`) — runs `npm pack --dry-run`
  and fails if the published tarball is missing `LICENSE`/`README.md`/build
  output, or contains `src`, `test`, `examples`, `scripts`, `.github`, or
  test-setup/`.test.*` files.
- `scripts/check-sbom.mjs` (`check:sbom`) — validates that `npm sbom` emits a
  CycloneDX document whose root component matches the package name/version.
- `scripts/check-readme-examples.mjs` (`check:examples`) — verifies every
  `<!-- example: examples/*.ts -->` snippet in `README.md` exactly matches its
  example file and that all examples type-check.
- `scripts/run-live-integration.mjs` (`test:integration`) — fails closed with
  an explicit blocker message; there is no compatible browser-protocol
  Streamline fixture in this repository, so this command must never be
  satisfied by a transport-open check or a fallback to unit tests.
- `npm run check` — aggregate lint/typecheck/unit/release-metadata/example/
  package/SBOM gate, run in CI and as `prepublishOnly`.
- `exports` map and `sideEffects: false` in `package.json` for correct ESM
  bundler/Node resolution and tree-shaking.

## [0.3.0] - 2026-04-20

### Added
- `src/moonshot.ts` — read-safe subset of the Streamline Moonshot HTTP API:
  - `SearchClient` (M2 — semantic search)
  - `MemoryReadClient` (M1 — agent memory recall only)
- Shared `MoonshotOptions`, `MoonshotError`, `SearchHit`, `MemoryRecord`,
  `MemoryKind` types re-exported from the package root.
- Excluded by design: attestation signing, contract registration, branch
  mutation, and `memory/remember`. These are admin/write/signing operations
  that must not run in browser contexts; route through a server-side gateway.
