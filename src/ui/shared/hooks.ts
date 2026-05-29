// Тонкая обёртка над chrome.tabs.sendMessage для UI-страниц. Возвращает
// ParsedChapter из активной вкладки, не обращаясь напрямую к content script.

import {
  isEnvelope,
  makeEnvelope,
  type Response,
  type ResponseOf,
} from "@/messaging/contracts";
import type { ParsedChapter } from "@/parsers/types";

// Получает ParsedChapter из активной вкладки через chrome.tabs.sendMessage.
// Возвращает null, если вкладка не из домена с парсером, или если content script ещё не готов.
export async function parseActiveTab(): Promise<ParsedChapter | null> {
  if (typeof chrome === "undefined" || !chrome.tabs) return null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  const env = makeEnvelope("content/parse", {});
  return new Promise<ParsedChapter | null>((resolve) => {
    try {
      chrome.tabs.sendMessage(tab.id!, env, (raw: unknown) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        if (!isEnvelope(raw) && raw && typeof raw === "object" && "ok" in raw) {
          const r = raw as Response<ResponseOf<"content/parse">>;
          resolve(r.ok ? r.data.parsed : null);
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}
