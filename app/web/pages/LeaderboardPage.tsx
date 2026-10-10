import type { Standings } from '../../server/standings';
import { useAuth } from '@/components/auth/AuthDialog';
import { Button, ButtonLink, Card, container, Empty, ErrorBox, Loading, PageHeader } from '@/components/ui';
import { L, useLang } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { useApi } from '@/lib/useApi';
import { score } from '@/lib/score';

const MEDAL = ['text-[#d4a017]', 'text-[#8e99a8]', 'text-[#b0703c]'];

export function LeaderboardPage() {
  const { lang } = useLang();
  const me = useMe();
  const auth = useAuth();
  const { data: board, error } = useApi<Standings>('/api/leaderboard');
  if (error) return <ErrorBox message={error} />;
  if (!board) return <Loading />;
  const mine = board.rows.find((r) => r.me);

  return (
    <div className={container}>
      <PageHeader
        title={L(lang, '排行榜', 'Leaderboard')}
        sub={L(lang,
          '按解决的题数排名，题数相同看总分，再相同看谁先做到。每道题取你最好的一次：得分达到 80 分（满分 100）算解决，总分是各题最好成绩之和。',
          'Ranked by cases solved, then by total score, then by who got there first. Each case counts your best run: it is solved at 80 or more out of 100, and the total is the sum of your best scores.')}
        actions={<ButtonLink to="/cases" tone="secondary">{L(lang, '去题库', 'Browse cases')}</ButtonLink>}
      />

      {mine && (
        <Card className="mt-6 flex flex-wrap items-center gap-x-10 gap-y-3">
          <div><p className="text-xs text-label-2">{L(lang, '你的名次', 'Your rank')}</p><p className="mt-0.5 text-2xl font-bold tabular-nums">#{mine.rank}<span className="text-sm font-medium text-label-3"> / {board.rows.length}</span></p></div>
          <div><p className="text-xs text-label-2">{L(lang, '已解决', 'Solved')}</p><p className="mt-0.5 text-2xl font-bold tabular-nums">{mine.solved}<span className="text-sm font-medium text-label-3"> / {board.problems}</span></p></div>
          <div><p className="text-xs text-label-2">{L(lang, '总分', 'Score')}</p><p className="mt-0.5 text-2xl font-bold tabular-nums">{score(mine.score)}</p></div>
        </Card>
      )}

      <div className="card mt-4 overflow-hidden">
        {!board.rows.length ? (
          <Empty action={<ButtonLink to="/cases" size="sm">{L(lang, '去做第一道题', 'Solve the first case')}</ButtonLink>}>
            {L(lang, '还没有人提交过。', 'Nobody has submitted yet.')}
          </Empty>
        ) : (
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="border-b border-divider text-left text-xs text-label-3">
                <th className="w-16 py-3 pl-5 font-medium">{L(lang, '名次', 'Rank')}</th>
                <th className="py-3 pr-4 font-medium">{L(lang, '成员', 'Member')}</th>
                <th className="w-24 py-3 pr-4 text-right font-medium">{L(lang, '已解决', 'Solved')}</th>
                <th className="w-24 py-3 pr-4 text-right font-medium">{L(lang, '总分', 'Score')}</th>
                <th className="hidden w-28 py-3 pr-4 text-right font-medium sm:table-cell">{L(lang, '做过的题', 'Attempted')}</th>
                <th className="hidden w-24 py-3 pr-5 text-right font-medium sm:table-cell">{L(lang, '提交', 'Runs')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {board.rows.map((r) => (
                <tr key={r.rank} className={r.me ? 'bg-fill-4' : ''}>
                  <td className={`py-3 pl-5 font-semibold tabular-nums ${MEDAL[r.rank - 1] ?? 'text-label-3'}`}>{r.rank}</td>
                  <td className="py-3 pr-4">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-fill-3 text-xs font-semibold text-label-2">{[...r.name][0]?.toUpperCase()}</span>
                      <span className="truncate font-medium">{r.name}</span>
                      {r.me && <span className="shrink-0 rounded bg-brand px-1.5 py-0.5 text-[10px] leading-none font-semibold text-on-brand">{L(lang, '你', 'You')}</span>}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-right font-semibold tabular-nums">{r.solved}</td>
                  <td className="py-3 pr-4 text-right tabular-nums">{score(r.score)}</td>
                  <td className="hidden py-3 pr-4 text-right text-label-2 tabular-nums sm:table-cell">{r.attempted}</td>
                  <td className="hidden py-3 pr-5 text-right text-label-2 tabular-nums sm:table-cell">{r.runs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {me && !me.user && (
        <p className="mt-4 text-xs text-label-3">
          {L(lang, '排行榜只列有账号的成员。', 'Only members with an account are ranked. ')}
          <Button tone="ghost" size="sm" onClick={() => auth.open('register')}>{L(lang, '注册', 'Sign up')}</Button>
        </p>
      )}
    </div>
  );
}
