/**
 * The machines that run cases: the site itself when it does, and every runner that has connected.
 * A run lives on the machine it started on, so this is where an admin sees where the room is, takes
 * a machine out of rotation before maintenance (drain), or shuts one out (disable).
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Empty, Pill } from '@/components/ui';
import type { AdminApi } from '@/lib/admin';
import { L, type Lang } from '@/lib/i18n';

type RunnerRow = {
  name: string; online: boolean; capacity: number | null; active: number; version: string; host: string;
  isolation: 'user' | 'sandbox' | 'none'; terminal: boolean; firstSeen: number | null; lastSeen: number | null;
  draining: boolean; disabled: boolean; local: boolean;
};
type Listing = { joinable: boolean; runners: RunnerRow[] };

export function AdminRunners({ adminApi, lang }: { adminApi: AdminApi; lang: Lang }) {
  const [data, setData] = useState<Listing>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    adminApi<Listing>('/api/admin/runners').then((r) => { setData(r); setError(undefined); }).catch((e) => setError((e as Error).message));
  }, [adminApi]);
  // Runners come and go on their own; keep the list fresh while it is open.
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const change = async (name: string, init: Parameters<AdminApi>[1]) => {
    try { setData(await adminApi<Listing>(`/api/admin/runners/${encodeURIComponent(name)}`, init)); setError(undefined); } catch (e) { setError((e as Error).message); }
  };
  const isolation = (r: RunnerRow) => (!r.terminal ? L(lang, '没有终端', 'No terminal')
    : { user: L(lang, '每次练习一个系统用户', 'One user per run'), sandbox: L(lang, '系统沙箱', 'System sandbox'), none: L(lang, '没有隔离', 'Not isolated') }[r.isolation]);
  const when = (t: number | null) => (t ? new Date(t).toLocaleString(lang === 'en' ? 'en-SG' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

  return (
    <>
      <p className="mt-5 max-w-3xl text-[13px] leading-relaxed text-label-3">
        {L(lang, '练习在沙箱机上运行：工作区、终端、扮演客户方的进程和评分都在那台机器上，一次练习从头到尾不换机器。沙箱机主动连到本站，所以可以在任何能访问本站的网络里；它们不持有数据库、对象存储和模型密钥。',
          'Runs happen on runners: the workspace, the terminal, the processes that play the customer’s people and the grading are all on that machine, and a run stays on it from start to finish. A runner connects to the site, so it can be on any network that reaches it; it holds no database, object storage or model key.')}
        {data && !data.joinable && L(lang, ' 现在还不能加入新的沙箱机：给本站设置 FDEGYM_RUNNER_TOKEN 后重启，再用同一个令牌启动沙箱机。', ' No runner can join yet: set FDEGYM_RUNNER_TOKEN on the site and restart it, then start runners with the same token.')}
      </p>
      {error && <p className="mt-4 rounded-lg bg-bad/10 px-4 py-3 text-sm text-bad">{error}</p>}
      <Card padded={false} className="mt-4 overflow-hidden">
        {data && !data.runners.length ? <Empty>{L(lang, '还没有沙箱机。', 'No runners yet.')}</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-divider text-left text-xs text-label-3">
                  <th className="h-10 w-[30%] pl-5 font-medium">{L(lang, '沙箱机', 'Runner')}</th>
                  <th className="h-10 px-3 font-medium">{L(lang, '状态', 'Status')}</th>
                  <th className="h-10 px-3 text-right font-medium">{L(lang, '进行中 / 容量', 'Under way / room')}</th>
                  <th className="h-10 px-3 font-medium">{L(lang, '命令的隔离', 'Commands')}</th>
                  <th className="h-10 px-3 font-medium">{L(lang, '最近在线', 'Last seen')}</th>
                  <th className="h-10 pr-5 pl-3"><span className="sr-only">{L(lang, '操作', 'Actions')}</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divider">
                {(data?.runners ?? []).map((r) => (
                  <tr key={r.name} className="h-12">
                    <td className="max-w-0 py-2 pr-3 pl-5">
                      <p className="truncate font-medium">{r.local ? L(lang, '本站自己', 'This site itself') : r.name}</p>
                      <p className="truncate font-mono text-xs text-label-3">{r.host}{r.version && ` · harness ${r.version}`}</p>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {r.disabled ? <Pill tone="bad">{L(lang, '已停用', 'Disabled')}</Pill>
                        : !r.online ? <Pill>{L(lang, '离线', 'Offline')}</Pill>
                        : r.draining ? <Pill tone="warn">{L(lang, '排空中', 'Draining')}</Pill>
                        : <Pill tone="ok">{L(lang, '在线', 'Online')}</Pill>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.active}<span className="text-label-3"> / {r.capacity ?? '∞'}</span></td>
                    <td className={`px-3 py-2 whitespace-nowrap ${r.terminal && r.isolation === 'none' ? 'text-bad' : 'text-label-2'}`}>{isolation(r)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-label-2 tabular-nums">{r.online ? L(lang, '现在', 'Now') : when(r.lastSeen)}</td>
                    <td className="py-2 pr-5 pl-3 text-right whitespace-nowrap">
                      {!r.local && (
                        <>
                          {!r.disabled && <Button size="sm" tone="ghost" onClick={() => void change(r.name, { method: 'PATCH', json: { draining: !r.draining } })}>{r.draining ? L(lang, '恢复接单', 'Resume') : L(lang, '排空', 'Drain')}</Button>}
                          <Button size="sm" tone="ghost" onClick={() => void change(r.name, { method: 'PATCH', json: { disabled: !r.disabled } })}>{r.disabled ? L(lang, '启用', 'Enable') : L(lang, '停用', 'Disable')}</Button>
                          {!r.online && <Button size="sm" tone="ghost" onClick={() => void change(r.name, { method: 'DELETE' })}>{L(lang, '移除', 'Remove')}</Button>}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-3 text-xs leading-relaxed text-label-3">
        {L(lang, '排空：不再给它派新的练习，已有的照常做完，适合下线维护之前用。停用：不让它连接。移除一台离线的沙箱机后，它上面的练习记录还在，但工作区打不开了。',
          'Drain: no new runs go there and the ones under way carry on; use it before taking a machine down. Disable: it may not connect. After an offline runner is removed, its runs stay on record but their workspaces can no longer be opened.')}
      </p>
    </>
  );
}
