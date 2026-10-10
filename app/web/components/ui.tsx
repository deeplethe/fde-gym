/**
 * Shared building blocks in the liquid-glass manner (see styles.css): frosted panes on ambient
 * light, capsule buttons, pill tags, coloured difficulty labels, and tab strips.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';
import { L, type Lang } from '@/lib/i18n';

export const container = 'mx-auto w-full max-w-[1200px] px-4 sm:px-6';

const buttonSize = {
  sm: 'h-8 gap-1.5 px-3.5 text-[13px]',
  md: 'h-9 gap-2 px-4.5 text-sm',
  lg: 'h-11 gap-2 px-6 text-sm',
};
const buttonTone = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  outline: 'btn-secondary',
};
type ButtonProps = { size?: keyof typeof buttonSize; tone?: keyof typeof buttonTone; className?: string; children: ReactNode };
const buttonClass = (size: keyof typeof buttonSize, tone: keyof typeof buttonTone, extra: string) =>
  `btn inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 ${buttonSize[size]} ${buttonTone[tone]} ${extra}`;

export function Button({ size = 'md', tone = 'primary', className = '', children, ...rest }: ButtonProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...rest} className={buttonClass(size, tone, className)}>{children}</button>;
}

export function ButtonLink({ to, size = 'md', tone = 'primary', className = '', children }: ButtonProps & { to: string }) {
  return <Link to={to} className={buttonClass(size, tone, className)}>{children}</Link>;
}

/** A pane of glass. `padded` adds the standard inner spacing. */
export function Card({ children, className = '', padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={`card ${padded ? 'p-5' : ''} ${className}`}>{children}</div>;
}

/** Small tag. */
export function Pill({ children, tone = 'plain', className = '' }: { children: ReactNode; tone?: 'plain' | 'brand' | 'ok' | 'warn' | 'bad'; className?: string }) {
  const tones = { plain: 'chip text-label-2', brand: 'bg-brand-soft text-brand-text', ok: 'bg-ok/10 text-ok', warn: 'bg-warn/15 text-warn-text', bad: 'bg-bad/10 text-bad' };
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs whitespace-nowrap ${tones[tone]} ${className}`}>{children}</span>;
}

/** Kept for older call sites: a Pill. */
export const Tag = Pill;

/**
 * Difficulty on LeetCode's three-level scale: beginner → easy, intermediate → medium, advanced → hard.
 * (`expert`, an older level some case files may still use, also shows as hard.)
 */
export const difficultyLevel = (level: string): 'easy' | 'medium' | 'hard' | undefined =>
  ({ beginner: 'easy', intermediate: 'medium', advanced: 'hard', expert: 'hard' } as const)[level as 'beginner'];

export function Difficulty({ level, lang, pill = false }: { level: string; lang: Lang; pill?: boolean }) {
  const map: Record<string, [string, string, string]> = {
    easy: ['简单', 'Easy', 'text-easy bg-easy/10'],
    medium: ['中等', 'Medium', 'text-medium bg-medium/10'],
    hard: ['困难', 'Hard', 'text-hard bg-hard/10'],
  };
  level = difficultyLevel(level) ?? level;
  const [zh, en, cls] = map[level] ?? [level, level, 'text-label-2 bg-fill-3'];
  const color = cls.split(' ')[0];
  return pill
    ? <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{L(lang, zh, en)}</span>
    : <span className={`text-[13px] font-medium ${color}`}>{L(lang, zh, en)}</span>;
}

/** Page title block: large bold title, optional grey subtitle and actions on the right. */
export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[28px] leading-tight font-bold tracking-[-0.02em]">{title}</h1>
        {sub && <p className="mt-2 max-w-3xl text-sm leading-relaxed text-label-2">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Section title inside a page. */
export function SectionTitle({ children, sub, className = '' }: { children: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={`mb-4 ${className}`}>
      <h2 className="text-base font-medium">{children}</h2>
      {sub && <p className="mt-1 text-sm text-label-2">{sub}</p>}
    </div>
  );
}

/**
 * How anything that switches between views looks, wherever it is: the header's links, a page's
 * tabs, the tabs on the workspace's panels, its open files. A capsule; the current one is clear
 * glass with its label in the brand colour. `sm` is for the workspace's narrow panel bars.
 */
export const tabClass = (on: boolean, size: 'md' | 'sm' = 'md') =>
  `flex shrink-0 items-center gap-1.5 rounded-full transition-colors ${size === 'md' ? 'h-8 px-3.5 text-sm' : 'h-7 px-3 text-[13px]'} ${on ? 'chip font-medium text-brand-text' : 'text-label-2 hover:bg-fill-4 hover:text-label-1'}`;

/** Tab strip. */
export function Tabs<T extends string>({ tabs, value, onChange, className = '' }: {
  tabs: { value: T; label: ReactNode; icon?: ReactNode; badge?: ReactNode }[]; value: T; onChange: (v: T) => void; className?: string;
}) {
  return (
    <div role="tablist" className={`no-scrollbar flex items-center gap-1 overflow-x-auto ${className}`}>
      {tabs.map((t) => {
        const on = t.value === value;
        return (
          <button key={t.value} role="tab" aria-selected={on} type="button" onClick={() => onChange(t.value)}
            className={tabClass(on)}>
            {t.icon}{t.label}{t.badge}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The mark on anything that closes, dismisses or removes: drawn, not typed. A typed × sits on the
 * text's baseline, which is below the middle of the button it is in.
 */
export function Cross({ className = 'size-3' }: { className?: string }) {
  return <svg viewBox="0 0 12 12" aria-hidden className={className} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M3 3l6 6M9 3l-6 6" /></svg>;
}
/** Its companion, for adding. */
export function Plus({ className = 'size-3' }: { className?: string }) {
  return <svg viewBox="0 0 12 12" aria-hidden className={className} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M6 2.500v7M2.500 6h7" /></svg>;
}

export function Loading({ label = '加载中……' }: { label?: string }) {
  return (
    <div className={`${container} flex items-center gap-2 py-24 text-label-3`}>
      <span className="size-4 animate-spin rounded-full border-2 border-fill-1 border-t-label-3" />{label}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return <div className={`${container} py-24`}><div className="card p-5 text-bad">{message}</div></div>;
}

/** Empty state inside a card or list. */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-14 text-center text-sm text-label-3">
      <span aria-hidden className="grid size-10 place-items-center rounded-full bg-fill-4 text-lg">∅</span>
      <p>{children}</p>
      {action}
    </div>
  );
}
