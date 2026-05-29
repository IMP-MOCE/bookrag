// Content script: парсит главу и ставит кнопку анализа. Сам анализ не делает —
// только отвечает на запросы SW и предоставляет ParsedChapter.

import { isEnvelope, type Response, type ResponseOf } from "../messaging/contracts";
import { PageParser } from "../parsers/PageParser";
import { installAnalyzeButton } from "./analyze-button";

const parser = new PageParser();

const KEY_ANALYZE_BUTTON = "bookrag.analyzeButtonEnabled";

async function isFlagEnabled(key: string): Promise<boolean> {
  try {
    const v = await chrome.storage.local.get(key);
    // Дефолт — включено. Явный false выключает.
    return v[key] !== false;
  } catch {
    return true;
  }
}

const isAnalyzeButtonEnabled = (): Promise<boolean> => isFlagEnabled(KEY_ANALYZE_BUTTON);

async function bootstrap(): Promise<void> {
  const url = new URL(location.href);
  const parsed = parser.parse(document, url);
  if (!parsed) return; // страница — не глава, ничего не делаем.

  if (await isAnalyzeButtonEnabled()) {
    installAnalyzeButton({
      getParsed: () => parser.parse(document, new URL(location.href)),
    });
  }
}

// Реактивный endpoint для popup/SW: вернуть текущий ParsedChapter.
chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (resp: unknown) => void): boolean | undefined => {
    if (!isEnvelope(message)) return undefined;
    if (message.type !== "content/parse") return undefined;
    void (async () => {
      try {
        const url = new URL(location.href);
        const parsed = parser.parse(document, url);
        const data: ResponseOf<"content/parse"> = {
          parsed,
          adapterIds: parser.listAdapterIds(),
        };
        const resp: Response<typeof data> = { ok: true, data };
        sendResponse(resp);
      } catch (err) {
        const resp: Response<never> = {
          ok: false,
          code: "content_parse_failed",
          message: err instanceof Error ? err.message : String(err),
        };
        sendResponse(resp);
      }
    })();
    return true;
  },
);

void bootstrap().catch((err) => console.warn("[BookRAG] bootstrap failed", err));
