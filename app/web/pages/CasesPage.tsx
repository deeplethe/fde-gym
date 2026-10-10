import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { CaseCard as Card } from '../../server/catalog';
import type { Progress } from '../../server/standings';
import { regionLabel, sectorLabel, splitTitle } from '@/components/CaseCard';
import { acceptance, ProgressPanel, StatusIcon, statusOf, type CaseStatus } from '@/components/ProgressPanel';
import { Select } from '@/components/Select';
import { useAuth } from '@/components/auth/AuthDialog';
import { Button, ButtonLink, container, Cross, Difficulty, difficultyLevel, Empty, ErrorBox, Loading, PageHeader, Pill } from '@/components/ui';
import { L, type Lang, useLang } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { useApi } from '@/lib/useApi';

function matches(c: Card, q: string) {
  if (!q) return true;
  const hay = [c.title, c.sector.label, c.sector.key, c.id].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

type Sort = 'number' | 'acceptance' | 'difficulty';
const NOTED = 'fdegym:intro-seen';
const RANK = { easy: 0, medium: 1, hard: 2 } as Record<string, number>;

export function CasesPage() {
  const { lang } = useLang();
  const navigate = useNavigate();
  const auth = useAuth();
  const me = useMe();
  const { data: cards, error } = useApi<Card[]>('/api/cases');
  const { data: progress } = useApi<Progress>('/api/progress');
  // The search text lives in the address, so the header's search box and a shared link land on the same list.
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const setQ = (v: string) => setParams((p) => { if (v) p.set('q', v); else p.delete('q'); return p; }, { replace: true });
  const [sector, setSector] = useState('all');
  const [level, setLevel] = useState('all');
  const [status, setStatus] = useState<'all' | CaseStatus>('all');
  const [sort, setSort] = useState<{ by: Sort; down: boolean }>({ by: 'number', down: false });
  // The one-line note for visitors, until they close it (remembered in this browser).
  const [noted, setNoted] = useState(() => { try { return localStorage.getItem(NOTED) === '1'; } catch { return false; } });
  const dismiss = () => { try { localStorage.setItem(NOTED, '1'); } catch { /* private mode */ } setNoted(true); };

  const sectors = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of cards ?? []) if (!seen.has(c.sector.key)) seen.set(c.sector.key, sectorLabel(c));
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [cards]);

  if (error) return <ErrorBox message={error} />;
  if (!cards) return <Loading />;

  const levelOf = (c: Card) => difficultyLevel(c.difficulty) ?? c.difficulty;
  const key = (c: Card, n: number) => (sort.by === 'acceptance' ? acceptance(c, progress) ?? -1 : sort.by === 'difficulty' ? RANK[levelOf(c)] ?? 3 : n);
  const shown = cards
    .map((c, i) => ({ c, n: i + 1 }))
    .filter(({ c }) => (sector === 'all' || c.sector.key === sector)
      && (level === 'all' || levelOf(c) === level)
      && (status === 'all' || statusOf(c, progress) === status)
      && matches(c, q))
    .sort((a, b) => (key(a.c, a.n) - key(b.c, b.n)) * (sort.down ? -1 : 1) || a.n - b.n);
  const filtered = q !== '' || sector !== 'all' || level !== 'all' || status !== 'all';
  const reset = () => { setQ(''); setSector('all'); setLevel('all'); setStatus('all'); };

  const total = (cs: Card[]) => cs.reduce((k, c) => k + c.versions, 0);
  // Each option says how many scenarios it holds.
  const n = (f: (c: Card) => boolean) => L(lang, `（${cards.filter(f).length}）`, ` (${cards.filter(f).length})`);
  const levelOptions = (['easy', 'medium', 'hard'] as const).filter((d) => cards.some((c) => levelOf(c) === d))
    .map((d) => ({ value: d, label: ({ easy: L(lang, '简单', 'Easy'), medium: L(lang, '中等', 'Medium'), hard: L(lang, '困难', 'Hard') })[d] + n((c) => levelOf(c) === d) }));
  const statusOptions = ([['todo', L(lang, '没做过', 'To do')], ['attempted', L(lang, '做过', 'Attempted')], ['solved', L(lang, '已解决', 'Solved')]] as const)
    .map(([value, label]) => ({ value, label: label + n((c) => statusOf(c, progress) === value) }));

  // Something not solved yet from what is on show; anything on show once all of it is solved.
  const pickOne = () => {
    const open = shown.filter(({ c }) => statusOf(c, progress) !== 'solved');
    const pool = open.length ? open : shown;
    if (pool.length) navigate(`/cases/${pool[Math.floor(Math.random() * pool.length)].c.id}`);
  };
  const head = (by: Sort, label: string, cls: string) => (
    <th className={cls} aria-sort={sort.by === by ? (sort.down ? 'descending' : 'ascending') : 'none'}>
      <button type="button" onClick={() => setSort({ by, down: sort.by === by ? !sort.down : by !== 'number' })} className="inline-flex items-center gap-1 font-medium hover:text-label-1">
        {label}
        <svg viewBox="0 0 8 10" aria-hidden className={`size-2 ${sort.by === by ? 'text-label-1' : 'text-label-4'}`}>
          <path d="M4 0 7.5 4h-7Z" fill="currentColor" opacity={sort.by === by && sort.down ? 0.3 : 1} /><path d="M4 10 .5 6h7Z" fill="currentColor" opacity={sort.by === by && !sort.down ? 0.3 : 1} />
        </svg>
      </button>
    </th>
  );

  return (
    <div className={container}>
      {me && !me.user && !noted && (
        <div className="card mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-label-2">
            <span className="font-semibold text-label-1">{L(lang, 'FDE Gym · 新时代的 OJ。', 'FDE Gym, the online judge for the new era. ')}</span>
            {L(lang, '传统 OJ 判你的代码对不对。这里每道题是一次真实的客户交付，判的是你交的系统上线后，客户的业务好了多少。', 'A classic judge checks whether your code is right. Here each case is a real customer delivery, and what is judged is how much better the customer’s business got once your system went live.')}
          </p>
          <span className="flex shrink-0 items-center gap-1">
            <ButtonLink to="/about" size="sm" tone="secondary">{L(lang, '怎么玩', 'How it works')}</ButtonLink>
            <button type="button" onClick={dismiss} aria-label={L(lang, '关闭', 'Dismiss')} className="grid size-8 place-items-center rounded-md text-label-3 hover:bg-fill-3 hover:text-label-1"><Cross /></button>
          </span>
        </div>
      )}
      <PageHeader
        title={L(lang, '题库', 'Cases')}
        sub={L(lang, '每道题是一次客户交付：一家客户、一套正在运行的系统、几位可以去问的人。这里只写进场前你会知道的事。',
          'Each case is one customer delivery: a customer, a system that is running, a few people you can go and ask. This page only shows what you would know before going on site.')}
      />

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_288px] lg:items-start">
        <div className="min-w-0">
          {/* Search and filters */}
          <div className="grid gap-2.5 sm:grid-cols-3 xl:grid-cols-[minmax(0,1fr)_repeat(3,9.5rem)_auto]">
            <label className="relative block min-w-0 sm:col-span-3 xl:col-span-1">
              <span className="sr-only">{L(lang, '搜索题目', 'Search cases')}</span>
              <svg viewBox="0 0 16 16" aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-label-3">
                <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} className="field pl-8"
                placeholder={L(lang, '搜索标题、公司或领域', 'Search title, company or domain')} />
            </label>
            <span id="level-filter" className="sr-only">{L(lang, '难度', 'Difficulty')}</span>
            <Select aria-labelledby="level-filter" value={level} onChange={setLevel}
              options={[{ value: 'all', label: L(lang, '难度', 'Difficulty') }, ...levelOptions]} />
            <span id="status-filter" className="sr-only">{L(lang, '状态', 'Status')}</span>
            <Select aria-labelledby="status-filter" value={status} onChange={(v) => setStatus(v as 'all' | CaseStatus)}
              options={[{ value: 'all', label: L(lang, '状态', 'Status') }, ...statusOptions]} />
            <span id="sector-filter" className="sr-only">{L(lang, '领域', 'Domain')}</span>
            <Select aria-labelledby="sector-filter" value={sector} onChange={setSector}
              options={[{ value: 'all', label: L(lang, '领域', 'Domain') }, ...sectors.map(([value, label]) => ({ value, label: label + n((c) => c.sector.key === value) }))]} />
            <Button tone="secondary" onClick={pickOne} disabled={!shown.length} className="sm:col-span-3 xl:col-span-1" >
              <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 4.5h2.4c1.2 0 2.3.6 2.9 1.6l2.4 3.8c.6 1 1.7 1.6 2.9 1.6h2.4M12.5 2.5l2 2-2 2M12.5 9.5l2 2-2 2M1.5 11.5h2.4c.8 0 1.5-.3 2.1-.7M14.5 4.5h-2.4c-.8 0-1.5.3-2.1.7" />
              </svg>
              {L(lang, '随机一题', 'Pick one')}
            </Button>
          </div>
          <div className="mt-3 flex min-h-8 items-center justify-between gap-3">
            <p className="text-xs text-label-3">
              {filtered
                ? L(lang, `${shown.length} / ${cards.length} 个场景符合，共 ${total(shown.map((x) => x.c))} 道题`, `${shown.length} of ${cards.length} scenarios match, ${total(shown.map((x) => x.c))} cases`)
                : L(lang, `${cards.length} 个场景，共 ${total(cards)} 道题`, `${cards.length} scenarios, ${total(cards)} cases`)}
            </p>
            {filtered && <Button tone="ghost" size="sm" onClick={reset}>{L(lang, '清除筛选', 'Clear filters')}</Button>}
          </div>

          {/* The problem set */}
          <div className="card mt-2 overflow-hidden">
            {shown.length ? (
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b border-divider text-left text-xs text-label-3">
                    <th className="w-11 py-3 pl-4 font-medium"><span className="sr-only">{L(lang, '状态', 'Status')}</span></th>
                    {head('number', L(lang, '题目', 'Title'), 'py-3 pr-4')}
                    <th className="hidden w-40 py-3 pr-4 font-medium md:table-cell">{L(lang, '领域', 'Domain')}</th>
                    {head('acceptance', L(lang, '通过率', 'Acceptance'), 'hidden w-28 py-3 pr-4 sm:table-cell')}
                    {head('difficulty', L(lang, '难度', 'Difficulty'), 'w-20 py-3 pr-4 sm:w-24')}
                  </tr>
                </thead>
                <tbody className="divide-y divide-divider">
                  {shown.map(({ c, n: number }) => <Row key={c.id} c={c} n={number} progress={progress} lang={lang} onOpen={() => navigate(`/cases/${c.id}`)} />)}
                </tbody>
              </table>
            ) : cards.length === 0 ? (
              // No cases at all (a fresh install has none): that is not a filter's doing, so there is nothing to clear.
              <Empty action={<ButtonLink to="/docs" tone="secondary" size="sm">{L(lang, '怎么添加题目', 'How to add cases')}</ButtonLink>}>
                {L(lang, '题库里还没有题目。管理员可以在管理后台上传，或者把题目文件夹放进导入目录后重启网站。', 'The library has no cases yet. An admin can upload one in the admin console, or put case folders in the import folder and restart the site.')}
              </Empty>
            ) : (
              <Empty action={<Button tone="secondary" size="sm" onClick={reset}>{L(lang, '清除筛选', 'Clear filters')}</Button>}>
                {L(lang, '没有符合条件的题目。', 'No cases match these filters.')}
              </Empty>
            )}
          </div>
        </div>

        {/* Where you stand */}
        <aside className="flex flex-col gap-4 lg:sticky lg:top-[76px]">
          <div className="card p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold">{L(lang, '我的进度', 'Your progress')}</h2>
              <Link to="/me" className="text-xs text-label-2 hover:text-label-1">{L(lang, '练习记录', 'Runs')}</Link>
            </div>
            <ProgressPanel cards={cards} progress={progress} lang={lang} className="mt-4" />
            {me && !me.user && (
              <p className="mt-4 border-t border-divider pt-3 text-xs leading-relaxed text-label-3">
                <button type="button" onClick={() => auth.open('register')} className="text-link hover:underline">{L(lang, '注册', 'Sign up')}</button>
                {L(lang, ' 之后进度跟着账号走，并计入排行榜。', ' to keep your progress with an account and appear on the leaderboard.')}
              </p>
            )}
          </div>
          <div className="card p-4 text-xs leading-relaxed text-label-2">
            <h2 className="text-[13px] font-semibold text-label-1">{L(lang, '怎样算解决', 'What counts as solved')}</h2>
            <p className="mt-2">{L(lang, '提交后，你交的系统会在客户没给你看过的流量上跑一遍。满分 100：0 分是什么都没改，100 分是参考解。达到 80 分算解决这道题。',
              'After you hand over, your system is run on traffic the customer never showed you. Scores are out of 100: 0 is changing nothing, 100 is the reference solution. A case is solved at 80 or more.')}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Row({ c, n, progress, lang, onOpen }: { c: Card; n: number; progress: Progress | undefined; lang: Lang; onOpen: () => void }) {
  const { org, ask } = splitTitle(c.title);
  const rate = acceptance(c, progress);
  const mine = progress?.cases[c.id];
  return (
    <tr onClick={onOpen} className="group cursor-pointer transition-colors hover:bg-fill-4">
      <td className="py-3 pl-4 align-middle"><StatusIcon status={statusOf(c, progress)} lang={lang} /></td>
      <td className="min-w-0 py-3 pr-4">
        <Link to={`/cases/${c.id}`} onClick={(e) => e.stopPropagation()}
          className="line-clamp-2 font-medium text-label-1 group-hover:text-link md:block md:truncate" title={ask}>
          <span className="tabular-nums">{n}.</span> {ask}
        </Link>
        <p className="mt-0.5 truncate text-xs text-label-3">
          {org}<span className="hidden md:inline"> · {regionLabel(lang, c.region)}</span>
          {c.versions > 1 && <> · {L(lang, `${c.versions} 道题`, `${c.versions} cases`)}{mine && mine.solved > 0 && mine.solved < c.versions ? L(lang, `，解决 ${mine.solved}`, `, ${mine.solved} solved`) : ''}</>}
        </p>
        {/* On narrow screens the hidden columns fold in under the title. */}
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-label-3 md:hidden">
          <Pill>{sectorLabel(c)}</Pill>
          <span>{regionLabel(lang, c.region)}</span>
          {rate !== undefined && <span className="sm:hidden">· {(rate * 100).toFixed(1)}%</span>}
        </p>
      </td>
      <td className="hidden py-3 pr-4 md:table-cell"><Pill className="max-w-full"><span className="truncate" title={sectorLabel(c)}>{sectorLabel(c)}</span></Pill></td>
      <td className="hidden py-3 pr-4 text-label-2 tabular-nums sm:table-cell" title={rate === undefined ? undefined : L(lang, `${progress!.cases[c.id].accepted} / ${progress!.cases[c.id].submissions} 次提交`, `${progress!.cases[c.id].accepted} of ${progress!.cases[c.id].submissions} submissions`)}>
        {rate === undefined ? <span className="text-label-4">—</span> : `${(rate * 100).toFixed(1)}%`}
      </td>
      <td className="py-3 pr-4"><Difficulty level={c.difficulty} lang={lang} /></td>
    </tr>
  );
}
