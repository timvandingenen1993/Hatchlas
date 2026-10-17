/**
 * Sizes the export's tile-helper memory from the machine's RAM.
 *
 * Browsers only expose `navigator.deviceMemory`: total (never free) RAM in GB,
 * rounded to a power of two. Chromium rounds to the nearest power, so a 32 GB
 * machine reports 32; older Chrome versions cap the value at 8, so 8 may mean
 * "8 or more". Firefox and Safari do not expose it at all.
 */

const GIB = 1024 * 1024 * 1024;

/** The fixed budget used before it scaled with RAM; still the floor at 8+ GB. */
export const DEFAULT_EXPORT_HELPER_MEMORY_BYTES = 6 * GIB;
/**
 * Share of total RAM the helpers may fill; the rest is the export's global
 * data, the browser, the OS and other apps. The reading is total, not free,
 * RAM: 40% on a 32 GB machine with ~20 GB in use elsewhere ran the export
 * into swap and allocation failures, and 25% still did once tiles got
 * smaller and more of them ran at once, so stay at a fifth.
 */
const RAM_FRACTION = 0.2;
const MIN_BUDGET_BYTES = 1.5 * GIB;
const MAX_BUDGET_BYTES = 24 * GIB;

export interface ExportMemoryBudget {
  bytes: number;
  /** Where the budget came from, for the profile log. */
  source: "override" | "device memory" | "default";
  deviceMemoryGb?: number;
}

/**
 * The memory budget for camera tile helpers. An explicit override (GB) wins.
 * Without a reading the old fixed budget applies. A reading of 8 or more
 * never lowers the budget below that, since 8 can mean "at least 8".
 */
export function getExportHelperMemoryBudget(
  deviceMemoryGb: number | undefined,
  overrideGb?: number,
): ExportMemoryBudget {
  if (overrideGb !== undefined && Number.isFinite(overrideGb) && overrideGb > 0) {
    return { bytes: overrideGb * GIB, source: "override", deviceMemoryGb };
  }
  if (deviceMemoryGb === undefined || !Number.isFinite(deviceMemoryGb) || deviceMemoryGb <= 0) {
    return { bytes: DEFAULT_EXPORT_HELPER_MEMORY_BYTES, source: "default" };
  }
  const scaled = deviceMemoryGb * GIB * RAM_FRACTION;
  const floor = deviceMemoryGb >= 8 ? DEFAULT_EXPORT_HELPER_MEMORY_BYTES : MIN_BUDGET_BYTES;
  return {
    bytes: Math.min(MAX_BUDGET_BYTES, Math.max(floor, scaled)),
    source: "device memory",
    deviceMemoryGb,
  };
}

/** `navigator.deviceMemory` where the browser exposes it (also in workers). */
export function readDeviceMemoryGb(): number | undefined {
  if (typeof navigator === "undefined") return undefined;
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof value === "number" ? value : undefined;
}
