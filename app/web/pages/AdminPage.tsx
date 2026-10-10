/**
 * Maintainer console: the dashboard, the case library, the machines that run cases, members, the coding agent and mail. Open to admin
 * accounts, or with the server's FDEGYM_ADMIN_TOKEN, which is kept in this tab only (sessionStorage)
 * and sent as a bearer token. The current tab is in the URL (?tab=cases).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Difficulty } from '@/components/ui';
import { AdminLogin } from '@/components/AdminLogin';
import { Modal } from '@/components/Modal';
import { Button, Card, container, Empty, PageHeader, Pill, Tabs } from '@/components/ui';
import { useAdminToken, type AdminApi } from '@/lib/admin';
import { L, useLang, type Lang } from '@/lib/i18n';
import { AdminDashboard } from './admin/Dashboard';
import { AdminAgent } from './admin/AgentSettings';
import { AdminMail } from './admin/Mail';
import { AdminRunners } from './admin/Runners';
import { AdminUsers } from './admin/Users';
import { useMe } from '@/lib/me';
import { score } from '@/lib/score';

type Tab = 'dashboard' | 'cases' | 'runners' | 'users' | 'agent' | 'mail';
const TABS: Tab[] = ['dashboard', 'cases', 'runners', 'users', 'agent', 'mail'];

export function AdminPage() {
  const { lang } = useLang();
  const { token, signIn, signOut, adminApi } = useAdminToken();
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? params.get('tab') as Tab : 'dashboard';
  const setTab = (t: Tab) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (t === 'dashboard') next.delete('tab'); else next.set('tab', t);
    return next;
  }, { replace: true });

  const me = useMe();
  const adminAccount = me?.user?.role === 'admin';
  if (me === undefined) return null;
  // Admin accounts come straight in; otherwise the maintainer token (first set-up, scripts).
  if (!adminAccount && !token) return <AdminLogin onSubmit={signIn} />;

  return (
    <div className={container}>
      <PageHeader
        title={L(lang, '管理后台', 'Admin')}
        actions={token ? <Button size="sm" tone="ghost" onClick={signOut}>{L(lang, '退出口令', 'Forget token')}</Button> : undefined}
      />
      <Tabs
        className="mt-6"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'dashboard', label: L(lang, '数据看板', 'Dashboard') },
          { value: 'cases', label: L(lang, '题目管理', 'Cases') },
          { value: 'runners', label: L(lang, '沙箱机', 'Runners') },
          { value: 'users', label: L(lang, '用户管理', 'Users') },
          { value: 'agent', label: L(lang, '助手', 'Agent') },
          { value: 'mail', label: L(lang, '邮件服务', 'Mail') },
        ]}
      />
      {tab === 'dashboard' && <AdminDashboard adminApi={adminApi} lang={lang} />}
      {tab === 'cases' && <AdminCasesTab adminApi={adminApi} lang={lang} />}
      {tab === 'runners' && <AdminRunners adminApi={adminApi} lang={lang} />}
      {tab === 'users' && <AdminUsers adminApi={adminApi} lang={lang} />}
      {tab === 'agent' && <AdminAgent adminApi={adminApi} lang={lang} />}
      {tab === 'mail' && <AdminMail adminApi={adminApi} lang={lang} />}
    </div>
  );
}

/**
 * The library as it is kept: a case's listing in the database and its files, as one archive, in
 * object storage. Here an admin adds a case or replaces its files, files it (organisation, sector,
 * region, difficulty), pauses it or takes it out.
 */
type CaseRow = {
  id: string; title: string; org: string; sector: string; region: string; difficulty: string; hidden: boolean;
  versions: number; bundle: string; bytes: number; updatedAt: number;
  started: number; graded: number; avgNet: number | null;
};
type Filing = { org: string; sector: string; region: string; difficulty: string };

function AdminCasesTab({ adminApi, lang }: { adminApi: AdminApi; lang: Lang }) {
  const [rows, setRows] = useState<CaseRow[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [saving, setSaving] = useState<string>();
  const [editing, setEditing] = useState<CaseRow>();
  const [filing, setFiling] = useState<Filing>({ org: '', sector: '', region: '', difficulty: '' });
  const [removing, setRemoving] = useState<CaseRow>();
  const picker = useRef<HTMLInputElement>(null);
  const load = useCallback(() => {
    adminApi<CaseRow[]>('/api/admin/cases').then((r) => { setRows(r); setError(undefined); }).catch((e) => setError((e as Error).message));
  }, [adminApi]);
  useEffect(load, [load]);

  const fail = (e: unknown) => { setError((e as Error).message); setNotice(undefined); };
  const replace = (next: CaseRow) => setRows((rs) => rs?.map((x) => (x.id === next.id ? next : x)));

  async function toggle(r: CaseRow) {
    setSaving(r.id);
    try { replace(await adminApi<CaseRow>(`/api/admin/cases/${r.id}`, { method: 'PATCH', json: { hidden: !r.hidden } })); setError(undefined); } catch (e) { fail(e); }
    setSaving(undefined);
  }

  /** A case arrives as a .tar.gz of its folder; the same id again replaces that case's files. */
  async function upload(file: File) {
    setSaving('upload');
    try {
      const r = await adminApi<{ id: string; outcome: 'added' | 'updated' | 'unchanged' }>('/api/admin/cases/import', { method: 'POST', body: file, headers: { 'content-type': 'application/gzip' } });
      setNotice({
        added: L(lang, `已添加 ${r.id}。`, `Added ${r.id}.`),
        updated: L(lang, `已更新 ${r.id} 的文件。进行中的练习仍用开始时的版本。`, `Replaced the files of ${r.id}. Runs under way stay on the version they started on.`),
        unchanged: L(lang, `${r.id} 的文件和库里的一样，没有变化。`, `${r.id} is the same as what the library holds; nothing changed.`),
      }[r.outcome]);
      setError(undefined);
      load();
    } catch (e) { fail(e); }
    setSaving(undefined);
    if (picker.current) picker.current.value = '';
  }

  async function saveFiling() {
    if (!editing) return;
    try { replace(await adminApi<CaseRow>(`/api/admin/cases/${editing.id}`, { method: 'PATCH', json: filing })); setEditing(undefined); setError(undefined); } catch (e) { fail(e); }
  }

  async function remove() {
    if (!removing) return;
    try { await adminApi(`/api/admin/cases/${removing.id}`, { method: 'DELETE' }); setRows((rs) => rs?.filter((x) => x.id !== removing.id)); setRemoving(undefined); setError(undefined); } catch (e) { fail(e); }
  }

  const difficulties = [['beginner', L(lang, '简单', 'Easy')], ['intermediate', L(lang, '中等', 'Medium')], ['advanced', L(lang, '困难', 'Hard')]] as const;

  return (
    <>
      <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-3xl text-[13px] leading-relaxed text-label-3">
          {L(lang, '题目的信息存在数据库里，题目的文件打成一个包存在对象存储里。上传一道题的文件夹压成的 .tar.gz 就能添加；id 相同则替换文件。暂停的题不能开始新的练习，已经开始的可以做完。',
            'A case’s listing is kept in the database and its files, as one archive, in object storage. Upload a .tar.gz of a case’s folder to add it; the same id again replaces its files. A paused case cannot be started, but runs already under way can finish.')}
        </p>
        <input ref={picker} type="file" accept=".tar.gz,.tgz,application/gzip" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        <Button size="sm" disabled={saving === 'upload'} onClick={() => picker.current?.click()}>
          {saving === 'upload' ? L(lang, '正在导入……', 'Importing…') : L(lang, '上传题目', 'Upload a case')}
        </Button>
      </div>
      {error && <p className="mt-4 rounded-lg bg-bad/10 px-4 py-3 text-sm text-bad">{error}</p>}
      {notice && !error && <p className="mt-4 rounded-lg bg-ok/10 px-4 py-3 text-sm text-ok">{notice}</p>}
      <Card padded={false} className="mt-4 overflow-hidden">
        {rows && !rows.length ? <Empty>{L(lang, '题库里还没有题目。上传一道，或者在服务器上运行 pnpm cases import。', 'The library has no cases yet. Upload one, or run pnpm cases import on the server.')}</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-divider text-left text-xs text-label-3">
                  <th className="h-10 w-[34%] pl-5 font-medium">{L(lang, '题目', 'Case')}</th>
                  <th className="h-10 px-3 font-medium">{L(lang, '行业', 'Sector')}</th>
                  <th className="h-10 px-3 font-medium">{L(lang, '难度', 'Difficulty')}</th>
                  <th className="h-10 px-3 font-medium">{L(lang, '文件版本', 'Files')}</th>
                  <th className="h-10 px-3 text-right font-medium">{L(lang, '练习', 'Runs')}</th>
                  <th className="h-10 px-3 text-right font-medium">{L(lang, '平均得分', 'Mean score')}</th>
                  <th className="h-10 px-3 text-right font-medium">{L(lang, '开放', 'On offer')}</th>
                  <th className="h-10 pr-5 pl-3"><span className="sr-only">{L(lang, '操作', 'Actions')}</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divider">
                {(rows ?? []).map((r) => (
                  <tr key={r.id} className="h-12">
                    <td className="max-w-0 py-2 pr-3 pl-5">
                      <Link to={`/cases/${r.id}`} className="block truncate font-medium text-label-1 hover:text-link" title={r.title}>{r.title}</Link>
                      <p className="truncate font-mono text-xs text-label-3">{r.id}{r.versions > 1 && <span> · {L(lang, `${r.versions} 道题`, `${r.versions} cases`)}</span>}</p>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-label-2">{r.sector}{r.region && <span className="text-label-3"> · {r.region}</span>}</td>
                    <td className="px-3 py-2"><Difficulty level={r.difficulty} lang={lang} /></td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="font-mono text-xs text-label-2">{r.bundle}</span>
                      <p className="text-xs text-label-3">{new Date(r.updatedAt).toLocaleDateString(lang === 'en' ? 'en-SG' : 'zh-CN')}{r.bytes > 0 && ` · ${Math.max(1, Math.round(r.bytes / 1024))} KB`}</p>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.started}<span className="text-label-3"> / {r.graded}</span></td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.avgNet === null ? <span className="text-label-4">—</span> : score(r.avgNet)}</td>
                    <td className="px-3 py-2 text-right">
                      <span className="inline-flex items-center gap-2">
                        {r.hidden && <Pill tone="warn">{L(lang, '已暂停', 'Paused')}</Pill>}
                        <button type="button" role="switch" aria-checked={!r.hidden} aria-label={L(lang, '开放', 'On offer')} disabled={saving === r.id} onClick={() => void toggle(r)}
                          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${r.hidden ? 'bg-fill-1' : 'bg-brand'}`}>
                          <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-layer-0 shadow transition-transform ${r.hidden ? '' : 'translate-x-5'}`} />
                        </button>
                      </span>
                    </td>
                    <td className="py-2 pr-5 pl-3 text-right whitespace-nowrap">
                      <Button size="sm" tone="ghost" onClick={() => { setFiling({ org: r.org, sector: r.sector, region: r.region, difficulty: r.difficulty }); setEditing(r); }}>{L(lang, '编辑', 'Edit')}</Button>
                      <Button size="sm" tone="ghost" onClick={() => setRemoving(r)}>{L(lang, '移除', 'Remove')}</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <Modal lang={lang} title={L(lang, `编辑 ${editing.id}`, `Edit ${editing.id}`)} onClose={() => setEditing(undefined)}
          actions={<><Button size="sm" tone="ghost" onClick={() => setEditing(undefined)}>{L(lang, '取消', 'Cancel')}</Button><Button size="sm" onClick={() => void saveFiling()}>{L(lang, '保存', 'Save')}</Button></>}>
          <p className="text-[13px] leading-relaxed text-label-3">{L(lang, '题目怎么归类。题面、人物和题数来自题目的文件，要改就重新上传。', 'How the case is filed. Its ask, its people and its number of cases come from its files; upload them again to change those.')}</p>
          {([['org', L(lang, '公司', 'Organisation')], ['sector', L(lang, '行业', 'Sector')], ['region', L(lang, '地区（CN、SG、US……）', 'Region (CN, SG, US…)')]] as const).map(([k, label]) => (
            <label key={k} className="block">
              <span className="field-label">{label}</span>
              <input value={filing[k]} maxLength={120} onChange={(e) => setFiling({ ...filing, [k]: e.target.value })} className="field" />
            </label>
          ))}
          <label className="block">
            <span className="field-label">{L(lang, '难度', 'Difficulty')}</span>
            <select value={filing.difficulty} onChange={(e) => setFiling({ ...filing, difficulty: e.target.value })} className="field">
              <option value="">{L(lang, '未定', 'Not set')}</option>
              {difficulties.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </label>
        </Modal>
      )}
      {removing && (
        <Modal lang={lang} title={L(lang, '移除这道题', 'Remove this case')} onClose={() => setRemoving(undefined)}
          actions={<><Button size="sm" tone="ghost" onClick={() => setRemoving(undefined)}>{L(lang, '先留着', 'Keep it')}</Button><Button size="sm" tone="secondary" onClick={() => void remove()}>{L(lang, '移除', 'Remove')}</Button></>}>
          <p className="text-sm leading-relaxed text-label-2">
            <span className="font-medium text-label-1">{removing.title}</span>
            {L(lang, '：从题库里移除后，没有人能再开始它，它也不再计入进度和排行榜。已有的练习记录保留，对象存储里的文件不会删除。只想暂时不开放，用「开放」开关就行。',
              ': once removed, nobody can start it and it no longer counts in progress or on the leaderboard. Runs already made are kept, and its files stay in object storage. To take it off offer for a while, use the switch instead.')}
          </p>
        </Modal>
      )}
    </>
  );
}
