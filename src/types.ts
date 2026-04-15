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
