// Offscreen-документ: единственное место, где живёт WebGPU + WebLLM. MV3 service worker
// не имеет доступа к WebGPU (нет document/Window), поэтому мы держим LocalLLMService здесь
// и общаемся с background через chrome.runtime.sendMessage.

import { deleteModelAllInfoInCache } from "@mlc-ai/web-llm";
import { LocalLLMService } from "../llm/LocalLLMService";
import { diagnoseDevice } from "../llm/webgpu";
import {
  ERROR_CODES,
  isEnvelope,
  makeEnvelope,
  type Envelope,
  type OffscreenMessageType,
  type OffscreenRequestOf,
  type OffscreenResponseOf,
  type Response,
} from "../messaging/contracts";

const llm = new LocalLLMService();

type OffscreenHandler<T extends OffscreenMessageType> = (
  payload: OffscreenRequestOf<T>,
) => Promise<OffscreenResponseOf<T>>;

const handlers: { [K in OffscreenMessageType]: OffscreenHandler<K> } = {
  "offscreen/ping": async () => ({ pong: true }),

  "offscreen/diagnose": async () => {
    return diagnoseDevice();
  },

  "offscreen/loadModel": async ({ modelId, contextWindowSize }) => {
    const onProgress = (report: import("@mlc-ai/web-llm").InitProgressReport) => {
      // Прогресс уезжает «сырым» сообщением offscreen → SW; SW знает текущий profileId
      // и переоформит его в broadcast/modelProgress для подписчиков.
      const env = makeEnvelope("offscreen/loadProgress", {
        modelId,
        text: report.text,
        progress: report.progress,
        timeElapsed: report.timeElapsed,
      } satisfies import("../messaging/contracts").OffscreenSignals["offscreen/loadProgress"]);
      try {
        void chrome.runtime.sendMessage(env).catch(() => undefined);
      } catch {
        /* noop */
      }
    };
    const loadOpts: Parameters<typeof llm.load>[2] = {};
    if (typeof contextWindowSize === "number") loadOpts.contextWindowSize = contextWindowSize;
    await llm.load(modelId, onProgress, loadOpts);
    return { loaded: true, modelId };
  },

  "offscreen/unload": async () => {
    await llm.unload();
    return { unloaded: true };
  },

  "offscreen/deleteModel": async ({ modelId }) => {
    await deleteModelAllInfoInCache(modelId);
    return { deleted: true };
  },

  "offscreen/generate": async (payload) => {
    if (!llm.getCurrentModelId()) {
      throw new Error("No model loaded in offscreen");
    }
    const opts: Parameters<typeof llm.generate>[1] = {};
    if (payload.jsonSchema) opts.jsonSchema = payload.jsonSchema;
    if (typeof payload.temperature === "number") opts.temperature = payload.temperature;
    if (typeof payload.maxTokens === "number") opts.maxTokens = payload.maxTokens;
    const content = await llm.generate(payload.messages, opts);
    return { content };
  },
};

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (resp: unknown) => void): boolean | undefined => {
    if (!isEnvelope(message)) return undefined;
    if (!message.type.startsWith("offscreen/")) return undefined;
    const handler = handlers[message.type as OffscreenMessageType];
    if (!handler) {
      const resp: Response<never> = {
        ok: false,
        code: ERROR_CODES.UNKNOWN_TYPE,
        message: `Unknown offscreen message: ${message.type}`,
      };
      sendResponse(resp);
      return undefined;
    }
    void (async () => {
      try {
        const data = await handler(
          (message as Envelope<OffscreenMessageType, unknown>).payload as never,
        );
        const resp: Response<unknown> = { ok: true, data };
        sendResponse(resp);
      } catch (err) {
        const resp: Response<never> = {
          ok: false,
          code: ERROR_CODES.HANDLER_THREW,
          message: err instanceof Error ? err.message : String(err),
        };
        sendResponse(resp);
      }
    })();
    return true;
  },
);

// Сигнал готовности — SW дождётся его перед отправкой первого запроса.
try {
  void chrome.runtime
    .sendMessage(makeEnvelope("offscreen/ready", {}))
    .catch(() => undefined);
} catch {
  /* noop */
}
