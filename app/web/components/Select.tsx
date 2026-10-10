/**
 * The site's select: a square field that opens a list of options, each with an optional hint line.
 * Keyboard: ↑/↓ move, Enter/Space choose, Esc/Tab close, Home/End jump. Follows the ARIA
 * combobox-with-listbox pattern so screen readers announce it like a native select.
 */
import { useEffect, useId, useRef, useState } from 'react';

export interface SelectOption { value: string; label: string; hint?: string }

export function Select({ value, onChange, options, className = '', 'aria-labelledby': labelledBy }: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  className?: string;
  'aria-labelledby'?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const selected = options.find((o) => o.value === value) ?? options[0];

  // Close when clicking anywhere else.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the highlighted option in view.
  useEffect(() => {
    if (open) document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, id]);

  const show = () => { setActive(Math.max(0, options.findIndex((o) => o.value === value))); setOpen(true); };
  const choose = (i: number) => { onChange(options[i].value); setOpen(false); button.current?.focus(); };

  function onKey(e: React.KeyboardEvent) {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show(); }
      return;
    }
    const last = options.length - 1;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(last, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(last); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); } // close the list, not an enclosing dialog
    else if (e.key === 'Tab') setOpen(false);
  }

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-labelledby={labelledBy}
        aria-activedescendant={open ? `${id}-opt-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
        className={`field flex items-center gap-3 text-left ${open ? 'field-open' : ''}`}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label}</span>
        <svg viewBox="0 0 12 12" aria-hidden className="size-3 shrink-0 text-label-3">
          <path d="M3.5 4.5 6 2 8.5 4.5M3.5 7.5 6 10l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-labelledby={labelledBy}
          className="menu absolute inset-x-0 top-full z-40 mt-1.5 max-h-80 overflow-y-auto"
        >
          {options.map((o, i) => {
            const isSelected = o.value === value;
            return (
              <li
                key={o.value}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
                className={`flex cursor-pointer items-start gap-3 rounded-md px-3 py-2 text-sm transition-colors ${i === active ? 'bg-fill-3' : ''}`}
              >
                <span className="min-w-0 flex-1">
                  <span className={`block ${isSelected ? 'font-medium text-label-1' : 'text-label-1'}`}>{o.label}</span>
                  {o.hint && <span className="mt-0.5 block text-xs leading-relaxed text-label-3">{o.hint}</span>}
                </span>
                <svg viewBox="0 0 12 12" aria-hidden className={`mt-1 size-3 shrink-0 text-brand-text ${isSelected ? '' : 'invisible'}`}>
                  <path d="M2.5 6.2 5 8.5 9.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
