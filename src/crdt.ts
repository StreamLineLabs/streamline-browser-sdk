/**
 * Last-Writer-Wins Register CRDT implementation.
 * Uses Hybrid Logical Clock (HLC) timestamps for causality.
 */

/** Hybrid Logical Clock timestamp for causal ordering. */
export interface HLC {
  /** Wall-clock time in milliseconds since epoch. */
  wallClock: number;
  /** Logical counter — breaks ties when wall clocks are equal. */
  logical: number;
  /** Unique identifier for the originating node. */
  nodeId: string;
}

/**
 * Compare two HLC timestamps.
 *
 * Returns a negative number if `a < b`, positive if `a > b`, or zero if
 * equal. When wall clocks match, the logical counter is compared; when
 * both match, the nodeId is compared lexicographically for determinism.
 */
export function compareHLC(a: HLC, b: HLC): number {
  if (a.wallClock !== b.wallClock) {
    return a.wallClock - b.wallClock;
  }
  if (a.logical !== b.logical) {
    return a.logical - b.logical;
  }
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

/**
 * Produce a new HLC that is strictly greater than `current`.
 *
 * If the physical clock has advanced, the logical counter resets to 0;
 * otherwise the logical counter is incremented.
 */
export function incrementHLC(current: HLC): HLC {
  const now = Date.now();
  if (now > current.wallClock) {
    return { wallClock: now, logical: 0, nodeId: current.nodeId };
  }
  return {
    wallClock: current.wallClock,
    logical: current.logical + 1,
    nodeId: current.nodeId,
  };
}

/**
 * A Last-Writer-Wins Register backed by HLC timestamps.
 *
 * `set()` always advances the local clock; `merge()` picks the value
 * with the higher HLC, ensuring convergence regardless of merge order.
 */
export class LWWRegister<T> {
  private _value: T | undefined;
  private _timestamp: HLC;

  constructor(private nodeId: string) {
    this._timestamp = { wallClock: 0, logical: 0, nodeId };
    this._value = undefined;
  }

  /** Set a new local value, advancing the HLC. */
  set(value: T): void {
    this._timestamp = incrementHLC(this._timestamp);
    this._value = value;
  }

  /** Read the current value (may be `undefined` before any `set`). */
  get(): T | undefined {
    return this._value;
  }

  /** Return the current HLC timestamp of the stored value. */
  get timestamp(): HLC {
    return this._timestamp;
  }

  /**
   * Merge a remote value.
   *
   * The value with the higher HLC wins. Returns `'local'` if the local
   * value was retained, `'remote'` if the remote value was adopted.
   */
  merge(other: { value: T; timestamp: HLC }): { chosen: "local" | "remote" } {
    const cmp = compareHLC(other.timestamp, this._timestamp);
    if (cmp > 0) {
      this._value = other.value;
      this._timestamp = other.timestamp;
      return { chosen: "remote" };
    }
    return { chosen: "local" };
  }
}
