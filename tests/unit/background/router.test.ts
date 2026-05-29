import { describe, expect, it } from "vitest";
import { MessageRouter, RouterError } from "@/background/router";
import { makeEnvelope, ERROR_CODES } from "@/messaging/contracts";

describe("MessageRouter", () => {
  it("dispatches known type and returns ok response", async () => {
    const r = new MessageRouter();
    r.on("kb/listWorks", async () => []);
    const env = makeEnvelope("kb/listWorks", {});
    const resp = await r.dispatch(env);
    expect(resp).toEqual({ ok: true, data: [] });
  });

  it("returns unknown_type for unregistered handler", async () => {
    const r = new MessageRouter();
    const env = makeEnvelope("kb/listWorks", {});
    const resp = await r.dispatch(env);
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.code).toBe(ERROR_CODES.UNKNOWN_TYPE);
  });

  it("converts handler exception into handler_threw response", async () => {
    const r = new MessageRouter();
    r.on("kb/listWorks", async () => {
      throw new Error("boom");
    });
    const env = makeEnvelope("kb/listWorks", {});
    const resp = await r.dispatch(env);
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe(ERROR_CODES.HANDLER_THREW);
      expect(resp.message).toBe("boom");
    }
  });

  it("preserves RouterError code in response", async () => {
    const r = new MessageRouter();
    r.on("kb/listWorks", async () => {
      throw new RouterError("custom_code", "nope");
    });
    const env = makeEnvelope("kb/listWorks", {});
    const resp = await r.dispatch(env);
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("custom_code");
      expect(resp.message).toBe("nope");
    }
  });

  it("passes payload to handler", async () => {
    const r = new MessageRouter();
    let received: unknown = null;
    r.on("kb/listChapters", async (p) => {
      received = p;
      return [];
    });
    await r.dispatch(makeEnvelope("kb/listChapters", { workId: "w1" }));
    expect(received).toEqual({ workId: "w1" });
  });

  it("attaches to runtime listener and routes via sendResponse", async () => {
    const listeners: Array<
      (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | undefined
    > = [];
    const fakeRuntime = {
      onMessage: {
        addListener: (cb: (typeof listeners)[number]) => listeners.push(cb),
        removeListener: () => undefined,
      },
    };
    const r = new MessageRouter();
    r.on("kb/listWorks", async () => [
      { id: "w", title: "T", siteUrl: "https://t.test", createdAt: Date.now() },
    ]);
    r.attach(fakeRuntime);

    const captured: unknown[] = [];
    const env = makeEnvelope("kb/listWorks", {});
    const keepOpen = listeners[0]!(env, null, (resp) => captured.push(resp));
    expect(keepOpen).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(captured[0]).toMatchObject({ ok: true });
  });

  it("ignores non-envelope messages", async () => {
    const listeners: Array<
      (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | undefined
    > = [];
    const fakeRuntime = {
      onMessage: {
        addListener: (cb: (typeof listeners)[number]) => listeners.push(cb),
        removeListener: () => undefined,
      },
    };
    const r = new MessageRouter();
    r.on("kb/listWorks", async () => []);
    r.attach(fakeRuntime);

    const result = listeners[0]!({ random: "garbage" }, null, () => undefined);
    expect(result).toBeUndefined();
  });

  it("ignores envelopes for types it doesn't handle (lets other listeners respond)", async () => {
    const listeners: Array<
      (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | undefined
    > = [];
    const fakeRuntime = {
      onMessage: {
        addListener: (cb: (typeof listeners)[number]) => listeners.push(cb),
        removeListener: () => undefined,
      },
    };
    const r = new MessageRouter();
    // Не регистрируем "kb/listWorks", чтобы offscreen-канал, например, мог ответить сам.
    r.attach(fakeRuntime);
    const env = makeEnvelope("kb/listWorks", {});
    const result = listeners[0]!(env, null, () => undefined);
    expect(result).toBeUndefined();
  });
});
