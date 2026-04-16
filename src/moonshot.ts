/**
 * Browser-safe subset of the Streamline Moonshot HTTP API.
 *
 * **Scope (deliberate):** only read-side operations are exposed here:
 *   - {@link SearchClient}      — POST /api/v1/search          (M2 semantic search)
 *   - {@link MemoryReadClient}  — POST /api/v1/memory/recall   (M1 agent memory recall)
 *
 * **Excluded by design:** attestation signing, contract registration, branch
 * mutation, and `memory/remember` are admin / write / signing operations. They
 * MUST NOT be exposed to browser contexts because they would either leak
 * signing material via XHR-attached headers or grant write access to any
 * embedded JavaScript on the page. Use a server-side gateway for those.
 *
 * Stability: Experimental — API may change before GA.
 */

export interface MoonshotOptions {
  /** e.g. https://gateway.example.com */
  httpUrl: string;
  /** Optional bearer token; sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Per-request timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** Optional fetch impl override (defaults to globalThis.fetch). */
  fetch?: typeof fetch;
}

export class MoonshotError extends Error {
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "MoonshotError";
    this.status = status;
    this.body = body;
  }
}

export interface SearchHit {
  topic: string;
  partition: number;
  offset: number;
  score: number;
  snippet?: string;
}

export type MemoryKind = "observation" | "fact" | "procedure";

export interface MemoryRecord {
  agent: string;
  kind: MemoryKind;
  text: string;
  tags: string[];
  timestampMs: number;
}

abstract class MoonshotHttpBase {
  protected readonly base: string;
  protected readonly token?: string;
  protected readonly timeoutMs: number;
  protected readonly fetchImpl: typeof fetch;

  constructor(opts: MoonshotOptions) {
    if (!opts.httpUrl) throw new MoonshotError("httpUrl is required");
    this.base = opts.httpUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    const f = opts.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) {
      throw new MoonshotError(
        "fetch is not available; pass opts.fetch or run on a fetch-capable runtime",
      );
    }
    this.fetchImpl = f;
  }

  protected async request<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new MoonshotError(
          `${path} returned ${res.status}`,
          res.status,
          text,
        );
      }
      return text ? (JSON.parse(text) as T) : ({} as T);
    } catch (err) {
      if (err instanceof MoonshotError) throw err;
      if ((err as { name?: string }).name === "AbortError") {
        throw new MoonshotError(`${path} timed out after ${this.timeoutMs}ms`);
      }
      throw new MoonshotError(
        `${path} transport error: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(t);
    }
  }
}

export class SearchClient extends MoonshotHttpBase {
  async search(topic: string, query: string, k = 10): Promise<SearchHit[]> {
    if (!topic) throw new MoonshotError("topic is required");
    if (!query) throw new MoonshotError("query is required");
    if (k <= 0) throw new MoonshotError("k must be > 0");
    const resp = await this.request<{ hits?: unknown[] }>("/api/v1/search", {
      topic,
      query,
      k,
    });
    return (resp.hits ?? []).map((h) => {
      const o = h as Record<string, unknown>;
      return {
        topic: String(o.topic ?? ""),
        partition: Number(o.partition ?? 0),
        offset: Number(o.offset ?? 0),
        score: Number(o.score ?? 0),
        snippet: typeof o.snippet === "string" ? o.snippet : undefined,
      };
    });
  }
}

export class MemoryReadClient extends MoonshotHttpBase {
  async recall(agent: string, query: string, k = 5): Promise<MemoryRecord[]> {
    if (!agent) throw new MoonshotError("agent is required");
    if (!query) throw new MoonshotError("query is required");
    if (k <= 0) throw new MoonshotError("k must be > 0");
    const resp = await this.request<{ memories?: unknown[] }>(
      "/api/v1/memory/recall",
      { agent, query, k },
    );
    return (resp.memories ?? []).map((m) => {
      const o = m as Record<string, unknown>;
      return {
        agent: String(o.agent ?? agent),
        kind: (String(o.kind ?? "observation") as MemoryKind),
        text: String(o.text ?? ""),
        tags: Array.isArray(o.tags) ? (o.tags as string[]) : [],
        timestampMs: Number(o.timestamp_ms ?? 0),
      };
    });
  }
}
