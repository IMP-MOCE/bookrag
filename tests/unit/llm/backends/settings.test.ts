import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPANION_ENDPOINT_KEY,
  DEFAULT_COMPANION_ENDPOINT,
  DEFAULT_INFERENCE_BACKEND,
  DEFAULT_OPENAI_EVAL_ENDPOINT,
  INFERENCE_BACKEND_KEY,
  OPENAI_EVAL_ENDPOINT_KEY,
  readBackendSettings,
} from "@/llm/backends/settings";

// chrome.storage.local моделируется простым in-memory map; полей берётся
// массив ключей или объект — мы поддерживаем массив (как в проде).
function installFakeStorage(initial: Record<string, unknown>) {
  const store = { ...initial };
  const chromeFake = {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in store) out[k] = store[k];
          }
          return out;
        }),
      },
    },
  } as unknown as typeof chrome;
  (globalThis as { chrome?: typeof chrome }).chrome = chromeFake;
  return chromeFake;
}

describe("readBackendSettings", () => {
  beforeEach(() => {
    delete (globalThis as { chrome?: typeof chrome }).chrome;
  });

  it("дефолты, когда storage пуст", async () => {
    installFakeStorage({});
    const s = await readBackendSettings();
    expect(s.inferenceBackend).toBe(DEFAULT_INFERENCE_BACKEND);
    expect(s.companionEndpoint).toBe(DEFAULT_COMPANION_ENDPOINT);
    expect(s.openaiEvalEndpoint).toBe(DEFAULT_OPENAI_EVAL_ENDPOINT);
  });

  it("читает заданные значения", async () => {
    installFakeStorage({
      [INFERENCE_BACKEND_KEY]: "browser",
      [COMPANION_ENDPOINT_KEY]: "http://127.0.0.1:9999",
      [OPENAI_EVAL_ENDPOINT_KEY]: "http://127.0.0.1:8123",
    });
    const s = await readBackendSettings();
    expect(s.inferenceBackend).toBe("browser");
    expect(s.companionEndpoint).toBe("http://127.0.0.1:9999");
    expect(s.openaiEvalEndpoint).toBe("http://127.0.0.1:8123");
  });

  it("принимает openai-eval как валидное значение", async () => {
    installFakeStorage({ [INFERENCE_BACKEND_KEY]: "openai-eval" });
    const s = await readBackendSettings();
    expect(s.inferenceBackend).toBe("openai-eval");
  });

  it("игнорирует мусор и подставляет дефолты", async () => {
    installFakeStorage({
      [INFERENCE_BACKEND_KEY]: "garbage",
      [COMPANION_ENDPOINT_KEY]: "",
      [OPENAI_EVAL_ENDPOINT_KEY]: "",
    });
    const s = await readBackendSettings();
    expect(s.inferenceBackend).toBe(DEFAULT_INFERENCE_BACKEND);
    expect(s.companionEndpoint).toBe(DEFAULT_COMPANION_ENDPOINT);
    expect(s.openaiEvalEndpoint).toBe(DEFAULT_OPENAI_EVAL_ENDPOINT);
  });
});
