import { describe, expect, it } from "vitest";
import { CompanionBackend, CompanionError } from "@/llm/backends/CompanionBackend";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signalAborted?: boolean;
}

interface FakeFetchOpts {
  status?: number;
  body?: unknown;
  delayMs?: number;
  // если задан — будет брошено в момент вызова (имитация сетевой ошибки)
  throwError?: Error;
}

// Создаёт фейковый fetch, который возвращает каннед-ответ и записывает вход.
function makeFakeFetch(opts: FakeFetchOpts): {
  fetch: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers as Record<string, string>) ?? {};
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const rec: Recorded = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body,
    };
    calls.push(rec);

    if (opts.throwError) throw opts.throwError;
    if (opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          rec.signalAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    const status = opts.status ?? 200;
    return new Response(JSON.stringify(opts.body ?? {}), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

describe("CompanionBackend", () => {
  it("health() возвращает true только при 200 + ok:true", async () => {
    const { fetch: f, calls } = makeFakeFetch({ status: 200, body: { ok: true, modelReady: false } });
    const b = new CompanionBackend({ endpoint: "http://127.0.0.1:8731", fetch: f });
    expect(await b.health()).toBe(true);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8731/health");
    expect(calls[0]!.method).toBe("GET");
  });

  it("health() === false при ok:false", async () => {
    const { fetch: f } = makeFakeFetch({ status: 200, body: { ok: false } });
    const b = new CompanionBackend({ endpoint: "http://127.0.0.1:8731", fetch: f });
    expect(await b.health()).toBe(false);
  });

  it("health() === false при не-2xx", async () => {
    const { fetch: f } = makeFakeFetch({ status: 503, body: { ok: true } });
    const b = new CompanionBackend({ endpoint: "http://127.0.0.1:8731", fetch: f });
    expect(await b.health()).toBe(false);
  });

  it("health() === false при сетевой ошибке (без throws)", async () => {
    const { fetch: f } = makeFakeFetch({ throwError: new TypeError("connection refused") });
    const b = new CompanionBackend({ endpoint: "http://127.0.0.1:8731", fetch: f });
    await expect(b.health()).resolves.toBe(false);
  });

  it("health() прерывается при таймауте", async () => {
    const { fetch: f, calls } = makeFakeFetch({ delayMs: 2_000 });
    const b = new CompanionBackend({ endpoint: "http://127.0.0.1:8731", fetch: f });
    expect(await b.health()).toBe(false);
    expect(calls[0]!.signalAborted).toBe(true);
  });

  it("ensureModel шлёт POST /load с modelId и contextWindowSize", async () => {
    const { fetch: f, calls } = makeFakeFetch({ status: 200, body: { loaded: true } });
    const b = new CompanionBackend({ endpoint: "http://127.0.0.1:8731", fetch: f });
    await b.ensureModel("bookrag-4b", 4096);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8731/load");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.body).toEqual({ modelId: "bookrag-4b", contextWindowSize: 4096 });
  });

  it("ensureModel без contextWindowSize не передаёт поле", async () => {
    const { fetch: f, calls } = makeFakeFetch({ status: 200, body: {} });
    const b = new CompanionBackend({ endpoint: "http://127.0.0.1:8731", fetch: f });
    await b.ensureModel("bookrag-4b");
    expect(calls[0]!.body).toEqual({ modelId: "bookrag-4b" });
  });

  it("ensureModel кидает CompanionError при не-2xx", async () => {
    const { fetch: f } = makeFakeFetch({ status: 500, body: { error: "oom" } });
    const b = new CompanionBackend({ endpoint: "http://127.0.0.1:8731", fetch: f });
    await expect(b.ensureModel("m")).rejects.toBeInstanceOf(CompanionError);
  });

  it("generate проксирует messages+opts и парсит content", async () => {
    const { fetch: f, calls } = makeFakeFetch({ status: 200, body: { content: "RESULT" } });
    const b = new CompanionBackend({ endpoint: "http://127.0.0.1:8731", fetch: f });

    const schema = { type: "object" };
    const out = await b.generate(
      [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
      ],
      { jsonSchema: schema, temperature: 0.1, maxTokens: 2048 },
    );

    expect(out).toBe("RESULT");
    expect(calls[0]!.url).toBe("http://127.0.0.1:8731/generate");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
      ],
      jsonSchema: schema,
      temperature: 0.1,
      maxTokens: 2048,
      stream: false,
    });
  });

  it("generate без opts не кладёт лишних полей, но всегда stream:false", async () => {
    const { fetch: f, calls } = makeFakeFetch({ status: 200, body: { content: "X" } });
    const b = new CompanionBackend({ endpoint: "http://127.0.0.1:8731", fetch: f });
    await b.generate([{ role: "user", content: "hi" }]);
    expect(calls[0]!.body).toEqual({
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
  });

  it("generate бросает CompanionError при не-2xx", async () => {
    const { fetch: f } = makeFakeFetch({ status: 500, body: { error: "x" } });
    const b = new CompanionBackend({ endpoint: "http://127.0.0.1:8731", fetch: f });
    await expect(b.generate([{ role: "user", content: "q" }])).rejects.toBeInstanceOf(CompanionError);
  });

  it("generate бросает, если в ответе нет content", async () => {
    const { fetch: f } = makeFakeFetch({ status: 200, body: { foo: "bar" } });
    const b = new CompanionBackend({ endpoint: "http://127.0.0.1:8731", fetch: f });
    await expect(b.generate([{ role: "user", content: "q" }])).rejects.toBeInstanceOf(CompanionError);
  });

  it("release глотает ошибку (best-effort)", async () => {
    const { fetch: f, calls } = makeFakeFetch({ throwError: new TypeError("connection refused") });
    const b = new CompanionBackend({ endpoint: "http://127.0.0.1:8731", fetch: f });
    await expect(b.release()).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe("http://127.0.0.1:8731/unload");
    expect(calls[0]!.method).toBe("POST");
  });

  it("endpoint с хвостовым слэшем нормализуется", async () => {
    const { fetch: f, calls } = makeFakeFetch({ status: 200, body: { ok: true } });
    const b = new CompanionBackend({ endpoint: "http://127.0.0.1:8731/", fetch: f });
    await b.health();
    expect(calls[0]!.url).toBe("http://127.0.0.1:8731/health");
  });
});
