import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_LEGACY_CLEANUP_KEY,
  cleanupLegacyBrowserModelCaches,
} from "@/background/legacy-model-cleanup";
import { LEGACY_BROWSER_MODEL_IDS } from "@/llm/legacy-models";

function installStorage(initial: Record<string, unknown> = {}) {
  const store = { ...initial };
  const storage = {
    get: vi.fn(async (keys: string | string[]) => {
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of wanted) {
        if (key in store) out[key] = store[key];
      }
      return out;
    }),
    set: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(store, values);
    }),
    remove: vi.fn(async (key: string) => {
      delete store[key];
    }),
  };
  (globalThis as { chrome?: typeof chrome }).chrome = {
    storage: { local: storage },
  } as unknown as typeof chrome;
  return { storage, store };
}

describe("cleanupLegacyBrowserModelCaches", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes old WebLLM cache entries and clears their downloaded flags", async () => {
    const { storage } = installStorage();
    const offscreen = {
      call: vi.fn(async () => ({ deleted: true as const })),
    };

    await cleanupLegacyBrowserModelCaches(offscreen);

    expect(offscreen.call).toHaveBeenCalledTimes(LEGACY_BROWSER_MODEL_IDS.length);
    expect(offscreen.call).toHaveBeenNthCalledWith(1, "offscreen/deleteModel", {
      modelId: "bookrag-qwen2b-sftv4-q4f16_1",
    });
    expect(offscreen.call).toHaveBeenNthCalledWith(2, "offscreen/deleteModel", {
      modelId: "bookrag-qwen4b-sftv4-q4f16_1",
    });
    expect(offscreen.call).toHaveBeenNthCalledWith(3, "offscreen/deleteModel", {
      modelId: "bookrag-qwen4b-ftv5-merged-q4f16_1",
    });

    expect(storage.remove).toHaveBeenCalledWith("bookrag.model.downloaded.bookrag-qwen2b-sftv4-q4f16_1");
    expect(storage.remove).toHaveBeenCalledWith("bookrag.model.downloaded.bookrag-qwen4b-sftv4-q4f16_1");
    expect(storage.remove).toHaveBeenCalledWith("bookrag.model.downloaded.bookrag-qwen4b-ftv5-merged-q4f16_1");
  });

  it("skips deletion after the migration marker is set", async () => {
    installStorage({ [CURRENT_LEGACY_CLEANUP_KEY]: true });
    const offscreen = {
      call: vi.fn(async () => ({ deleted: true as const })),
    };

    await cleanupLegacyBrowserModelCaches(offscreen);

    expect(offscreen.call).not.toHaveBeenCalled();
  });
});
