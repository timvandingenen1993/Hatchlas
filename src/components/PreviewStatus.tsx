import { useEffect, useState } from "react";
import type { MountainPreviewResponse } from "../rendering/mountainPreviewTypes";

export type PreviewStatusValue = Pick<
  Extract<MountainPreviewResponse, { type: "status" }>,
  "phase" | "step" | "stepIndex" | "stepCount"
>;

const PHASE_LABELS: Record<PreviewStatusValue["phase"], string> = {
  analysis: "Analyzing terrain",
  lighting: "Updating lighting",
  water: "Updating water",
  vegetation: "Updating vegetation",
  rendering: "Rendering map",
};

// Short renders finish before a timer is worth reading.
const ELAPSED_VISIBLE_AFTER_MS = 1000;

/**
 * Status-bar progress for the preview worker: a breathing phase label, the
 * current pipeline step, elapsed time, and a thin step progress bar along the
 * top edge of the (relatively positioned) parent.
 */
export function PreviewStatus({ status }: { status: PreviewStatusValue | null }) {
  const active = status !== null;
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!active) return;
    const started = performance.now();
    const interval = window.setInterval(
      () => setElapsedMs(performance.now() - started),
      100,
    );
    return () => {
      window.clearInterval(interval);
      setElapsedMs(0);
    };
  }, [active]);

  if (!status) {
    return (
      <span key="ready" className="preview-status-enter flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Ready
      </span>
    );
  }

  const { phase, step, stepIndex, stepCount } = status;
  const hasProgress = stepIndex !== undefined && stepCount !== undefined && stepCount > 0;
  // A step is reported when it starts, so count it as half done.
  const progress = hasProgress
    ? Math.min(1, Math.max(0, (stepIndex - 0.5) / stepCount))
    : 0;

  return (
    <>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden"
      >
        <span
          className={`block h-full bg-sky-400/80 transition-[width] duration-500 ease-out ${hasProgress ? "" : "preview-status-breathe"}`}
          style={{ width: hasProgress ? `${progress * 100}%` : "100%" }}
        />
      </span>
      <span key="busy" className="preview-status-enter flex min-w-0 items-center gap-1.5 text-sky-300">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" />
        <span className="preview-status-breathe whitespace-nowrap">
          {PHASE_LABELS[phase]}…
        </span>
        {step && (
          <span key={step} className="preview-status-enter truncate text-slate-400">
            · {step}
            {hasProgress && (
              <span className="ml-1 tabular-nums text-slate-500">
                {stepIndex}/{stepCount}
              </span>
            )}
          </span>
        )}
        {elapsedMs >= ELAPSED_VISIBLE_AFTER_MS && (
          <span className="tabular-nums text-slate-500">
            · {(elapsedMs / 1000).toFixed(1)}s
          </span>
        )}
      </span>
    </>
  );
}
