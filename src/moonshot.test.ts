import { describe, it, expect } from "vitest";
import {
  SearchClient,
  MemoryReadClient,
  MoonshotError,
  type MoonshotOptions,
} from "./moonshot.js";

function fakeFetch(
  status: number,
  body: unknown,
  capture?: { req?: { url: string; init: RequestInit } },
): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (capture) capture.req = { url: String(url), init: init ?? {} };
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function opts(overrides: Partial<MoonshotOptions> = {}): MoonshotOptions {
  return { httpUrl: "https://example.test", ...overrides };
}

describe("SearchClient", () => {
  it("posts to /api/v1/search and parses hits", async () => {
    const cap: { req?: { url: string; init: RequestInit } } = {};
    const c = new SearchClient(
      opts({
        token: "tok",
        fetch: fakeFetch(
          200,
          {
            hits: [
              { topic: "t", partition: 0, offset: 7, score: 0.9, snippet: "hi" },
            ],
          },
          cap,
        ),
      }),
    );
    const hits = await c.search("t", "q", 3);
    expect(hits).toEqual([
      { topic: "t", partition: 0, offset: 7, score: 0.9, snippet: "hi" },
    ]);
    expect(cap.req?.url).toBe("https://example.test/api/v1/search");
    expect((cap.req?.init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok",
    );
    expect(JSON.parse(cap.req?.init.body as string)).toEqual({
      topic: "t",
      query: "q",
      k: 3,
    });
  });

  it("throws MoonshotError with status on non-2xx", async () => {
    const c = new SearchClient(
      opts({ fetch: fakeFetch(503, { error: "down" }) }),
    );
    await expect(c.search("t", "q")).rejects.toMatchObject({
      name: "MoonshotError",
      status: 503,
    });
  });

  it("validates inputs", async () => {
    const c = new SearchClient(opts({ fetch: fakeFetch(200, {}) }));
    await expect(c.search("", "q")).rejects.toBeInstanceOf(MoonshotError);
    await expect(c.search("t", "")).rejects.toBeInstanceOf(MoonshotError);
    await expect(c.search("t", "q", 0)).rejects.toBeInstanceOf(MoonshotError);
  });
});

describe("MemoryReadClient", () => {
  it("recalls memories", async () => {
    const c = new MemoryReadClient(
      opts({
        fetch: fakeFetch(200, {
          memories: [
            {
              agent: "a",
              kind: "fact",
              text: "x",
              tags: ["t1"],
              timestamp_ms: 1700000000000,
            },
          ],
        }),
      }),
    );
    const recs = await c.recall("a", "q", 2);
    expect(recs).toEqual([
      {
        agent: "a",
        kind: "fact",
        text: "x",
        tags: ["t1"],
        timestampMs: 1700000000000,
      },
    ]);
  });

  it("returns empty list when memories field absent", async () => {
    const c = new MemoryReadClient(opts({ fetch: fakeFetch(200, {}) }));
    expect(await c.recall("a", "q")).toEqual([]);
  });
});

describe("MoonshotError surface", () => {
  it("rejects empty httpUrl", () => {
    expect(() => new SearchClient({ httpUrl: "" })).toThrow(MoonshotError);
  });
});
