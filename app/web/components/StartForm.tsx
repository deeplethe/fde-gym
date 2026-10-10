import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { L, type Lang } from '@/lib/i18n';
import { api } from '@/lib/client';
import { refreshMe, useMe } from '@/lib/me';
import { useSiteConfig } from '@/lib/site';
import { useAuth } from './auth/AuthDialog';
import { Button } from './ui';
import { score } from '@/lib/score';

export interface MyCase { version: number; runId: string; grading?: string; totalScore: number | null }

export function StartForm({ caseId, lang, defaultName, versions = 1, myCases = [] }: {
  caseId: string; lang: Lang; defaultName?: string;
  /** How many cases the scenario has (one per version of its hidden truth), and this person's latest run on each. */
  versions?: number; myCases?: MyCase[];
}) {
  const navigate = useNavigate();
  const me = useMe();
  const site = useSiteConfig();
  const auth = useAuth();
  // The site may require an account to practise.
  const mustSignIn = !!me && !me.user && site?.allowAnonymous === false;
  const [name, setName] = useState(defaultName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Which of the scenario's cases to start: the first one not done yet. Learners see numbers only;
  // a case's real name would give it away.
  const mine = (n: number) => myCases.find((m) => m.version === n);
  const [pick, setPick] = useState(() => Array.from({ length: versions }, (_x, i) => i + 1).find((n) => !myCases.some((m) => m.version === n)) ?? 1);
  // Admins also see what is behind each number.
  const isAdmin = me?.user?.role === 'admin';
  const [names, setNames] = useState<{ version: number; key: string; angle: string | null }[]>();
  useEffect(() => {
    if (!isAdmin || versions < 2) return;
    api<{ version: number; key: string; angle: string | null }[]>(`/api/admin/cases/${caseId}/variants`).then(setNames).catch(() => undefined);
  }, [isAdmin, caseId, versions]);
  const picked = mine(pick), real = names?.find((v) => v.version === pick);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    const res = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ caseId, name, version: pick }) });
    const data = await res.json();
    if (!res.ok) { setError(data.error); setBusy(false); return; }
    void refreshMe(); // an anonymous learner now has a name
    navigate(`/s/${data.runId}`);
  }

  return (
    <form onSubmit={start} className="card relative z-10 p-5">
      <h2 className="text-base font-semibold">{L(lang, '开始练习', 'Start this case')}</h2>
      {me?.user ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-label-2">
          <span aria-hidden className="grid size-6 place-items-center rounded-full bg-brand text-[11px] font-semibold text-on-brand">{[...me.user.name][0]?.toUpperCase()}</span>
          <span className="min-w-0 truncate">{L(lang, '以 ', 'Practising as ')}<span className="font-medium text-label-1">{me.user.name}</span>{L(lang, ' 身份练习', '')}</span>
        </p>
      ) : mustSignIn ? (
        <p className="mt-4 rounded-lg bg-fill-4 px-3.5 py-3 text-[13px] leading-relaxed text-label-2">
          {L(lang, '本站需要登录后练习，练习记录会保存在账号里。', 'This site asks you to sign in to practise; your runs are kept with your account.')}
        </p>
      ) : me ? (
        <div className="mt-5">
          <label className="block">
            <span className="field-label">{L(lang, '你的名字', 'Your name')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} className="field" />
          </label>
          <p className="mt-1.5 text-xs text-label-3">
            <button type="button" onClick={() => auth.open('login')} className="text-link hover:underline">{L(lang, '登录', 'Sign in')}</button>
            {L(lang, '后练习记录会保存在账号里', ' to keep your runs with your account')}
          </p>
        </div>
      ) : <div className="mt-5 h-[88px]" aria-hidden />}
      {versions > 1 && (
        <fieldset className="mt-6">
          <legend className="field-label">{L(lang, `这个场景的 ${versions} 道题`, `The ${versions} cases in this scenario`)}</legend>
          <div role="radiogroup" className="flex flex-wrap gap-1.5">
            {Array.from({ length: versions }, (_x, i) => i + 1).map((n) => {
              const m = mine(n), on = n === pick;
              return (
                <button key={n} type="button" role="radio" aria-checked={on} onClick={() => setPick(n)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] tabular-nums ${on ? 'chip chip-on font-medium' : 'chip text-label-2 hover:text-label-1'}`}>
                  #{n}
                  {m && <span className={`text-[11px] ${on ? '' : 'text-label-3'}`}>{m.grading === 'done' && m.totalScore !== null ? score(m.totalScore) : '···'}</span>}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-label-3">
            {!picked ? L(lang, `第 ${pick} 题：还没做过。`, `Case #${pick}: not done yet.`)
              : <>{picked.grading === 'done' && picked.totalScore !== null
                  ? L(lang, `第 ${pick} 题：做过，得分 ${score(picked.totalScore)}。`, `Case #${pick}: done, scored ${score(picked.totalScore)}. `)
                  : L(lang, `第 ${pick} 题：有一次还没结束的练习。`, `Case #${pick}: you have a run that is not finished. `)}
                <Link to={`/s/${picked.runId}`} className="text-link hover:underline">{L(lang, '打开那次练习', 'Open that run')}</Link></>}
            {real && <span className="mt-1 block font-mono text-[11px] text-label-2">{real.key}{real.angle ? ` — ${real.angle}` : ''}</span>}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-label-3">
            {L(lang, '这几道题的题面一样，背后的实情各不相同，所以要各做各的。做完一道，才会告诉你它和第 1 题差在哪。', 'These cases share a brief and differ in the truth behind it, so each has to be worked on its own. Once you finish one, you are told how it differs from #1.')}
          </p>
        </fieldset>
      )}
      {error && <p className="mt-4 text-sm text-bad">{error}</p>}
      {mustSignIn
        ? <Button type="button" size="lg" className="mt-6 w-full" onClick={() => auth.open('login')}>{L(lang, '登录后开始练习', 'Sign in to begin')}</Button>
        : <Button disabled={busy} size="lg" className="mt-6 w-full">{busy ? L(lang, '正在准备工作区……', 'Preparing the workspace…') : L(lang, '进场', 'Begin')}</Button>}
    </form>
  );
}
