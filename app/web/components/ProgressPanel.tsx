/**
 * Where someone stands in the library, as on a problem site: a ring for cases solved out of all of
 * them, and the same count for each difficulty beside it.
 */
import type { CaseCard as Card } from '../../server/catalog';
import type { Progress } from '../../server/standings';
import { L, type Lang } from '@/lib/i18n';
import { difficultyLevel } from './ui';

export type CaseStatus = 'solved' | 'attempted' | 'todo';
/** A scenario is solved once every one of its cases is. */
export function statusOf(c: Card, p: Progress | undefined): CaseStatus {
  const mine = p?.cases[c.id];
  return !mine ? 'todo' : mine.solved >= c.versions ? 'solved' : mine.attempted ? 'attempted' : 'todo';
}
/** Share of graded runs that solved the case; undefined before anyone has submitted. */
export function acceptance(c: Card, p: Progress | undefined): number | undefined {
  const all = p?.cases[c.id];
  return all && all.submissions > 0 ? all.accepted / all.submissions : undefined;
}

const LEVELS = ['easy', 'medium', 'hard'] as const;
export function tally(cards: Card[], p: Progress | undefined) {
  const by = Object.fromEntries(LEVELS.map((l) => [l, { solved: 0, total: 0 }])) as Record<(typeof LEVELS)[number], { solved: number; total: number }>;
  let solved = 0, total = 0, attempted = 0;
  for (const c of cards) {
    const mine = p?.cases[c.id];
    const n = Math.min(mine?.solved ?? 0, c.versions);
    solved += n; total += c.versions;
    if (mine?.attempted && n < c.versions) attempted++;
    const level = difficultyLevel(c.difficulty);
    if (level) { by[level].solved += n; by[level].total += c.versions; }
  }
  return { solved, total, attempted, by };
}

export function StatusIcon({ status, lang }: { status: CaseStatus; lang: Lang }) {
  if (status === 'solved') {
    return (
      <svg viewBox="0 0 16 16" className="size-4 text-ok" role="img" aria-label={L(lang, '已解决', 'Solved')}>
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5.2 8.2 7.1 10.1 10.8 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === 'attempted') {
    return (
      <svg viewBox="0 0 16 16" className="size-4 text-medium" role="img" aria-label={L(lang, '做过，还没解决', 'Attempted')}>
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 1.75a6.25 6.25 0 0 1 0 12.5Z" fill="currentColor" />
      </svg>
    );
  }
  return <span className="sr-only">{L(lang, '没做过', 'Not attempted')}</span>;
}

export function ProgressPanel({ cards, progress, lang, className = '' }: { cards: Card[]; progress: Progress | undefined; lang: Lang; className?: string }) {
  const t = tally(cards, progress);
  const r = 42, around = 2 * Math.PI * r;
  const share = t.total ? t.solved / t.total : 0;
  const names = { easy: L(lang, '简单', 'Easy'), medium: L(lang, '中等', 'Medium'), hard: L(lang, '困难', 'Hard') };
  const colors = { easy: 'text-easy', medium: 'text-medium', hard: 'text-hard' };
  return (
    <div className={className}>
      <div className="flex items-center gap-5">
        <div className="relative size-[108px] shrink-0">
          <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden>
            <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-fill-3)" strokeWidth="6" />
            <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-brand)" strokeWidth="6" strokeLinecap="round"
              strokeDasharray={`${share * around} ${around}`} className="transition-[stroke-dasharray] duration-500" />
          </svg>
          <div className="absolute inset-0 grid place-content-center text-center">
            <p className="text-2xl leading-none font-bold tabular-nums">{t.solved}<span className="text-sm font-medium text-label-3">/{t.total}</span></p>
            <p className="mt-1 text-[11px] text-label-2">{L(lang, '已解决', 'Solved')}</p>
          </div>
        </div>
        <dl className="grid min-w-0 flex-1 gap-1.5">
          {LEVELS.filter((l) => t.by[l].total > 0).map((l) => (
            <div key={l} className="flex items-center justify-between gap-3 rounded-md bg-fill-4 px-2.5 py-1.5 text-xs">
              <dt className={`font-medium ${colors[l]}`}>{names[l]}</dt>
              <dd className="tabular-nums"><span className="font-semibold">{t.by[l].solved}</span><span className="text-label-3">/{t.by[l].total}</span></dd>
            </div>
          ))}
        </dl>
      </div>
      {t.attempted > 0 && <p className="mt-3 text-xs text-label-3">{L(lang, `另有 ${t.attempted} 个做过，还没解决`, `${t.attempted} more attempted, not solved yet`)}</p>}
    </div>
  );
}
