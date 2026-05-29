// Маршрутизатор сообщений service worker'а. Знает только про MessageType → handler;
// не зависит ни от chrome (для тестов через dispatch()), ни от конкретных сервисов
// (всё внедряется при регистрации).

import {
  ERROR_CODES,
  isEnvelope,
  makeEnvelope,
  type BroadcastPayload,
  type BroadcastType,
  type Envelope,
  type MessageType,
  type RequestOf,
  type Response,
  type ResponseOf,
} from "../messaging/contracts";

export interface HandlerContext {
  // Передаётся, когда сообщение пришло через chrome.runtime.onMessage от
  // конкретного отправителя (popup/options/content script). При прямом dispatch()
  // в тестах его обычно нет.
  sender?: chrome.runtime.MessageSender;
}

export type Handler<T extends MessageType> = (
  payload: RequestOf<T>,
  ctx: HandlerContext,
) => Promise<ResponseOf<T>> | ResponseOf<T>;

interface RuntimeLike {
  onMessage: {
    addListener: (
      cb: (
        message: unknown,
        sender: unknown,
        sendResponse: (resp: unknown) => void,
      ) => boolean | undefined,
    ) => void;
    removeListener: (cb: unknown) => void;
  };
  sendMessage?: (msg: unknown) => void;
}

export class MessageRouter {
  private readonly handlers = new Map<MessageType, Handler<MessageType>>();

  on<T extends MessageType>(type: T, handler: Handler<T>): this {
    this.handlers.set(type, handler as unknown as Handler<MessageType>);
    return this;
  }

  has(type: string): boolean {
    return this.handlers.has(type as MessageType);
  }

  async dispatch(envelope: Envelope, ctx: HandlerContext = {}): Promise<Response<unknown>> {
    const handler = this.handlers.get(envelope.type as MessageType);
    if (!handler) {
      return {
        ok: false,
        code: ERROR_CODES.UNKNOWN_TYPE,
        message: `Unknown message type: ${envelope.type}`,
      };
    }
    try {
      const data = await handler(envelope.payload as RequestOf<MessageType>, ctx);
      return { ok: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof RouterError ? err.code : ERROR_CODES.HANDLER_THREW;
      return { ok: false, code, message };
    }
  }

  // Подключает chrome.runtime.onMessage. Возвращает функцию отписки.
  attach(runtime?: RuntimeLike): () => void {
    const r = runtime ?? (typeof chrome !== "undefined" ? (chrome.runtime as unknown as RuntimeLike) : undefined);
    if (!r) {
      throw new Error("MessageRouter.attach: chrome.runtime is unavailable");
    }
    const listener = (
      message: unknown,
      sender: unknown,
      sendResponse: (resp: unknown) => void,
    ): boolean | undefined => {
      if (!isEnvelope(message)) return undefined;
      // Сообщения, которые роутер не знает (например, offscreen-канал), пропускаем.
      if (!this.handlers.has(message.type as MessageType)) return undefined;
      const ctx: HandlerContext = sender
        ? { sender: sender as chrome.runtime.MessageSender }
        : {};
      this.dispatch(message, ctx).then(
        (resp) => sendResponse(resp),
        (err) => {
          const reason: Response<never> = {
            ok: false,
            code: ERROR_CODES.HANDLER_THREW,
            message: err instanceof Error ? err.message : String(err),
          };
          sendResponse(reason);
        },
      );
      return true; // keep the channel open for async sendResponse
    };
    r.onMessage.addListener(listener);
    return () => r.onMessage.removeListener(listener);
  }
}

export class RouterError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RouterError";
  }
}

// Утилита для рассылки broadcast-сообщений всем UI-страницам и tabs.
// chrome.runtime.sendMessage без destination доставляет всем расширенческим контекстам.
export function broadcast<T extends BroadcastType>(
  type: T,
  payload: BroadcastPayload<T>,
): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  const env = makeEnvelope(type, payload);
  try {
    // Promise-вариант возвращает rejected promise, если listener не отвечает —
    // нам это не интересно, broadcast по своей сути fire-and-forget.
    void chrome.runtime.sendMessage(env).catch(() => undefined);
  } catch {
    // Контекст может быть уничтожен — игнорируем.
  }
}
