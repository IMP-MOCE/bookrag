import { describe, expect, it } from "vitest";
import { OpenAIEvalBackend, OpenAIEvalError } from "@/llm/backends/OpenAIEvalBackend";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signalAborted?: boolean;
}

interface QueuedResponse {
  status?: number;
  body?: unknown;
  delayMs?: number;
  throwError?: Error;
}

// Очередь ответов: первый GET /v1/models, затем POST /v1/chat/completions и т.д.
// Если очередь короче, чем вызовов, последний ответ повторяется (удобно для health).
function makeQueuedFetch(queue: QueuedResponse[]): {
  fetch: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let idx = 0;
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

    const r = queue[Math.min(idx, queue.length - 1)] ?? {};
    idx += 1;
    if (r.throwError) throw r.throwError;
    if (r.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, r.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          rec.signalAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

const MODELS_OK = { status: 200, body: { data: [{ id: "bookrag-qwen4b-ftv6-merged-q4f16_1" }] } };

describe("OpenAIEvalBackend", () => {
  it("health() === true при 200 на /v1/models", async () => {
    const { fetch: f, calls } = makeQueuedFetch([MODELS_OK]);
    const b = new OpenAIEvalBackend({ endpoint: "http://127.0.0.1:8000", fetch: f });
    expect(await b.health()).toBe(true);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8000/v1/models");
    expect(calls[0]!.method).toBe("GET");
  });

  it("вызывает fetch с globalThis, чтобы Chrome worker не падал с Illegal invocation", async () => {
    const calls: string[] = [];
    const strictFetch = (function (this: unknown, input: RequestInfo | URL) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify(MODELS_OK.body), {
          status: MODELS_OK.status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const b = new OpenAIEvalBackend({
      endpoint: "http://127.0.0.1:8000",
      fetch: strictFetch,
    });

    await expect(b.health()).resolves.toBe(true);
    expect(calls).toEqual(["http://127.0.0.1:8000/v1/models"]);
  });

  it("health() === false при сетевой ошибке", async () => {
    const { fetch: f } = makeQueuedFetch([{ throwError: new TypeError("ECONNREFUSED") }]);
    const b = new OpenAIEvalBackend({ endpoint: "http://127.0.0.1:8000", fetch: f });
    expect(await b.health()).toBe(false);
  });

  it("ensureModel принимает модель из /v1/models", async () => {
    const { fetch: f, calls } = makeQueuedFetch([MODELS_OK]);
    const b = new OpenAIEvalBackend({ endpoint: "http://127.0.0.1:8000", fetch: f });
    await b.ensureModel("bookrag-qwen4b-ftv6-merged-q4f16_1");
    expect(calls).toHaveLength(1);
  });

  it("ensureModel кеширует результат (повторный вызов = no-op)", async () => {
    const { fetch: f, calls } = makeQueuedFetch([MODELS_OK]);
    const b = new OpenAIEvalBackend({ endpoint: "http://127.0.0.1:8000", fetch: f });
    await b.ensureModel("bookrag-qwen4b-ftv6-merged-q4f16_1");
    await b.ensureModel("bookrag-qwen4b-ftv6-merged-q4f16_1");
    expect(calls).toHaveLength(1);
  });

  it("ensureModel кидает OpenAIEvalError, если модели нет на сервере", async () => {
    const { fetch: f } = makeQueuedFetch([
      { status: 200, body: { data: [{ id: "some-other-model" }] } },
    ]);
    const b = new OpenAIEvalBackend({ endpoint: "http://127.0.0.1:8000", fetch: f });
    await expect(b.ensureModel("bookrag-qwen4b-ftv6-merged-q4f16_1")).rejects.toBeInstanceOf(
      OpenAIEvalError,
    );
  });

  it("generate отдаёт content из OpenAI-ответа", async () => {
    const { fetch: f, calls } = makeQueuedFetch([
      MODELS_OK,
      {
        status: 200,
        body: {
          choices: [{ index: 0, message: { role: "assistant", content: "RESULT" }, finish_reason: "stop" }],
        },
      },
    ]);
    const b = new OpenAIEvalBackend({ endpoint: "http://127.0.0.1:8000", fetch: f });
    await b.ensureModel("bookrag-qwen4b-ftv6-merged-q4f16_1");
    const out = await b.generate(
      [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
      ],
      { temperature: 0.1, maxTokens: 1024, jsonSchema: { type: "object" } },
    );
    expect(out).toBe("RESULT");
    expect(calls[1]!.url).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(calls[1]!.method).toBe("POST");
    const sent = calls[1]!.body as Record<string, unknown>;
    expect(sent.model).toBe("bookrag-qwen4b-ftv6-merged-q4f16_1");
    expect(sent.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
    ]);
    expect(sent.temperature).toBe(0.1);
    expect(sent.max_tokens).toBe(1024);
    expect(sent.stream).toBe(false);
    // Намеренно НЕ передаём response_format/jsonSchema — поведение симметрично
    // MLC-пути в проде, который xgrammar тоже не применяет.
    expect(sent.response_format).toBeUndefined();
    expect(sent.jsonSchema).toBeUndefined();
  });

  it("generate бросает OpenAIEvalError при ошибке сервера", async () => {
    const { fetch: f } = makeQueuedFetch([
      MODELS_OK,
      { status: 500, body: { error: { message: "boom" } } },
    ]);
    const b = new OpenAIEvalBackend({ endpoint: "http://127.0.0.1:8000", fetch: f });
    await b.ensureModel("bookrag-qwen4b-ftv6-merged-q4f16_1");
    await expect(b.generate([{ role: "user", content: "q" }])).rejects.toBeInstanceOf(
      OpenAIEvalError,
    );
  });

  it("generate без ensureModel — ошибка", async () => {
    const { fetch: f } = makeQueuedFetch([MODELS_OK]);
    const b = new OpenAIEvalBackend({ endpoint: "http://127.0.0.1:8000", fetch: f });
    await expect(b.generate([{ role: "user", content: "q" }])).rejects.toBeInstanceOf(
      OpenAIEvalError,
    );
  });

  it("release сбрасывает verifiedModelId — следующий generate потребует ensureModel", async () => {
    const { fetch: f } = makeQueuedFetch([MODELS_OK]);
    const b = new OpenAIEvalBackend({ endpoint: "http://127.0.0.1:8000", fetch: f });
    await b.ensureModel("bookrag-qwen4b-ftv6-merged-q4f16_1");
    await b.release();
    await expect(b.generate([{ role: "user", content: "q" }])).rejects.toBeInstanceOf(
      OpenAIEvalError,
    );
  });

  it("override modelId побеждает параметр ensureModel", async () => {
    const { fetch: f, calls } = makeQueuedFetch([
      { status: 200, body: { data: [{ id: "override-id" }] } },
      {
        status: 200,
        body: { choices: [{ message: { content: "ok" } }] },
      },
    ]);
    const b = new OpenAIEvalBackend({
      endpoint: "http://127.0.0.1:8000",
      fetch: f,
      modelId: "override-id",
    });
    await b.ensureModel("bookrag-qwen4b-ftv6-merged-q4f16_1");
    await b.generate([{ role: "user", content: "q" }]);
    expect((calls[1]!.body as Record<string, unknown>).model).toBe("override-id");
  });

  it("endpoint с хвостовым слэшем нормализуется", async () => {
    const { fetch: f, calls } = makeQueuedFetch([MODELS_OK]);
    const b = new OpenAIEvalBackend({ endpoint: "http://127.0.0.1:8000/", fetch: f });
    await b.health();
    expect(calls[0]!.url).toBe("http://127.0.0.1:8000/v1/models");
  });
});
