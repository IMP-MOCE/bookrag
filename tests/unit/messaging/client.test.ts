import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, MessagingError, subscribe } from "@/messaging/client";
import { makeEnvelope } from "@/messaging/contracts";

interface FakeRuntime {
  sendMessage: (msg: unknown, cb?: (resp: unknown) => void) => void;
  lastError?: { message: string } | undefined;
  onMessage: {
    addListener: (cb: (msg: unknown) => void) => void;
    removeListener: (cb: (msg: unknown) => void) => void;
  };
}

let listeners: Array<(msg: unknown) => void> = [];
let originalChrome: unknown;

function installChrome(runtime: Partial<FakeRuntime>): void {
  const merged: FakeRuntime = {
    sendMessage: runtime.sendMessage ?? (() => undefined),
    onMessage: runtime.onMessage ?? {
      addListener: (cb) => listeners.push(cb),
      removeListener: (cb) => {
        listeners = listeners.filter((l) => l !== cb);
      },
    },
    ...(runtime.lastError !== undefined ? { lastError: runtime.lastError } : {}),
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime: merged };
}

beforeEach(() => {
  originalChrome = (globalThis as unknown as { chrome: unknown }).chrome;
  listeners = [];
});
afterEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = originalChrome;
});

describe("messaging/client.call", () => {
  it("resolves with data on ok response", async () => {
    installChrome({
      sendMessage: (_msg, cb) => {
        cb?.({ ok: true, data: [{ id: "w1" }] });
      },
    });
    const result = await call("kb/listWorks", {});
    expect(result).toEqual([{ id: "w1" }]);
  });

  it("throws MessagingError with code on ok=false response", async () => {
    installChrome({
      sendMessage: (_msg, cb) => {
        cb?.({ ok: false, code: "task_not_found", message: "missing" });
      },
    });
    await expect(call("queue/cancel", { taskId: "x" })).rejects.toThrow(MessagingError);
    try {
      await call("queue/cancel", { taskId: "x" });
    } catch (err) {
      expect((err as MessagingError).code).toBe("task_not_found");
      expect((err as Error).message).toBe("missing");
    }
  });

  it("throws on undefined response (no listener)", async () => {
    installChrome({
      sendMessage: (_msg, cb) => {
        cb?.(undefined);
      },
    });
    await expect(call("kb/listWorks", {})).rejects.toThrow(/did not respond/);
  });

  it("times out if no response", async () => {
    installChrome({
      sendMessage: () => undefined, // никто не вызывает callback
    });
    await expect(call("kb/listWorks", {}, { timeoutMs: 30 })).rejects.toThrow(/timed out/);
  });
});

describe("messaging/client.subscribe", () => {
  it("delivers matching broadcast envelopes to handler", async () => {
    installChrome({});
    const received: unknown[] = [];
    const off = subscribe("broadcast/queue", (p) => received.push(p));
    const env = makeEnvelope("broadcast/queue", {
      taskId: "t1",
      workId: "",
      chapterId: "",
      chapterNumber: 0,
      status: "queued" as const,
      enqueuedAt: 0,
    });
    listeners.forEach((l) => l(env));
    expect(received).toHaveLength(1);
    off();
    listeners.forEach((l) => l(env));
    expect(received).toHaveLength(1); // отписка работает
  });

  it("ignores broadcasts of different types and non-envelope messages", () => {
    installChrome({});
    const received: unknown[] = [];
    subscribe("broadcast/queue", (p) => received.push(p));
    listeners.forEach((l) => l({ ok: true })); // не envelope
    listeners.forEach((l) =>
      l(makeEnvelope("broadcast/modelProgress", { profileId: "light" })),
    );
    expect(received).toHaveLength(0);
  });
});
