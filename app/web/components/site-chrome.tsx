/**
 * The parts of the site's frame that need neither the router nor an account: the language menu, the
 * GitHub link and DeepLethe's wordmark. They are kept apart from
 * SiteHeader, which pulls in sign-in and routing.
 */
import { useEffect, useRef, useState } from 'react';
import { L, LANGUAGES, useLang } from '@/lib/i18n';

/** The site's name as it is written wherever it stands for the site: the header, the sign-in dialog. No mark beside it. */
export function Logo({ className = '' }: { className?: string }) {
  return <span className={`font-logo leading-none font-bold tracking-[-0.02em] ${className}`}>FDE <span className="text-brand-text">Gym</span></span>;
}

/** Where the source lives; change here if the repository moves. */
export const GITHUB_URL = 'https://github.com/deeplethe/fde-gym';

const iconButton = 'grid size-8 place-items-center rounded-full text-label-2 transition-colors hover:bg-fill-3 hover:text-label-1';

/** Interface language menu: a globe button that lists every available language. */
export function LangToggle() {
  const { lang, setLang } = useLang();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const current = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0];
  return (
    <div ref={root} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}
        aria-label={L(lang, '界面语言', 'Language')} title={L(lang, '界面语言', 'Language')}
        className={`${iconButton} flex! w-auto items-center gap-1 px-2 text-xs font-medium ${open ? 'bg-fill-3 text-label-1' : ''}`}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="size-4" aria-hidden>
          <circle cx="8" cy="8" r="6.25" /><path d="M1.75 8h12.5M8 1.75c1.7 1.8 2.5 3.9 2.5 6.25S9.7 12.45 8 14.25M8 1.75C6.3 3.55 5.5 5.65 5.5 8s.8 4.45 2.5 6.25" />
        </svg>
        <span className="hidden sm:inline">{current.short}</span>
      </button>
      {open && (
        <div role="menu" className="menu absolute right-0 top-full z-50 mt-1.5 w-40">
          {LANGUAGES.map((l) => (
            <button key={l.code} type="button" role="menuitemradio" aria-checked={l.code === lang}
              onClick={() => { setLang(l.code); setOpen(false); }}
              className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm text-label-1 transition-colors hover:bg-fill-3">
              {l.name}
              {l.code === lang && <svg viewBox="0 0 12 12" aria-hidden className="size-3 text-brand-text"><path d="M2.5 6.2 5 8.5 9.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GitHubIcon({ className = 'size-[18px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function GitHubLink() {
  return <a href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="GitHub" title="GitHub" className={iconButton}><GitHubIcon /></a>;
}

export const DEEPLETHE_URL = 'https://deeplethe.com';

/** DeepLethe's wordmark, set as on deeplethe.com. */
export function DeepLetheMark({ className = '' }: { className?: string }) {
  return <span className={`font-deeplethe leading-none font-normal tracking-[0.1em] ${className}`}>DeepLethe</span>;
}

