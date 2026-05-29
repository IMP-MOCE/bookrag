import { LEGACY_BROWSER_MODEL_IDS } from "../llm/legacy-models";
import { clearDownloadedFlag } from "../llm/storage";
import type { OffscreenClient } from "./offscreen-client";

export const CURRENT_LEGACY_CLEANUP_KEY = "bookrag.migrations.ftv6LegacyBrowserModelsDeleted";

type LegacyCleanupOffscreen = Pick<OffscreenClient, "call">;

export async function cleanupLegacyBrowserModelCaches(
  offscreen: LegacyCleanupOffscreen,
): Promise<void> {
  const state = await chrome.storage.local.get(CURRENT_LEGACY_CLEANUP_KEY);
  if (state[CURRENT_LEGACY_CLEANUP_KEY] === true) return;

  let deleteFailed = false;
  for (const modelId of LEGACY_BROWSER_MODEL_IDS) {
    try {
      await offscreen.call("offscreen/deleteModel", { modelId });
    } catch (err) {
      deleteFailed = true;
      console.warn(`[BookRAG] legacy model cleanup failed for ${modelId}`, err);
    }
    await clearDownloadedFlag(modelId);
  }

  if (!deleteFailed) {
    await chrome.storage.local.set({ [CURRENT_LEGACY_CLEANUP_KEY]: true });
  }
}
