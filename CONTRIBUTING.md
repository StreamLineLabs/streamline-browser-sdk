# Contributing to the Streamline Browser SDK

Thank you for contributing to the experimental Streamline browser client.

## Prerequisites

- Node.js 18 or later
- npm (use the version bundled with your Node.js installation)
- A modern browser when manually exercising browser-only behavior

## Development setup

```bash
git clone https://github.com/<your-username>/streamline-browser-sdk.git
cd streamline-browser-sdk
npm ci
```

Create a focused branch, make the smallest practical change, and add regression
or characterization tests for behavior you modify.

## Repository layout

- `src/` — SDK source and colocated Vitest unit tests
- `examples/` — TypeScript examples mirrored in the published README
- `scripts/` — release, documentation, integration, and package checks
- `.github/workflows/` — CI, integration, security, and publication automation

The package is ESM-only and targets browser APIs. Avoid adding Node-only runtime
dependencies to files exported from `src/index.ts`.

## Required checks

Run the full local quality gate before opening a pull request:

```bash
npm run check
```

There is no formatter script currently configured. Follow the existing
two-space indentation, double-quoted string, semicolon-terminated TypeScript
style and rely on ESLint for configured style checks.

### Unit tests

Vitest discovers `src/**/*.test.ts`. The test setup installs
`fake-indexeddb` so IndexedDB paths can be exercised without replacing the
storage implementation.

```bash
npm test
```

When changing transports, preserve tests for connection lifecycle, frame
normalization, error handling, and disconnect behavior. Browser platform fakes
are appropriate for isolated unit tests, but must not be presented as live
integration coverage.

### README and example checks

Published TypeScript snippets are mirrored in `examples/`. Each linked README
block must exactly match its example file, and all examples must compile:

```bash
npm run check:examples
```

Update the README block and corresponding example together.

### Live integration

This repository does not contain a browser-protocol server fixture or validated
live suite. The raw Kafka listener exposed by the core Streamline server is not
a substitute for a WebSocket/WebTransport endpoint.

The integration command therefore fails intentionally:

```bash
npm run test:integration
```

Do not replace this gate with a transport-open check or a fallback to unit
tests. A future live suite must use an explicit compatible protocol and fail on
server errors, rejected authentication, missing acknowledgements, disconnects,
and timeouts. Keep credentialed endpoints administrator-controlled rather than
accepting a caller-supplied URL.

## API and durability documentation

Keep documentation aligned with exports from `src/index.ts`. In particular:

- `Topic.append()` and `Client.produce()` confirm an IndexedDB write, not a
  broker acknowledgement.
- Pending entries are removed after transport handoff.
- `LWWRegister` is a standalone in-memory primitive and does not synchronize
  automatically.
- `Topic.consume()` reads the local records store; the client does not currently
  populate that store from incoming frames.

Do not claim stronger delivery, persistence, authentication, compatibility, or
CRDT synchronization guarantees without corresponding protocol behavior and
tests.

## Pull request guidelines

- Explain the user-visible behavior and compatibility impact.
- Include tests for success, failure, and relevant edge cases.
- Update documentation and examples for public API changes.
- Keep generated `dist/` output out of commits.
- Ensure `npm pack --dry-run` contains no tests, test setup, secrets, or
  development-only files.
- Do not change the package version in feature pull requests.

## Reporting issues

Search existing issues before opening a new one. Include reproduction steps,
runtime/browser details, endpoint transport type, and a minimal example.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md);
do not open a public security issue.

## Code of Conduct

All contributors must follow the repository [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0.
