export interface RecordHeaders {
  [key: string]: string;
}

export interface Record {
  topic: string;
  partition: number;
  offset: bigint;
  key?: Uint8Array;
  value: Uint8Array;
  timestampMs: number;
  headers?: RecordHeaders;
}

/**
 * Progress event emitted during pending write draining.
 */
export interface DrainProgress {
  /** Number of records successfully sent so far. */
  sent: number;
  /** Total number of pending records in this drain batch. */
  total: number;
}

/**
 * Structured error codes for programmatic error handling.
 */
export enum StreamlineErrorCode {
  /** Network or transport failure. */
  Connection = "CONNECTION",
  /** WebSocket or WebTransport handshake failed. */
  Transport = "TRANSPORT",
  /** Server rejected authentication credentials. */
  Authentication = "AUTHENTICATION",
  /** Operation not permitted. */
  Authorization = "AUTHORIZATION",
  /** Produce or consume failed. */
  Messaging = "MESSAGING",
  /** IndexedDB persistence error. */
  Storage = "STORAGE",
  /** JSON parse or binary decode error. */
  Serialization = "SERIALIZATION",
  /** Invalid topic name or configuration. */
  Configuration = "CONFIGURATION",
  /** Operation exceeded timeout. */
  Timeout = "TIMEOUT",
  /** Moonshot HTTP API error. */
  Moonshot = "MOONSHOT",
  /** Catch-all for unexpected failures. */
  Unknown = "UNKNOWN",
}

/**
 * Structured error with machine-readable code and optional retry hint.
 */
export class StreamlineError extends Error {
  readonly code: StreamlineErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;

  constructor(
    message: string,
    code: StreamlineErrorCode = StreamlineErrorCode.Unknown,
    options?: { retryable?: boolean; hint?: string; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "StreamlineError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.hint = options?.hint;
  }
}

/** Kafka-compatible topic name validation. */
const TOPIC_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MAX_TOPIC_LENGTH = 249;

export function validateTopicName(topic: string): void {
  if (!topic || topic.length === 0) {
    throw new StreamlineError(
      "Topic name cannot be empty",
      StreamlineErrorCode.Configuration,
      { hint: "Provide a non-empty topic name containing only alphanumeric characters, '.', '_', or '-'" },
    );
  }
  if (topic === "." || topic === "..") {
    throw new StreamlineError(
      `Topic name cannot be '${topic}'`,
      StreamlineErrorCode.Configuration,
      { hint: "Use a descriptive topic name (e.g., 'events', 'user-actions')" },
    );
  }
  if (topic.length > MAX_TOPIC_LENGTH) {
    throw new StreamlineError(
      `Topic name exceeds maximum length of ${MAX_TOPIC_LENGTH} characters`,
      StreamlineErrorCode.Configuration,
    );
  }
  if (!TOPIC_NAME_PATTERN.test(topic)) {
    throw new StreamlineError(
      `Topic name '${topic}' contains invalid characters`,
      StreamlineErrorCode.Configuration,
      { hint: "Topic names may only contain alphanumeric characters, '.', '_', or '-'" },
    );
  }
}
