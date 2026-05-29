// Service worker entry point. Поднимает KB, OffscreenClient, AnalysisQueue, MessageRouter,
// регистрирует обработчики и keep-alive на время активной задачи.

import { KnowledgeBase } from "../kb/KnowledgeBase";
import {
  PROFILES,
  resolveModel,
  type ProfileId,
} from "../llm/profiles";
import { broadcast, MessageRouter } from "./router";
import { AnalysisQueue, type QueueProcessor } from "./analysis-queue";
import { attachKeepAliveListener, startKeepAlive, stopKeepAlive } from "./keep-alive";
import { OffscreenClient } from "./offscreen-client";
import { makeQueueProcessor, registerHandlers } from "./handlers";

// ВАЖНО: SW переинициализируется при каждом пробуждении. Все долгоживущие сущности
// должны быть либо stateless, либо хранить состояние в IndexedDB / chrome.storage.

attachKeepAliveListener();

const offscreen = new OffscreenClient(undefined, (type, payload) => {
  if (type !== "offscreen/loadProgress") return;
  const p = payload as { modelId: string; text?: string; progress?: number; timeElapsed?: number };
  // Развернём modelId → profileId, чтобы UI видел осмысленное название профиля.
  const profileId = findProfileIdByModelId(p.modelId);
  if (!profileId) return;
  const out: { profileId: ProfileId; text?: string; progress?: number; timeElapsed?: number } = {
    profileId,
  };
  if (p.text !== undefined) out.text = p.text;
  if (p.progress !== undefined) out.progress = p.progress;
  if (p.timeElapsed !== undefined) out.timeElapsed = p.timeElapsed;
  broadcast("broadcast/modelProgress", out);
});

void (async () => {
  const kb = await KnowledgeBase.open();
  const processor: QueueProcessor = makeQueueProcessor({ kb, offscreen });

  const queue = new AnalysisQueue({
    processor,
    onUpdate: (snapshot) => {
      broadcast("broadcast/queue", snapshot);
      // Пока есть активная работа — держим SW живым.
      if (snapshot.status === "queued" || snapshot.status === "running") {
        startKeepAlive();
      }
    },
    onIdle: () => {
      stopKeepAlive();
      broadcast("broadcast/queueAll", queue.snapshot());
    },
  });

  const router = new MessageRouter();
  registerHandlers({ router, kb, offscreen, queue });
  router.attach();

  console.info("[BookRAG] SW initialized");
})().catch((err) => {
  console.error("[BookRAG] SW init failed", err);
});

function findProfileIdByModelId(modelId: string): ProfileId | null {
  for (const profile of PROFILES) {
    const resolved = resolveModel(profile);
    if (resolved.modelId === modelId) return profile.id;
  }
  return null;
}

// Открыть боковую панель по клику на иконку расширения (если SidePanel API доступен).
if (typeof chrome !== "undefined" && chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err: unknown) => console.warn("[BookRAG] sidePanel.setPanelBehavior failed", err));
}
