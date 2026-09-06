import type { Record } from "./types.js";

export function decodeIncomingRecord(data: ArrayBuffer | string): Record | undefined {
  try {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    const parsed: unknown = JSON.parse(text);
    if (!isObjectRecord(parsed)) return undefined;

    return {
      topic: typeof parsed.topic === "string" ? parsed.topic : "",
      partition: typeof parsed.partition === "number" ? parsed.partition : 0,
      offset: parseOffset(parsed.offset),
      key: parseBytes(parsed.key),
      value: parseValue(parsed.value),
      timestampMs: typeof parsed.timestampMs === "number" ? parsed.timestampMs : Date.now(),
      headers: parseHeaders(parsed.headers),
    };
  } catch {
    return undefined;
  }
}

export function isObjectRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

export function parseOffset(value: unknown): bigint {
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

export function parseBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return new Uint8Array(value);
  }
  return undefined;
}

export function parseValue(value: unknown): Uint8Array {
  const bytes = parseBytes(value);
  if (bytes) return bytes;

  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return new TextEncoder().encode(text);
}

export function parseHeaders(value: unknown): { [key: string]: string } | undefined {
  if (!isObjectRecord(value)) return undefined;

  const headers = Object.entries(value);
  if (!headers.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    return undefined;
  }
  return Object.fromEntries(headers);
}
