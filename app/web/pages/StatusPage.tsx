import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Submission } from '../../server/standings';
import { splitTitle } from '@/components/CaseCard';
import { Verdict } from '@/components/Verdict';
import { ButtonLink, container, Empty, ErrorBox, Loading, PageHeader, Tabs } from '@/components/ui';
import { L, useLang } from '@/lib/i18n';
import { useApi } from '@/lib/useApi';
import { score } from '@/lib/score';

/** The stream of submissions, as an online judge keeps it: who handed over what, and how it was judged. */
export function StatusPage() {
  const { lang } = useLang();
  const [who, setWho] = useState<'all' | 'mine'>('all');
  const { data: rows, error, reload } = useApi<Submission[]>(`/api/submissions${who === 'mine' ? '?mine=1' : ''}`);
  // Grading takes minutes: keep looking while something is being judged.
  const judging = rows?.some((r) => r.verdict === 'judging');
  useEffect(() => {
    if (!judging) return;
    const t = setInterval(() => { void reload(); }, 5000);
    return () => clearInterval(t);
  }, [judging, reload]);
  if (error) return <ErrorBox message={error} />;
  if (!rows) return <Loading />;
  const when = (t: number) => new Date(t).toLocaleString(lang === 'en' ? 'en-SG' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className={container}>
      <PageHeader
        title={L(lang, '提交记录', 'Submissions')}
        sub={L(lang, '最近交上来的系统，和它们上线后的判定。满分 100：0 分是什么都没改，100 分是参考解；达到 80 分算通过，出了事故的不高于 0 分。',
          'The systems handed over lately, and how each was judged once live. Scores are out of 100: 0 is changing nothing and 100 is the reference solution; 80 or more is accepted, and a run with an incident scores no higher than 0.')}
      />
      <Tabs className="mt-6" value={who} onChange={setWho} tabs={[{ value: 'all', label: L(lang, '全部', 'Everyone') }, { value: 'mine', label: L(lang, '我的', 'Mine') }]} />
      <div className="card mt-4 overflow-hidden">
        {!rows.length ? (
          <Empty action={<ButtonLink to="/cases" size="sm">{L(lang, '去题库', 'Browse cases')}</ButtonLink>}>
            {who === 'mine' ? L(lang, '你还没有提交过。', 'You have not submitted anything yet.') : L(lang, '还没有人提交过。', 'Nobody has submitted yet.')}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] table-fixed text-sm">
              <thead>
                <tr className="border-b border-divider text-left text-xs text-label-3">
                  <th className="w-36 py-3 pl-5 font-medium">{L(lang, '时间', 'When')}</th>
                  <th className="w-44 py-3 pr-4 font-medium">{L(lang, '成员', 'Member')}</th>
                  <th className="py-3 pr-4 font-medium">{L(lang, '题目', 'Case')}</th>
                  <th className="w-28 py-3 pr-4 font-medium">{L(lang, '判定', 'Verdict')}</th>
                  <th className="w-20 py-3 pr-5 text-right font-medium">{L(lang, '得分', 'Score')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divider">
                {rows.map((r, i) => (
                  <tr key={i} className={r.me ? 'bg-fill-4' : ''}>
                    <td className="py-3 pl-5 text-label-2 tabular-nums">{when(r.at)}</td>
                    <td className="truncate py-3 pr-4">{r.name ?? <span className="text-label-3">{L(lang, '匿名', 'Anonymous')}</span>}</td>
                    <td className="truncate py-3 pr-4">
                      <Link to={`/cases/${r.caseId}`} className="font-medium hover:text-link" title={r.title}>{splitTitle(r.title).ask}</Link>
                      {r.version !== null && <span className="text-label-3"> #{r.version}</span>}
                    </td>
                    <td className="py-3 pr-4"><Verdict verdict={r.verdict} lang={lang} /></td>
                    <td className="py-3 pr-5 text-right tabular-nums">{r.score === null ? <span className="text-label-4">—</span> : score(r.score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
