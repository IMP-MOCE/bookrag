import { describe, expect, it, vi } from "vitest";
import { AnalysisQueue, type ProcessorContext } from "@/background/analysis-queue";
import type { ParsedChapter } from "@/parsers/types";

function makeChapter(n = 1): ParsedChapter {
  return {
    adapterId: "test",
    workTitle: "T",
    workSiteUrl: "https://t.test",
    chapterTitle: `Глава ${n}`,
    chapterNumber: n,
    chapterUrl: `https://t.test/${n}`,
    text: "x",
    paragraphs: ["x"],
  };
}

describe("AnalysisQueue", () => {
  it("runs queued task to done and emits status updates", async () => {
    const updates: string[] = [];
    const q = new AnalysisQueue({
      processor: async () => undefined,
      onUpdate: (s) => updates.push(s.status),
    });
    const snap = q.enqueue(makeChapter());
    expect(snap.status).toBe("queued");
    // Подождём микротасков, пока pump прогонит задачу.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(updates).toContain("running");
    expect(updates[updates.length - 1]).toBe("done");
    const final = q.snapshot()[0]!;
    expect(final.status).toBe("done");
    expect(final.startedAt).toBeDefined();
    expect(final.finishedAt).toBeDefined();
  });

  it("cancels queued task before run", async () => {
    let called = 0;
    const q = new AnalysisQueue({
      processor: async () => {
        called++;
      },
    });
    const a = q.enqueue(makeChapter(1));
    const b = q.enqueue(makeChapter(2));
    const cancelled = q.cancel(b.taskId);
    expect(cancelled).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const snaps = q.snapshot();
    const aSnap = snaps.find((s) => s.taskId === a.taskId)!;
    const bSnap = snaps.find((s) => s.taskId === b.taskId)!;
    expect(aSnap.status).toBe("done");
    expect(bSnap.status).toBe("cancelled");
    expect(called).toBe(1); // обработана только первая задача
  });

  it("propagates abort signal to running processor", async () => {
    let observed = false;
    const q = new AnalysisQueue({
      processor: (ctx: ProcessorContext) =>
        new Promise<void>((resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            observed = true;
            reject(new Error("aborted"));
          });
        }),
    });
    const a = q.enqueue(makeChapter());
    await new Promise((r) => setTimeout(r, 0));
    q.cancel(a.taskId);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(observed).toBe(true);
    expect(q.snapshot()[0]!.status).toBe("cancelled");
  });

  it("captures error from processor", async () => {
    const q = new AnalysisQueue({
      processor: async () => {
        throw new Error("boom");
      },
    });
    q.enqueue(makeChapter());
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const final = q.snapshot()[0]!;
    expect(final.status).toBe("error");
    expect(final.error).toBe("boom");
  });

  it("processes tasks sequentially, not in parallel", async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const q = new AnalysisQueue({
      processor: async (ctx) => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(`start ${ctx.task.parsed.chapterNumber}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end ${ctx.task.parsed.chapterNumber}`);
        active--;
      },
    });
    q.enqueue(makeChapter(1));
    q.enqueue(makeChapter(2));
    q.enqueue(makeChapter(3));
    await new Promise((r) => setTimeout(r, 50));
    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "start 1",
      "end 1",
      "start 2",
      "end 2",
      "start 3",
      "end 3",
    ]);
  });

  it("emits progress updates from processor", async () => {
    const stages: string[] = [];
    const q = new AnalysisQueue({
      processor: async (ctx) => {
        ctx.reportProgress({ stage: "context" });
        ctx.reportProgress({ stage: "chunk", chunkIndex: 0, totalChunks: 2 });
        ctx.reportProgress({ stage: "apply" });
      },
      onUpdate: (s) => {
        if (s.progress) stages.push(s.progress.stage);
      },
    });
    q.enqueue(makeChapter());
    await new Promise((r) => setTimeout(r, 5));
    expect(stages).toEqual(expect.arrayContaining(["context", "chunk", "apply", "done"]));
  });

  it("calls onIdle when queue drains", async () => {
    const onIdle = vi.fn();
    const q = new AnalysisQueue({
      processor: async () => undefined,
      onIdle,
    });
    q.enqueue(makeChapter(1));
    q.enqueue(makeChapter(2));
    await new Promise((r) => setTimeout(r, 5));
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("trims completed tasks beyond retain limit", async () => {
    const q = new AnalysisQueue({
      processor: async () => undefined,
      retainCompleted: 2,
    });
    for (let i = 0; i < 5; i++) q.enqueue(makeChapter(i));
    await new Promise((r) => setTimeout(r, 5));
    expect(q.snapshot()).toHaveLength(2);
  });
});
