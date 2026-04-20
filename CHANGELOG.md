# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]


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
