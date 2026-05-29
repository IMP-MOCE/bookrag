import { describe, expect, it } from "vitest";
import { CUSTOM_APP_CONFIG } from "@/llm/LocalLLMService";
import { getProfileById, isProfileId, PROFILES } from "@/llm/profiles";

describe("llm/profiles", () => {
  it("accepts only selectable profile ids", () => {
    expect(isProfileId("light")).toBe(true);
    expect(isProfileId("balanced")).toBe(true);
    expect(isProfileId("extended")).toBe(false);
    expect(isProfileId("Qwen3.5-9B-q4f16_1-MLC")).toBe(false);
    expect(isProfileId(null)).toBe(false);
  });

  it("keeps the manager limited to light and balanced profiles", () => {
    expect(PROFILES.map((profile) => profile.id)).toEqual(["light", "balanced"]);
    expect(getProfileById("light").fallbackModelId).toBe("bookrag-qwen2b-ftv5-merged-q4f16_1");
    expect(getProfileById("balanced").fallbackModelId).toBe("bookrag-qwen4b-ftv6-merged-q4f16_1");
  });

  it("points WebLLM at the current MLC repositories on Hugging Face", () => {
    expect(CUSTOM_APP_CONFIG.model_list).toEqual([
      {
        model:
          "https://huggingface.co/IMP-MOCE/bookrag-qwen2b-ftv5-merged-q4f16_1-MLC/resolve/main",
        model_id: "bookrag-qwen2b-ftv5-merged-q4f16_1",
        model_lib:
          "https://huggingface.co/IMP-MOCE/bookrag-qwen2b-ftv5-merged-q4f16_1-MLC/resolve/main/bookrag-qwen2b-ftv5-merged-q4f16_1-webgpu.wasm",
      },
      {
        model:
          "https://huggingface.co/IMP-MOCE/bookrag-qwen4b-ftv6-merged-q4f16_1-MLC/resolve/main",
        model_id: "bookrag-qwen4b-ftv6-merged-q4f16_1",
        model_lib:
          "https://huggingface.co/IMP-MOCE/bookrag-qwen4b-ftv6-merged-q4f16_1-MLC/resolve/main/bookrag-qwen4b-ftv6-merged-q4f16_1-webgpu.wasm",
      },
    ]);
  });
});
