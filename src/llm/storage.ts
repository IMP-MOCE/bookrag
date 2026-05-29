// Учёт скачанных профилей через chrome.storage.local. Реальное удаление весов
// делает offscreen-документ (см. endpoint "offscreen/deleteModel"), потому что
// service worker не может импортировать @mlc-ai/web-llm.

const KEY_PREFIX = "bookrag.model.downloaded.";

function key(modelId: string): string {
  return KEY_PREFIX + modelId;
}

export async function isModelDownloaded(modelId: string): Promise<boolean> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return false;
  const k = key(modelId);
  const result = await chrome.storage.local.get(k);
  return result[k] === true;
}

export async function markModelDownloaded(modelId: string): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  await chrome.storage.local.set({ [key(modelId)]: true });
}

export async function clearDownloadedFlag(modelId: string): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  await chrome.storage.local.remove(key(modelId));
}
