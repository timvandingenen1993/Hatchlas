/**
 * Slider + number input pair with optional logarithmic scaling; commits typed values on blur/enter.
 * The slider range is only the drag range: typed values may go beyond it, within `manualLimits`.
 */
import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

export function sliderFraction(value: number, min: number, max: number, logarithmic = false, power = 1): number {
  const clamped = Math.max(min, Math.min(max, value));
  return logarithmic && min > 0
    ? Math.log(clamped / min) / Math.log(max / min)
    : ((clamped - min) / (max - min)) ** (1 / power);
}

export function sliderValue(fraction: number, min: number, max: number, logarithmic = false, power = 1): number {
  const t = Math.max(0, Math.min(1, fraction));
  return logarithmic && min > 0 ? min * (max / min) ** t : min + (max - min) * t ** power;
}

/**
 * Limits for typed values. Fractions shown as percentages stay within 0–100%, other unsigned
 * sliders accept any non-negative value and signed sliders are unbounded. Controls where zero
 * is invalid pass explicit `limits`.
 */
export function manualLimits(min: number, max: number, unit = ""): [number, number] {
  if (unit === "%" && min >= 0 && max <= 1) return [0, 1];
  return min < 0 ? [-Infinity, Infinity] : [0, Infinity];
}

export function committedNumber(text: string, current: number, min: number, max: number): number {
  const parsed = Number(text.replace(",", "."));
  return text.trim() && Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : current;
}

function decimalsFor(step: number): number {
  const text = String(step);
  return text.includes(".") ? text.split(".")[1].length : 0;
}

interface NumericControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  /** Called when a drag, key press or typed edit is finished. */
  onCommit?: () => void;
  defaultValue?: number;
  /** "%" displays fractions as percentages; other units are shown as-is. */
  unit?: string;
  logarithmic?: boolean;
  power?: number;
  disabled?: boolean;
  title?: string;
  /** Hard [min, max] for typed values; defaults to `manualLimits`. */
  limits?: readonly [number, number];
}

export function NumericControl({ label, value, min, max, step, onChange, onCommit,
  defaultValue, unit = "", logarithmic = false, power = 1, disabled = false, title, limits }: NumericControlProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelBlur = useRef(false);
  useEffect(() => setDraft(null), [value]);
  const displayScale = unit === "%" ? 100 : 1;
  // Slider values are already stepped; extra digits only appear for typed values, which keep their precision.
  const shown = String(Number((value * displayScale).toFixed(6)));
  const changed = defaultValue !== undefined && Math.abs(defaultValue - value) > 1e-9;
  const [hardMin, hardMax] = limits ?? manualLimits(min, max, unit);
  const outsideSlider = value < min - 1e-9 || value > max + 1e-9;
  const commit = () => {
    if (cancelBlur.current) { cancelBlur.current = false; setDraft(null); return; }
    if (draft !== null) {
      onChange(committedNumber(draft, value * displayScale, hardMin * displayScale, hardMax * displayScale) / displayScale);
      onCommit?.();
    }
    setDraft(null);
  };
  return <div className={`group py-0.5 ${disabled ? "opacity-40" : ""}`} title={title}>
    <div className="flex items-center gap-1">
      <span className="min-w-0 flex-1 truncate text-[12px] text-slate-300">{label}</span>
      <input aria-label={`${label} value`} type="text" inputMode="decimal" value={draft ?? shown} disabled={disabled}
        title={outsideSlider ? `Typed value outside the slider range (${min * displayScale}–${max * displayScale}${unit})` : undefined}
        onFocus={(event) => { setDraft(shown); event.currentTarget.select(); }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit} onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") { cancelBlur.current = true; event.currentTarget.blur(); }
        }}
        className={`w-14 rounded bg-transparent px-1 py-0.5 text-right text-[12px] tabular-nums ${outsideSlider ? "text-amber-300" : "text-slate-100"} outline-none hover:bg-white/5 focus:bg-slate-950 focus:ring-1 focus:ring-sky-500`} />
      <span className="w-7 truncate text-[11px] text-slate-400">{unit}</span>
      <button type="button" aria-label={`Reset ${label}`} title={defaultValue === undefined ? undefined : `Reset to ${defaultValue * displayScale}${unit}`}
        disabled={disabled || !changed} onClick={() => { onChange(defaultValue!); onCommit?.(); }}
        className={`rounded p-0.5 text-slate-500 hover:text-sky-300 ${changed ? "" : "invisible"}`}>
        <RotateCcw size={11} />
      </button>
    </div>
    <input aria-label={label} type="range" min={0} max={1000} step={1}
      value={Math.round(sliderFraction(value, min, max, logarithmic, power) * 1000)}
      disabled={disabled} onChange={(event) => {
        const raw = sliderValue(Number(event.target.value) / 1000, min, max, logarithmic, power);
        const stepped = Number((Math.round(raw / step) * step).toFixed(decimalsFor(step)));
        onChange(Math.max(min, Math.min(max, stepped)));
      }} onPointerUp={onCommit} onKeyUp={onCommit}
      className="inspector-range" />
  </div>;
}
