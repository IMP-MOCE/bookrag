// Минимальные интерфейсы WebGPU, чтобы не тащить @webgpu/types ради двух полей.
interface MinimalGPUAdapterInfo {
  readonly device?: string;
  readonly description?: string;
  readonly vendor?: string;
  readonly architecture?: string;
}

interface MinimalGPUAdapter {
  readonly limits?: { readonly maxBufferSize?: number };
  readonly info?: MinimalGPUAdapterInfo;
}

interface MinimalGPU {
  requestAdapter(options?: { powerPreference?: "low-power" | "high-performance" }): Promise<MinimalGPUAdapter | null>;
}

function fmtAdapter(a: MinimalGPUAdapter | null): string {
  if (!a) return "null";
  const i = a.info ?? {};
  const buf = a.limits?.maxBufferSize
    ? `${Math.round(a.limits.maxBufferSize / (1024 * 1024))}MB`
    : "?";
  return `${i.vendor ?? "?"}/${i.architecture ?? "?"} ${i.device || i.description || "?"} maxBuf=${buf}`;
}

// Сравнивает адаптер по разным powerPreference. На ноутбуках с гибридной графикой
// default (его берёт WebLLM внутри CreateMLCEngine) часто = встроенная GPU, а
// high-performance = дискретная. Если они различаются — вот почему ~2-3 ток/с.
export async function logAdapterReport(tag: string): Promise<void> {
  const gpu = (navigator as unknown as { gpu?: MinimalGPU }).gpu;
  if (!gpu) {
    console.warn(`[BookRAG GPU] ${tag}: navigator.gpu отсутствует — WebGPU недоступен`);
    return;
  }
  try {
    const [def, hi, lo] = await Promise.all([
      gpu.requestAdapter(),
      gpu.requestAdapter({ powerPreference: "high-performance" }),
      gpu.requestAdapter({ powerPreference: "low-power" }),
    ]);
    console.info(
      `[BookRAG GPU] ${tag}\n` +
        `  default (его берёт WebLLM): ${fmtAdapter(def)}\n` +
        `  high-performance (дискретная): ${fmtAdapter(hi)}\n` +
        `  low-power (встроенная):       ${fmtAdapter(lo)}`,
    );
    const dn = def?.info?.device || def?.info?.description || "";
    const hn = hi?.info?.device || hi?.info?.description || "";
    if (dn && hn && dn !== hn) {
      console.warn(
        "[BookRAG GPU] ВНИМАНИЕ: default-адаптер ≠ high-performance. " +
          "WebLLM, скорее всего, считает на медленной встроенной GPU. " +
          "В Windows: Параметры → Дисплей → Графика → Chrome → «Высокая производительность»; " +
          "в Chrome включите аппаратное ускорение (chrome://settings/system).",
      );
    }
  } catch (err) {
    console.warn(`[BookRAG GPU] ${tag}: requestAdapter упал:`, err);
  }
}

export interface DeviceDiagnostics {
  webgpuAvailable: boolean;
  webgpuAdapterName?: string;
  webgpuVendor?: string;
  maxBufferSizeMb?: number;
  deviceMemoryGb?: number;
  hardwareConcurrency: number;
  userAgent: string;
}

export async function diagnoseDevice(): Promise<DeviceDiagnostics> {
  const out: DeviceDiagnostics = {
    webgpuAvailable: false,
    hardwareConcurrency: typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
  };

  const memoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof memoryGb === "number") out.deviceMemoryGb = memoryGb;

  const gpu = (navigator as unknown as { gpu?: MinimalGPU }).gpu;
  if (!gpu) return out;

  try {
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return out;
    out.webgpuAvailable = true;
    if (adapter.limits?.maxBufferSize) {
      out.maxBufferSizeMb = Math.round(adapter.limits.maxBufferSize / (1024 * 1024));
    }
    const info = adapter.info;
    if (info) {
      if (info.device) out.webgpuAdapterName = info.device;
      else if (info.description) out.webgpuAdapterName = info.description;
      if (info.vendor) out.webgpuVendor = info.vendor;
    }
  } catch (err) {
    console.warn("[BookRAG] WebGPU diagnostics failed:", err);
  }

  return out;
}
