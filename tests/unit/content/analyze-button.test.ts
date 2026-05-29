import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installAnalyzeButton } from "@/content/analyze-button";
import type { QueueTaskSnapshot } from "@/messaging/contracts";
import type { ParsedChapter } from "@/parsers/types";

const parsed: ParsedChapter = {
  adapterId: "test",
  workTitle: "Work",
  workSiteUrl: "https://example.test/work",
  chapterTitle: "Chapter",
  chapterNumber: 1,
  chapterUrl: "https://example.test/work/1",
  text: "text",
  paragraphs: ["text"],
};

function snap(taskId: string, status: QueueTaskSnapshot["status"]): QueueTaskSnapshot {
  return {
    taskId,
    workId: "work1",
    chapterId: "chap1",
    chapterNumber: 1,
    status,
    enqueuedAt: 1,
  };
}

async function flushPromises(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function getButton(): HTMLButtonElement {
  const host = document.getElementById("bookrag-analyze-host");
  const btn = host?.shadowRoot?.querySelector("button");
  if (!(btn instanceof HTMLButtonElement)) throw new Error("button not found");
  return btn;
}

function getStatusText(): string {
  const host = document.getElementById("bookrag-analyze-host");
  return host?.shadowRoot?.querySelector(".status")?.textContent ?? "";
}

describe("installAnalyzeButton", () => {
  let queueResponses: QueueTaskSnapshot[][];

  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.innerHTML = "";
    queueResponses = [];

    const listeners = new Set<(message: unknown) => void>();
    const runtime = {
      lastError: undefined as chrome.runtime.LastError | undefined,
      sendMessage: (message: unknown, cb: (response: unknown) => void) => {
        const type = (message as { type?: string }).type;
        let response: unknown;
        if (type === "models/list") {
          response = {
            ok: true,
            data: [
              {
                id: "balanced",
                label: "Balanced",
                description: "",
                modelId: "bookrag-qwen4b-ftv6-merged-q4f16_1",
                approxSizeGb: 2.5,
                approxVramGb: 3.9,
                status: "ready",
                isActive: true,
              },
            ],
          };
        } else if (type === "queue/snapshot") {
          response = { ok: true, data: queueResponses.shift() ?? [] };
        } else if (type === "chapters/analyze") {
          response = { ok: true, data: { taskId: "task1" } };
        } else {
          response = { ok: false, code: "unknown", message: String(type) };
        }
        cb(response);
      },
      onMessage: {
        addListener: (listener: (message: unknown) => void) => {
          listeners.add(listener);
        },
        removeListener: (listener: (message: unknown) => void) => {
          listeners.delete(listener);
        },
      },
      getURL: (path: string) => `chrome-extension://test/${path}`,
    };
    Object.assign(globalThis.chrome.runtime, runtime);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.innerHTML = "";
  });

  it("polls queue/snapshot and unlocks after done even if broadcast is missed", async () => {
    queueResponses = [
      [], // pre-click busy check
      [snap("task1", "queued")], // immediate poll after enqueue
      [snap("task1", "done")], // interval poll
    ];
    const controller = installAnalyzeButton({ getParsed: () => parsed });
    const btn = getButton();

    btn.click();
    await flushPromises();
    expect(btn.disabled).toBe(true);
    expect(getStatusText()).toContain("Задача поставлена");

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(btn.disabled).toBe(false);
    expect(getStatusText()).toContain("Анализ заверш");

    controller.destroy();
  });

  it("polls busy state and returns to idle when another task finishes", async () => {
    queueResponses = [
      [snap("other", "running")], // pre-click busy check
      [snap("other", "running")], // immediate busy poll
      [], // interval poll: queue is idle
    ];
    const controller = installAnalyzeButton({ getParsed: () => parsed });
    const btn = getButton();

    btn.click();
    await flushPromises();
    expect(btn.disabled).toBe(true);
    expect(getStatusText()).toContain("Уже выполняется");

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(btn.disabled).toBe(false);
    expect(getStatusText()).toBe("");

    controller.destroy();
  });
});
