import { describe, expect, it } from "vitest";
import type { OffscreenClient } from "@/background/offscreen-client";
import type { LlmBackend } from "@/llm/backends/LlmBackend";
import { CompanionBackend } from "@/llm/backends/CompanionBackend";
import { OffscreenBackend } from "@/llm/backends/OffscreenBackend";
import { resolveBackend } from "@/llm/backends/resolveBackend";
import {
  DEFAULT_COMPANION_ENDPOINT,
  DEFAULT_OPENAI_EVAL_ENDPOINT,
  type BackendSettings,
} from "@/llm/backends/settings";

const fakeOffscreen = {} as OffscreenClient;

function fakeCompanion(healthy: boolean): { backend: LlmBackend; pings: number } {
  const obj = { pings: 0 } as { pings: number; backend?: LlmBackend };
  const backend: LlmBackend = {
    async health() {
      obj.pings++;
      return healthy;
    },
    async ensureModel() {},
    async generate() {
      return "";
    },
    async release() {},
  };
  obj.backend = backend;
  return obj as { backend: LlmBackend; pings: number };
}

function settings(over: Partial<BackendSettings>): () => Promise<BackendSettings> {
  return async () => ({
    inferenceBackend: "auto",
    companionEndpoint: DEFAULT_COMPANION_ENDPOINT,
    openaiEvalEndpoint: DEFAULT_OPENAI_EVAL_ENDPOINT,
    ...over,
  });
}

describe("resolveBackend", () => {
  it("inferenceBackend='browser' → всегда OffscreenBackend, /health не зовётся", async () => {
    const comp = fakeCompanion(true);
    const out = await resolveBackend({
      offscreen: fakeOffscreen,
      readSettings: settings({ inferenceBackend: "browser" }),
      makeCompanion: () => comp.backend,
    });
    expect(out).toBeInstanceOf(OffscreenBackend);
    expect(comp.pings).toBe(0);
  });

  it("auto + companion жив → CompanionBackend", async () => {
    const comp = fakeCompanion(true);
    const out = await resolveBackend({
      offscreen: fakeOffscreen,
      readSettings: settings({ inferenceBackend: "auto" }),
      makeCompanion: () => comp.backend,
    });
    expect(out).toBe(comp.backend);
    expect(comp.pings).toBe(1);
  });

  it("auto + companion молчит → OffscreenBackend", async () => {
    const comp = fakeCompanion(false);
    const out = await resolveBackend({
      offscreen: fakeOffscreen,
      readSettings: settings({ inferenceBackend: "auto" }),
      makeCompanion: () => comp.backend,
    });
    expect(out).toBeInstanceOf(OffscreenBackend);
    expect(comp.pings).toBe(1);
  });

  it("endpoint из настроек прокидывается в фабрику компаньона", async () => {
    let seen = "";
    await resolveBackend({
      offscreen: fakeOffscreen,
      readSettings: settings({ companionEndpoint: "http://127.0.0.1:9999" }),
      makeCompanion: (ep) => {
        seen = ep;
        return new CompanionBackend({ endpoint: ep, fetch: async () => new Response("{}", { status: 500 }) });
      },
    });
    expect(seen).toBe("http://127.0.0.1:9999");
  });

  it("inferenceBackend='openai-eval' → OpenAIEvalBackend, без фоллбэка и без пинга компаньона", async () => {
    const comp = fakeCompanion(true);
    const evalFake = fakeCompanion(true).backend;
    let evalEpSeen = "";
    const out = await resolveBackend({
      offscreen: fakeOffscreen,
      readSettings: settings({
        inferenceBackend: "openai-eval",
        openaiEvalEndpoint: "http://127.0.0.1:8000",
      }),
      makeCompanion: () => comp.backend,
      makeOpenAIEval: (ep) => {
        evalEpSeen = ep;
        return evalFake;
      },
    });
    expect(out).toBe(evalFake);
    expect(comp.pings).toBe(0);
    expect(evalEpSeen).toBe("http://127.0.0.1:8000");
  });
});
