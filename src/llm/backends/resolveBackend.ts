// Точка выбора LLM-бэкенда. Вызывается при старте анализа главы.
//
// auto (дефолт): пробим /health локального компаньона коротким таймаутом.
// Жив → CompanionBackend; молчит / не жив → прозрачный фоллбэк на offscreen
// WebLLM. browser: пользователь явно отключил компаньон — сразу offscreen.
//
// Нет персистентного кеша выбора между вызовами: пользователь может
// стартовать/останавливать компаньон в произвольный момент, а пробник
// /health стоит сотни миллисекунд против ~30с анализа главы.

import type { OffscreenClient } from "../../background/offscreen-client";
import { CompanionBackend } from "./CompanionBackend";
import type { LlmBackend } from "./LlmBackend";
import { OffscreenBackend } from "./OffscreenBackend";
import { OpenAIEvalBackend } from "./OpenAIEvalBackend";
import { readBackendSettings, type BackendSettings } from "./settings";

export interface ResolveBackendDeps {
  offscreen: OffscreenClient;
  // Инъекция: чтение настроек и фабрики бэкендов. Нужна для тестов;
  // в проде дефолты подтягивают chrome.storage и реальные бэкенды.
  readSettings?: () => Promise<BackendSettings>;
  makeCompanion?: (endpoint: string) => LlmBackend;
  makeOpenAIEval?: (endpoint: string) => LlmBackend;
}

export async function resolveBackend(deps: ResolveBackendDeps): Promise<LlmBackend> {
  const settings = await (deps.readSettings ?? readBackendSettings)();
  if (settings.inferenceBackend === "browser") {
    return new OffscreenBackend(deps.offscreen);
  }
  if (settings.inferenceBackend === "openai-eval") {
    // Диагностический режим — никаких фоллбэков: если сервер не отвечает,
    // пусть упадёт с понятной ошибкой, а не молча уйдёт в offscreen и
    // замаскирует A/B-результат.
    return (deps.makeOpenAIEval ?? defaultOpenAIEvalFactory)(settings.openaiEvalEndpoint);
  }
  // auto: попробовать компаньон, иначе offscreen.
  const companion = (deps.makeCompanion ?? defaultCompanionFactory)(settings.companionEndpoint);
  if (await companion.health()) {
    return companion;
  }
  return new OffscreenBackend(deps.offscreen);
}

function defaultCompanionFactory(endpoint: string): LlmBackend {
  return new CompanionBackend({ endpoint });
}

function defaultOpenAIEvalFactory(endpoint: string): LlmBackend {
  return new OpenAIEvalBackend({ endpoint });
}
