import { describe, expect, it } from "vitest";
import type { OffscreenClient } from "@/background/offscreen-client";
import { OffscreenBackend } from "@/llm/backends/OffscreenBackend";

interface CallRecord {
  type: string;
  payload: unknown;
  timeoutMs?: number;
}

// Минимальный фейк OffscreenClient: пишет вызовы и отдаёт каннеды по type.
function makeFakeOffscreen(responses: Record<string, unknown>) {
  const calls: CallRecord[] = [];
  const offscreen = {
    async call(type: string, payload: unknown, timeoutMs?: number) {
      calls.push({ type, payload, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      if (!(type in responses)) throw new Error(`no canned response for ${type}`);
      return responses[type];
    },
  } as unknown as OffscreenClient;
  return { offscreen, calls };
}

describe("OffscreenBackend", () => {
  it("generate проксирует offscreen/generate с тем же payload и таймаутом 30мин", async () => {
    const { offscreen, calls } = makeFakeOffscreen({
      "offscreen/generate": { content: "RESULT" },
    });
    const backend = new OffscreenBackend(offscreen);

    const schema = { type: "object" };
    const out = await backend.generate(
      [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
      ],
      { jsonSchema: schema, temperature: 0.1, maxTokens: 2048 },
    );

    expect(out).toBe("RESULT");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type).toBe("offscreen/generate");
    expect(calls[0]!.timeoutMs).toBe(30 * 60_000);
    expect(calls[0]!.payload).toEqual({
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
      ],
      jsonSchema: schema,
      temperature: 0.1,
      maxTokens: 2048,
    });
  });

  it("generate без opts не кладёт лишних полей", async () => {
    const { offscreen, calls } = makeFakeOffscreen({
      "offscreen/generate": { content: "X" },
    });
    const backend = new OffscreenBackend(offscreen);

    await backend.generate([{ role: "user", content: "hi" }]);

    expect(calls[0]!.payload).toEqual({ messages: [{ role: "user", content: "hi" }] });
  });

  it("ensureModel шлёт offscreen/loadModel с modelId и contextWindowSize", async () => {
    const { offscreen, calls } = makeFakeOffscreen({
      "offscreen/loadModel": { loaded: true, modelId: "M" },
    });
    const backend = new OffscreenBackend(offscreen);

    await backend.ensureModel("M", 6144);

    expect(calls[0]!.type).toBe("offscreen/loadModel");
    expect(calls[0]!.timeoutMs).toBe(30 * 60_000);
    expect(calls[0]!.payload).toEqual({ modelId: "M", contextWindowSize: 6144 });
  });

  it("ensureModel без contextWindowSize не передаёт поле", async () => {
    const { offscreen, calls } = makeFakeOffscreen({
      "offscreen/loadModel": { loaded: true, modelId: "M" },
    });
    const backend = new OffscreenBackend(offscreen);

    await backend.ensureModel("M");

    expect(calls[0]!.payload).toEqual({ modelId: "M" });
  });

  it("health() === true (offscreen — всегда доступный фоллбэк)", async () => {
    const { offscreen } = makeFakeOffscreen({});
    expect(await new OffscreenBackend(offscreen).health()).toBe(true);
  });

  it("release() зовёт offscreen/unload и глотает ошибку", async () => {
    const { offscreen, calls } = makeFakeOffscreen({}); // no canned → call бросит
    const backend = new OffscreenBackend(offscreen);

    await expect(backend.release()).resolves.toBeUndefined();
    expect(calls[0]!.type).toBe("offscreen/unload");
  });
});
