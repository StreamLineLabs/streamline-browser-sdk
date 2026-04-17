# Streamline Browser SDK

[![CI](https://github.com/streamlinelabs/streamline-browser-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/streamlinelabs/streamline-browser-sdk/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4%2B-blue.svg)](https://www.typescriptlang.org/)
[![Docs](https://img.shields.io/badge/docs-streamlinelabs.dev-blue.svg)](https://streamlinelabs.dev/docs/sdks/browser)
[![Release](https://img.shields.io/github/v/release/streamlinelabs/streamline-browser-sdk?label=release)](https://github.com/streamlinelabs/streamline-browser-sdk/releases)

> ⚠️ **Experimental (M3)** — This SDK is part of the Edge & CRDT moonshot. APIs may change between releases.

Browser client SDK for [Streamline](https://github.com/streamlinelabs/streamline) — *The Redis of Streaming*.
Produce and consume directly from the browser via WebSocket/WebTransport, with IndexedDB persistence and CRDT sync.

## Requirements

- Modern browser (Chrome 114+, Firefox 113+, Safari 16.4+)
- Node.js 18+ (for build tooling)
- Streamline server 0.2.0 or later

## Installation

```bash
npm install @streamlinelabs/browser-sdk
```

## Quick Start

```typescript
import { StreamlineBrowser } from '@streamlinelabs/browser-sdk';

const client = new StreamlineBrowser('ws://localhost:9092', {
  authToken: 'my-token',
});

await client.connect();

// Produce a message
await client.produce('events', { action: 'click', page: '/home' });

// Consume messages
client.subscribe('events', (message) => {
  console.log('Received:', message.value);
});

// Disconnect when done
client.disconnect();
```

## Features

- **WebSocket & WebTransport** — dual-transport with automatic fallback
- **IndexedDB persistence** — messages survive page reloads and browser restarts
- **CRDT sync** — automatic conflict-free merge on reconnect
- **Offline-first** — produce while offline, sync when connectivity returns
- **Lightweight** — small bundle size suitable for browser environments
- **TypeScript-first** — full type safety with comprehensive type definitions

## Moonshot Features

### CRDT Sync (M3)

Streamline's browser SDK uses CRDTs (Conflict-free Replicated Data Types) to enable seamless offline-first workflows. State changes made offline are automatically merged when the client reconnects — no manual conflict resolution needed.

```typescript
import { StreamlineBrowser, CrdtMap } from '@streamlinelabs/browser-sdk';

const client = new StreamlineBrowser('ws://localhost:9092');
await client.connect();

// Create a CRDT-backed map that syncs across clients
const preferences = new CrdtMap(client, 'user-preferences');

// Set values — works offline, merges on reconnect
preferences.set('theme', 'dark');
preferences.set('language', 'en');

// Listen for remote changes
preferences.on('change', (key, value) => {
  console.log(`${key} updated to ${value}`);
});

// Get current merged state
const theme = preferences.get('theme');
```

### WebTransport

When available, the SDK uses WebTransport for lower-latency, multiplexed streaming. Falls back to WebSocket automatically.

```typescript
const client = new StreamlineBrowser('https://localhost:9092', {
  transport: 'webtransport', // 'websocket' | 'webtransport' | 'auto'
});
```

### Offline-First Usage

Messages produced while offline are buffered in IndexedDB and delivered when connectivity returns.

```typescript
const client = new StreamlineBrowser('ws://localhost:9092', {
  offline: {
    enabled: true,
    maxQueueSize: 10_000,   // Max buffered messages
    storeName: 'my-app',    // IndexedDB store name
  },
});

await client.connect();

// This works even when disconnected
await client.produce('user-actions', { action: 'save-draft', content: '...' });

// Check connection state
client.on('stateChange', (state) => {
  console.log(`Connection: ${state}`); // 'connected' | 'disconnected' | 'syncing'
});
```

### Edge Sync

Synchronize topics between edge devices, browsers, and the central Streamline cluster.

```typescript
const client = new StreamlineBrowser('ws://edge-node.local:9092', {
  sync: {
    topics: ['user-preferences', 'offline-actions'],
    mergePolicy: 'last-writer-wins',
    syncInterval: 5000, // ms
  },
});

await client.connect();

// Subscribe to sync status
client.on('syncComplete', (topic, stats) => {
  console.log(`${topic}: merged ${stats.merged} records, conflicts=${stats.conflicts}`);
});
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Type checking
npm run typecheck
```

## Contributing

Contributions are welcome! This is a community-maintained SDK. Please see the [organization contributing guide](https://github.com/streamlinelabs/.github/blob/main/CONTRIBUTING.md) for guidelines.

## License

Apache-2.0
