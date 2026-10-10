import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { CaseCard as Card } from '../../server/catalog';
import type { Progress, Standings } from '../../server/standings';
import { ProgressPanel } from '@/components/ProgressPanel';
import { splitTitle } from '@/components/CaseCard';
import { useAuth } from '@/components/auth/AuthDialog';
import { Modal } from '@/components/Modal';
import { Select } from '@/components/Select';
import { Button, ButtonLink, container, Empty, ErrorBox, Loading, PageHeader, Pill } from '@/components/ui';
import { api } from '@/lib/client';
import { L, useLang } from '@/lib/i18n';
import { useApi } from '@/lib/useApi';
import { PASS, score } from '@/lib/score';

/** `totalScore` is what the delivered system gained, less what the work cost the customer's people. */
type Run = { runId: string; caseId: string; startedAt: number; status: string; totalScore: number | null; grading?: string; version: number };

export function MePage() {
  const { lang } = useLang();
  const auth = useAuth();
  const navigate = useNavigate();
  const { data, error, reload } = useApi<{ learner: { name: string } | null; user: { name: string; email: string } | null; runs: Run[] }>('/api/me');
  const [status, setStatus] = useState('all');
  const [scenario, setScenario] = useState('all');
  const [ending, setEnding] = useState<Run>();
  const [endError, setEndError] = useState<string>();
  // Only used to show case titles next to ids; the table still works without it.
  const { data: cards } = useApi<Card[]>('/api/cases');
  const { data: progress } = useApi<Progress>('/api/progress');
  const { data: board } = useApi<Standings>('/api/leaderboard');
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  // Red is kept for the one state that needs something done about it (a grading that failed); a run
  // the learner chose to terminate is nobody's problem, so it stays grey.
  const STATES: Record<string, [string, string, 'ok' | 'warn' | 'brand' | 'plain' | 'bad']> = {
    running: ['进行中', 'In progress', 'brand'], grading: ['已提交 · 评分中', 'Submitted · grading', 'warn'], graded: ['已评分', 'Graded', 'ok'],
    failed: ['评分失败', 'Grading failed', 'bad'], abandoned: ['已终止', 'Terminated', 'plain'],
  };
  /** Everything that was submitted, whatever became of the grading. */
  const SUBMITTED = ['grading', 'graded', 'failed'];
  const inStatus = (r: Run, f: string) => f === 'all' || (f === 'submitted' ? SUBMITTED.includes(r.status) : r.status === f);
  const state = (r: Run) => L(lang, ...(STATES[r.status] ?? [r.status, r.status]).slice(0, 2) as [string, string]);
  const tone = (r: Run) => STATES[r.status]?.[2] ?? 'plain';
  const count = (f: (r: Run) => boolean) => L(lang, `（${data.runs.filter(f).length}）`, ` (${data.runs.filter(f).length})`);
  const shown = data.runs.filter((r) => inStatus(r, status) && (scenario === 'all' || r.caseId === scenario));

  async function end(r: Run) {
    try { await api(`/api/sessions/${r.runId}/abandon`, { method: 'POST' }); setEnding(undefined); setEndError(undefined); await reload(); }
    catch (e) { setEndError((e as Error).message); }
  }
  const titleOf = (caseId: string) => {
    const c = cards?.find((x) => x.id === caseId);
    return c ? splitTitle(c.title).ask : undefined;
  };

  return (
    <div className={container}>
      {!data.user && (
        <div className="card mb-6 flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
          <span aria-hidden className="hidden size-10 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-text sm:grid">
            <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="7" r="3.2" /><path d="M3.8 16.5c.9-3 3.3-4.6 6.2-4.6s5.3 1.6 6.2 4.6" /></svg>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold">{L(lang, '登录后，练习记录会跟着账号走', 'Sign in and your runs follow your account')}</p>
            <p className="mt-1 text-[13px] text-label-3">
              {data.learner
                ? L(lang, '现在的记录只保存在这个浏览器里，换设备或清除浏览器数据就看不到了。登录或注册后会自动归到账号下。', 'These runs are saved in this browser only and are lost if you switch devices or clear site data. Signing in or up moves them to your account.')
                : L(lang, '没登录时，练习记录只保存在当前浏览器。', 'Without an account, runs are saved in this browser only.')}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button tone="ghost" size="sm" onClick={() => auth.open('login')}>{L(lang, '登录', 'Sign in')}</Button>
            <Button tone="secondary" size="sm" onClick={() => auth.open('register')}>{L(lang, '注册', 'Sign up')}</Button>
          </div>
        </div>
      )}
      <PageHeader
        title={L(lang, '我的练习', 'My runs')}
        sub={data.user ? <>{data.user.name}<span className="mx-1.5 text-label-4">·</span>{data.user.email}</> : data.learner?.name}
        actions={data.runs.length ? <ButtonLink to="/cases" tone="secondary">{L(lang, '去题库', 'Browse cases')}</ButtonLink> : undefined}
      />

      {/* Where this person stands: cases solved by difficulty, and the numbers a profile leads with. */}
      {cards && cards.length > 0 && data.runs.length > 0 && (() => {
        const graded = data.runs.filter((r) => r.totalScore !== null);
        const rank = board?.rows.find((r) => r.me)?.rank;
        const figures: [string, string][] = [
          [rank ? `#${rank}` : '—', L(lang, '排行榜名次', 'Leaderboard rank')],
          [String(graded.length), L(lang, '次提交', 'Runs submitted')],
          [graded.length ? score(Math.max(...graded.map((r) => r.totalScore!))) : '—', L(lang, '最高得分', 'Best score')],
        ];
        return (
          <div className="card mt-6 grid gap-6 p-5 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] md:items-center">
            <ProgressPanel cards={cards} progress={progress} lang={lang} />
            <dl className="grid grid-cols-3 gap-4 md:border-l md:border-divider md:pl-6">
              {figures.map(([n, label]) => (
                <div key={label}>
                  <dd className="text-2xl font-bold tabular-nums">{n}</dd>
                  <dt className="mt-1 text-xs text-label-2">{label}</dt>
                </div>
              ))}
            </dl>
          </div>
        );
      })()}

      {data.runs.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-2.5">
          <span id="run-status" className="sr-only">{L(lang, '状态', 'Status')}</span>
          <Select aria-labelledby="run-status" className="w-48" value={status} onChange={setStatus} options={[
            { value: 'all', label: L(lang, '全部状态', 'All statuses') + count(() => true) },
            ...(['running', 'submitted', 'graded', 'failed', 'abandoned'] as const).filter((k) => data.runs.some((r) => inStatus(r, k))).map((k) => ({
              value: k,
              label: (k === 'submitted' ? L(lang, '已提交', 'Submitted') : L(lang, STATES[k][0], STATES[k][1])) + count((r) => inStatus(r, k)),
              ...(k === 'submitted' ? { hint: L(lang, '评分中、已评分、评分失败都算', 'Grading, graded or failed to grade') } : {}),
            })),
          ]} />
          <span id="run-scenario" className="sr-only">{L(lang, '场景', 'Scenario')}</span>
          <Select aria-labelledby="run-scenario" className="w-72" value={scenario} onChange={setScenario} options={[
            { value: 'all', label: L(lang, '全部场景', 'All scenarios') },
            ...[...new Set(data.runs.map((r) => r.caseId))].map((id) => ({ value: id, label: (titleOf(id) ?? id) + count((r) => r.caseId === id) })),
          ]} />
          <span className="text-xs text-label-3">{L(lang, `${shown.length} / ${data.runs.length} 次`, `${shown.length} of ${data.runs.length} runs`)}</span>
          {(status !== 'all' || scenario !== 'all') && <Button tone="ghost" size="sm" onClick={() => { setStatus('all'); setScenario('all'); }}>{L(lang, '清除筛选', 'Clear filters')}</Button>}
        </div>
      )}

      <div className={`card overflow-hidden ${data.runs.length ? 'mt-3' : 'mt-6'}`}>
        {!data.runs.length ? (
          <Empty action={<ButtonLink to="/cases">{L(lang, '去选一道题', 'Pick a case')}</ButtonLink>}>
            {L(lang, '还没有练习记录。', 'No runs yet.')}
          </Empty>
        ) : !shown.length ? (
          <Empty>{L(lang, '没有符合条件的练习。', 'No runs match these filters.')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-divider text-left text-xs font-medium text-label-3">
                  <th className="py-3 pr-4 pl-5 font-medium">{L(lang, '题目', 'Case')}</th>
                  <th className="w-44 py-3 pr-4 font-medium">{L(lang, '开始时间', 'Started')}</th>
                  <th className="w-28 py-3 pr-4 font-medium">{L(lang, '状态', 'Status')}</th>
                  <th className="w-20 py-3 pr-4 text-right font-medium">{L(lang, '得分', 'Score')}</th>
                  <th className="w-24 py-3 pr-5"><span className="sr-only">{L(lang, '操作', 'Actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const title = titleOf(r.caseId);
                  return (
                    <tr key={r.runId} onClick={() => navigate(`/s/${r.runId}`)}
                      className="group cursor-pointer border-b border-divider transition-colors last:border-0 hover:bg-fill-4">
                      <td className="max-w-0 py-2.5 pr-4 pl-5">
                        <Link to={`/s/${r.runId}`} onClick={(e) => e.stopPropagation()}
                          className="block truncate font-medium text-label-1 group-hover:text-link" title={title ?? r.caseId}>
                          {title ?? r.caseId}
                        </Link>
                        {title && <p className="truncate text-xs text-label-3">{r.caseId}{(cards?.find((x) => x.id === r.caseId)?.versions ?? 1) > 1 && r.version > 0 && ` · #${r.version}`}</p>}
                      </td>
                      <td className="py-2.5 pr-4 text-label-2 tabular-nums">{new Date(r.startedAt).toLocaleString(lang === 'en' ? 'en-SG' : 'zh-CN')}</td>
                      <td className="py-2.5 pr-4"><Pill tone={tone(r)}>{state(r)}</Pill></td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">
                        {r.totalScore !== null && r.grading === 'done'
                          ? <span className={`text-[15px] font-semibold ${r.totalScore >= PASS ? 'text-ok' : ''}`}>{score(r.totalScore)}</span>
                          : <span className="text-label-4">—</span>}
                      </td>
                      <td className="py-2.5 pr-5 text-right">
                        {r.status === 'running' && <Button size="sm" tone="ghost" onClick={(e) => { e.stopPropagation(); setEndError(undefined); setEnding(r); }}>{L(lang, '终止', 'Terminate')}</Button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {ending && (
        <Modal lang={lang} title={L(lang, '终止这次练习', 'Terminate this run')} onClose={() => setEnding(undefined)}
          actions={<><Button size="sm" tone="ghost" onClick={() => setEnding(undefined)}>{L(lang, '先留着', 'Keep it')}</Button><Button size="sm" tone="secondary" onClick={() => void end(ending)}>{L(lang, '终止，不提交', 'Terminate without submitting')}</Button></>}>
          <p className="text-sm leading-relaxed text-label-2">
            <span className="font-medium text-label-1">{titleOf(ending.caseId) ?? ending.caseId}</span>
            {L(lang, '：终止后不会评分，也不计入成绩；工作区还能看，但不能再改。正在运行的 agent 和命令会被停掉。', ': it will not be graded and counts for nothing. The workspace can still be read but not changed. A running agent or command is stopped.')}
          </p>
          {endError && <p className="text-sm text-bad">{endError}</p>}
        </Modal>
      )}
    </div>
  );
}
