export interface ChunkOptions {
  // Целевой размер чанка в символах. Для русского текста ~3-4 символа на токен,
  // 7000 символов ≈ 1800-2500 токенов — всё ещё в комфортной зоне для Qwen3.5-4B
  // (контекст 32k), но даёт в 2× меньше LLM-вызовов на главу. Стало возможным
  // после two-pass split: Pass 1 user prompt больше не несёт KB-блок, поэтому
  // освободившийся бюджет токенов можно отдать на сам текст.
  maxChars: number;
  // Сколько последних абзацев предыдущего чанка повторить в начале следующего —
  // чтобы модель видела контекст границы.
  overlapParagraphs: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  // 7000 симв. ≈ 2000 токенов. Two-pass архитектура убрала KB-блок из Pass 1
  // prompt'а — это даёт +1500-2000 токенов «свободного» контекста. Удваиваем
  // chunk size: меньше round-trip'ов LLM, меньше chunk-boundary потерь, больше
  // окно для извлечения сущностей-в-связке (диалог + действие в одном чанке).
  // Trade-off на iGPU: prefill линеен по prompt-длине, поэтому время на чанк
  // примерно удваивается, но количество чанков сокращается тоже вдвое — total
  // latency примерно сохраняется, а recall растёт.
  maxChars: 7000,
  overlapParagraphs: 1,
};

// Делит массив абзацев на чанки. Каждый чанк — массив абзацев, склеиваемых через "\n\n".
// Один абзац длиннее maxChars не дробится — отдаётся как самостоятельный чанк.
export function chunkParagraphs(
  paragraphs: readonly string[],
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): string[][] {
  if (paragraphs.length === 0) return [];

  const chunks: string[][] = [];
  let current: string[] = [];
  let currentSize = 0;

  for (const para of paragraphs) {
    const paraSize = para.length;

    if (current.length > 0 && currentSize + paraSize > opts.maxChars) {
      chunks.push(current);
      const overlap = opts.overlapParagraphs > 0 ? current.slice(-opts.overlapParagraphs) : [];
      current = [...overlap];
      currentSize = current.reduce((s, p) => s + p.length, 0);
    }

    current.push(para);
    currentSize += paraSize;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function joinChunk(chunk: readonly string[]): string {
  return chunk.join("\n\n");
}
