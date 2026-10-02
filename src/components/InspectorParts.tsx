import { useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Shuffle } from "lucide-react";

/** Small layout pieces shared by the map inspector. */

export function InspectorSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return <section className="flex flex-col gap-1.5 border-b border-white/5 px-4 py-3">
    <div className="flex min-h-6 items-center justify-between gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
      {aside}
    </div>
    {children}
  </section>;
}

export function InspectorFold({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return <details className="group/fold" open={defaultOpen}>
    <summary className="flex cursor-pointer list-none items-center gap-1 py-1 text-[12px] text-slate-400 hover:text-slate-200 [&::-webkit-details-marker]:hidden">
      <ChevronRight size={13} className="transition-transform group-open/fold:rotate-90" />
      {title}
    </summary>
    <div className="mt-1 flex flex-col gap-1.5 border-l border-white/10 pl-3">{children}</div>
  </details>;
}

export function InspectorNote({ children }: { children: ReactNode }) {
  return <p className="text-[11px] leading-snug text-slate-500">{children}</p>;
}

export function InspectorToggle({ label, checked, onChange, disabled, title }: {
  label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; title?: string;
}) {
  return <label className={`flex items-center justify-between gap-2 py-0.5 text-[12px] text-slate-300 ${disabled ? "opacity-40" : "cursor-pointer"}`} title={title}>
    {label}
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="h-3.5 w-3.5 cursor-pointer" />
  </label>;
}

export function InspectorColor({ label, value, onChange, disabled }: {
  label: string; value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  return <label className={`flex items-center justify-between gap-2 py-0.5 text-[12px] text-slate-300 ${disabled ? "opacity-40" : ""}`}>
    {label}
    <span className="flex items-center gap-2">
      <span className="font-mono text-[11px] uppercase text-slate-500">{value}</span>
      <input type="color" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}
        className="h-5 w-8 cursor-pointer rounded border border-white/10 bg-transparent p-0" />
    </span>
  </label>;
}

export function InspectorSelect<T extends string | number>({ label, value, options, onChange, disabled }: {
  label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find(([option]) => option === value)?.[1] ?? String(value);
  return <div className={`flex items-center justify-between gap-2 py-0.5 text-[12px] text-slate-300 ${disabled ? "opacity-40" : ""}`}>
    <span className="shrink-0">{label}</span>
    <div className="relative min-w-0 max-w-[62%]" onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
      <button type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-1 rounded border border-white/10 bg-white/5 py-1 pl-2 pr-1 text-left text-[12px] text-slate-100 hover:bg-white/10">
        <span className="min-w-0 flex-1 truncate">{current}</span><ChevronDown size={13} className="shrink-0 text-slate-400" />
      </button>
      {open && <>
        <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
        <div role="listbox" aria-label={label} className="absolute right-0 top-full z-50 mt-1 min-w-full rounded-md border border-white/10 bg-[#2a2f38] py-1 shadow-xl">
          {options.map(([option, text]) => <button type="button" role="option" aria-selected={option === value} key={String(option)}
            onClick={() => { onChange(option); setOpen(false); }}
            className="flex w-full items-center gap-2 whitespace-nowrap px-2 py-1 text-left text-[12px] text-slate-200 hover:bg-white/10">
            <Check size={12} className={option === value ? "text-slate-100" : "invisible"} />{text}
          </button>)}
        </div>
      </>}
    </div>
  </div>;
}

export function InspectorSeed({ label = "Seed", value, onChange, disabled }: {
  label?: string; value: number; onChange: (value: number) => void; disabled?: boolean;
}) {
  return <div className={`flex items-center justify-between gap-2 py-0.5 text-[12px] text-slate-300 ${disabled ? "opacity-40" : ""}`}>
    {label}
    <span className="flex items-center gap-1">
      <input type="text" inputMode="numeric" aria-label={label} value={value} disabled={disabled}
        onChange={(event) => { const next = parseInt(event.target.value, 10); if (Number.isFinite(next)) onChange(Math.max(0, Math.min(2147483647, next))); }}
        className="w-24 rounded bg-transparent px-1 py-0.5 text-right text-[12px] tabular-nums text-slate-100 outline-none hover:bg-white/5 focus:bg-slate-950 focus:ring-1 focus:ring-sky-500" />
      <button type="button" aria-label={`Randomize ${label.toLowerCase()}`} title="Randomize" disabled={disabled}
        onClick={() => onChange(Math.floor(Math.random() * 2147483647))}
        className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-slate-100"><Shuffle size={12} /></button>
    </span>
  </div>;
}
