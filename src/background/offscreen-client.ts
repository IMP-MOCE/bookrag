// Управляет жизненным циклом offscreen-документа и предоставляет типизированный
// вызов offscreen-эндпоинтов. WebGPU/WebLLM не работают в service worker, поэтому
// все запросы к LLM идут через этот клиент.

import {
  ERROR_CODES,
  isEnvelope,
  makeEnvelope,
  type Envelope,
  type OffscreenMessageType,
  type OffscreenRequestOf,
  type OffscreenResponseOf,
  type OffscreenSignalType,
  type Response,
} from "../messaging/contracts";

const OFFSCREEN_URL = "src/offscreen/index.html";
const READY_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

type ChromeOffscreenApi = {
  createDocument: (opts: {
    url: string;
    reasons: string[];
    justification: string;
  }) => Promise<void>;
  hasDocument?: () => Promise<boolean>;
  closeDocument?: () => Promise<void>;
};

function getOffscreenApi(): ChromeOffscreenApi | null {
  if (typeof chrome === "undefined") return null;
  const api = (chrome as unknown as { offscreen?: ChromeOffscreenApi }).offscreen;
  return api && typeof api.createDocument === "function" ? api : null;
}

export class OffscreenClient {
  private creating: Promise<void> | null = null;
  private readonly readyWaiters: Array<() => void> = [];
  private isReady = false;

  constructor(
    private readonly url: string = OFFSCREEN_URL,
    private readonly signalListener: (
      type: OffscreenSignalType,
      payload: unknown,
    ) => void = () => undefined,
  ) {
    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage?.addListener) {
      chrome.runtime.onMessage.addListener((message: unknown) => {
        if (!isEnvelope(message)) return undefined;
        if (message.type === "offscreen/ready") {
          this.markReady();
          return undefined;
        }
        if (message.type === "offscreen/loadProgress") {
          this.signalListener("offscreen/loadProgress", message.payload);
          return undefined;
        }
        return undefined;
      });
    }
  }

  async ensureDocument(): Promise<void> {
    const api = getOffscreenApi();
    if (!api) throw new Error("chrome.offscreen API is unavailable");
    if (this.creating) return this.creating;

    if (api.hasDocument && (await api.hasDocument())) {
      this.markReady();
      return;
    }

    this.creating = (async () => {
      try {
        await api.createDocument({
          url: this.url,
          reasons: ["WORKERS"],
          justification: "Run WebGPU-backed local LLM (WebLLM) for chapter analysis",
        });
        await this.waitReady(READY_TIMEOUT_MS);
      } finally {
        this.creating = null;
      }
    })();
    return this.creating;
  }

  async close(): Promise<void> {
    const api = getOffscreenApi();
    if (!api?.closeDocument) return;
    if (api.hasDocument && !(await api.hasDocument())) return;
    await api.closeDocument();
    this.isReady = false;
  }

  async call<T extends OffscreenMessageType>(
    type: T,
    payload: OffscreenRequestOf<T>,
    timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<OffscreenResponseOf<T>> {
    await this.ensureDocument();
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      throw new Error("chrome.runtime is unavailable");
    }
    const env: Envelope<T, OffscreenRequestOf<T>> = makeEnvelope(type, payload);

    const responsePromise = new Promise<Response<OffscreenResponseOf<T>>>((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(env, (raw: unknown) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message ?? "runtime error"));
            return;
          }
          if (raw === undefined) {
            reject(new Error(`Offscreen did not respond to ${type}`));
            return;
          }
          resolve(raw as Response<OffscreenResponseOf<T>>);
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          Object.assign(new Error(`Offscreen call ${type} timed out after ${timeoutMs}ms`), {
            code: ERROR_CODES.OFFSCREEN_TIMEOUT,
          }),
        );
      }, timeoutMs);
    });

    let response: Response<OffscreenResponseOf<T>>;
    try {
      response = await Promise.race([responsePromise, timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!response.ok) {
      throw Object.assign(new Error(response.message), { code: response.code });
    }
    return response.data;
  }

  private markReady(): void {
    if (this.isReady) return;
    this.isReady = true;
    while (this.readyWaiters.length > 0) {
      const w = this.readyWaiters.shift();
      try {
        w?.();
      } catch {
        /* noop */
      }
    }
  }

  private waitReady(timeoutMs: number): Promise<void> {
    if (this.isReady) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.readyWaiters.indexOf(onReady);
        if (idx >= 0) this.readyWaiters.splice(idx, 1);
        reject(new Error("Offscreen document did not signal ready in time"));
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.readyWaiters.push(onReady);
    });
  }
}
