// Типизированная обёртка над chrome.runtime.sendMessage. Используется со стороны UI/content
// script. Background и offscreen используют свой собственный диспатчер (см. background/router.ts
// и offscreen/index.ts).

import {
  isEnvelope,
  makeEnvelope,
  type BroadcastPayload,
  type BroadcastType,
  type Envelope,
  type MessageType,
  type RequestOf,
  type Response,
  type ResponseOf,
} from "./contracts";

export class MessagingError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "MessagingError";
  }
}

export interface CallOptions {
  // Сколько ждать ответа. Большие операции (загрузка модели, длинная глава) обрабатываются
  // через broadcast-канал, поэтому базовый таймаут можно держать умеренным.
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function getRuntime(): typeof chrome.runtime | null {
  if (typeof chrome === "undefined") return null;
  if (!chrome.runtime || typeof chrome.runtime.sendMessage !== "function") return null;
  return chrome.runtime;
}

export async function call<T extends MessageType>(
  type: T,
  payload: RequestOf<T>,
  opts: CallOptions = {},
): Promise<ResponseOf<T>> {
  const runtime = getRuntime();
  if (!runtime) {
    throw new MessagingError("no_runtime", "chrome.runtime is unavailable in this context");
  }

  const envelope = makeEnvelope(type, payload);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Гонка: ответ от sendMessage против таймаута. Используем низкоуровневый колбэк-вариант
  // sendMessage, потому что Promise-овая форма зависит от того, есть ли listener.
  const responsePromise = new Promise<Response<ResponseOf<T>>>((resolve, reject) => {
    try {
      runtime.sendMessage(envelope, (raw: unknown) => {
        const lastError = runtime.lastError;
        if (lastError) {
          reject(new MessagingError("runtime_error", lastError.message ?? "unknown runtime error"));
          return;
        }
        if (raw === undefined) {
          reject(new MessagingError("no_response", "background did not respond"));
          return;
        }
        resolve(raw as Response<ResponseOf<T>>);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new MessagingError("timeout", `Request "${type}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  let response: Response<ResponseOf<T>>;
  try {
    response = await Promise.race([responsePromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (!response.ok) {
    throw new MessagingError(response.code, response.message);
  }
  return response.data;
}

// Подписка на broadcast-сообщения от background. Возвращает функцию отписки.
export function subscribe<T extends BroadcastType>(
  type: T,
  handler: (payload: BroadcastPayload<T>) => void,
): () => void {
  const runtime = getRuntime();
  if (!runtime || !runtime.onMessage || typeof runtime.onMessage.addListener !== "function") {
    return () => undefined;
  }
  const listener = (message: unknown) => {
    if (!isEnvelope(message)) return;
    if (message.type !== type) return;
    handler((message as Envelope<T, BroadcastPayload<T>>).payload);
  };
  runtime.onMessage.addListener(listener);
  return () => runtime.onMessage.removeListener(listener);
}
