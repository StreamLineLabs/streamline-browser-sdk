# Security Policy

## Supported versions

This SDK is experimental and does not yet have a long-term-support release
line. Security fixes are applied to the current `0.4.x` line only.

| Version | Supported |
| --- | --- |
| 0.4.x | Yes |
| 0.3.x and earlier | No |

Upgrade to the latest `0.4.x` patch before reporting an issue. Browser runtime
compatibility is capability-based and is not a tested security-support matrix;
see [README.md](README.md#runtime-requirements).

## Reporting a vulnerability

Report suspected vulnerabilities privately to **security@streamlinelabs.dev**.

Do not open a public issue, discussion, or pull request containing vulnerability
details before coordinated disclosure.

Include:

- A description of the vulnerability and affected SDK version
- Browser/runtime and transport details
- Reproduction steps or a minimal proof of concept
- Potential impact and required attacker capabilities
- Any suggested mitigation or fix

The maintainers aim to acknowledge reports within 48 hours and provide an
initial assessment within five business days. Remediation and disclosure timing
depend on severity, affected components, and coordination with the reporter.

## Security boundaries

- Use `wss://` or `https://` endpoints outside controlled local development.
- Browser tokens are readable by JavaScript running in the same page. Use
  short-lived, least-privilege credentials and a restrictive Content Security
  Policy; do not embed administrative or signing credentials.
- WebSocket authentication is sent as the first application frame.
  `Client.connect()` confirms only that the browser transport opened; it does
  not confirm server acceptance of the token.
- IndexedDB data is origin-accessible and is not encrypted by this SDK. Encrypt
  sensitive payloads before queueing them and keep keys separate from stored
  ciphertext.
- Pending records are removed after browser transport handoff. The SDK has no
  broker acknowledgement, delivery receipt, deduplication, or exactly-once
  protocol.
- `LWWRegister` is an in-memory merge primitive. It does not authenticate peers
  or synchronize state.
- Moonshot browser clients intentionally expose read-only operations. Route
  administrative, signing, mutation, and privileged write operations through a
  server-side gateway.

Applications are responsible for endpoint authorization, token issuance,
cross-origin policy, payload validation, abuse controls, and data retention.
