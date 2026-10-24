import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";

export interface PartLayerOption {
  value: string;
  part: string;
  layer?: string;
}

interface Props {
  options: readonly PartLayerOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  searchPlaceholder?: string;
}

const optionLabel = (option: PartLayerOption) => option.layer ? `${option.part} / ${option.layer}` : option.part;

export function PartLayerPicker({ options, value, onChange, label = "Choose a part layer",
  placeholder = "Borrow a layer from...", searchPlaceholder = "Search parts or layers..." }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const listId = `${id}-options`;
  const selected = options.find((option) => option.value === value);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = options.filter((option) => {
    const text = `${option.part} ${option.layer ?? ""}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (open) rootRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, active, query]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const choose = (option: PartLayerOption) => {
    onChange(option.value);
    close();
  };

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button ref={buttonRef} type="button" aria-label={label} aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? `${id}-picker` : undefined}
        className="flex w-full items-center gap-1 rounded bg-slate-800 px-2 py-1 text-left hover:bg-slate-700"
        onClick={() => {
          setOpen(!open);
          setQuery("");
          setActive(0);
        }}>
        <span className="min-w-0 flex-1 truncate" title={selected ? optionLabel(selected) : undefined}>
          {selected ? optionLabel(selected) : placeholder}
        </span>
        <ChevronDown size={12} className="shrink-0" />
      </button>
      {open && (
        <div id={`${id}-picker`} role="dialog" aria-label={label}
          className="absolute right-0 top-full z-50 mt-1 w-full rounded border border-slate-700 bg-slate-900 p-2 shadow-xl"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}>
          <div className="mb-2 flex items-center gap-1 rounded bg-slate-950 px-2">
            <Search size={12} className="shrink-0 text-slate-400" />
            <input autoFocus role="combobox" aria-label={searchPlaceholder} aria-expanded={true}
              aria-autocomplete="list" aria-controls={listId}
              aria-activedescendant={matches[active] ? `${id}-option-${active}` : undefined}
              className="min-w-0 flex-1 bg-transparent py-1.5 outline-none" placeholder={searchPlaceholder}
              value={query} onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }} onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  setActive((index) => matches.length ? (index + direction + matches.length) % matches.length : 0);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  if (matches[active]) choose(matches[active]);
                }
              }} />
          </div>
          <div id={listId} role="listbox" aria-label={label} className="max-h-64 overflow-y-auto">
            {matches.map((option, index) => (
              <div key={option.value}>
                {option.layer && (index === 0 || matches[index - 1].part !== option.part) && (
                  <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold text-slate-500">{option.part}</div>
                )}
                <button id={`${id}-option-${index}`} type="button" role="option" aria-selected={option.value === value}
                  aria-label={optionLabel(option)}
                  data-active={index === active} tabIndex={-1}
                  className={`block w-full truncate rounded px-2 py-1 text-left ${index === active ? "bg-sky-900/60 text-sky-100" : "hover:bg-slate-800"}`}
                  onMouseEnter={() => setActive(index)} onClick={() => choose(option)}>{option.layer ?? option.part}</button>
              </div>
            ))}
            {matches.length === 0 && <p className="px-2 py-3 text-slate-500">No matching parts or layers.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
