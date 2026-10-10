/**
 * Member management: a searchable member table in the LeetCode manner, with a "⋯" menu per row
 * (details, admin role, ban/restore, set a new password), a dialog to add a member, and a CSV
 * export. Server errors (e.g. "至少要保留一个管理员") are shown as they come back.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { Modal } from '@/components/Modal';
import { Button, Cross, Empty, Pill } from '@/components/ui';
import { downloadCsv, useAdminToken, type AdminApi } from '@/lib/admin';
import { L, type Lang } from '@/lib/i18n';
import { useMe } from '@/lib/me';

type Role = 'user' | 'admin';
type Status = 'active' | 'banned';
type UserRow = {
  id: string; email: string; name: string; role: Role; status: Status; createdAt: number; lastLoginAt: number | null;
  runs: number; graded: number; avgRate: number | null; lastRunAt: number | null;
};
type RunRow = {
  runId: string; caseId: string; title: string; startedAt: number; status: string; totalScore: number | null; rate: number | null;
  grading?: 'running' | 'done' | 'failed';
  /** The variant's real name and what it changes (admins only). */
  variant?: string; angle?: string | null;
};
type Detail = { user: Omit<UserRow, 'runs' | 'graded' | 'avgRate' | 'lastRunAt'> & { claimed: number }; runs: RunRow[] };

type Dialog = { kind: 'create' } | { kind: 'ban'; user: UserRow } | { kind: 'password'; user: UserRow };

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const locale = (lang: Lang) => (lang === 'en' ? 'en-SG' : 'zh-CN');
const fmtDate = (t: number, lang: Lang) => new Date(t).toLocaleDateString(locale(lang), { year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtTime = (t: number, lang: Lang) => new Date(t).toLocaleString(locale(lang), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function ago(t: number, lang: Lang) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return L(lang, '刚刚', 'just now');
  if (s < 3600) { const m = Math.floor(s / 60); return L(lang, `${m} 分钟前`, `${m} min ago`); }
  if (s < 86400) { const h = Math.floor(s / 3600); return L(lang, `${h} 小时前`, `${h} h ago`); }
  if (s < 30 * 86400) { const d = Math.floor(s / 86400); return L(lang, `${d} 天前`, `${d} d ago`); }
  return fmtDate(t, lang);
}

function RolePill({ role, lang }: { role: Role; lang: Lang }) {
  return role === 'admin' ? <Pill tone="brand">{L(lang, '管理员', 'Admin')}</Pill> : <Pill>{L(lang, '成员', 'Member')}</Pill>;
}

function StatusPill({ status, lang }: { status: Status; lang: Lang }) {
  return status === 'banned'
    ? <span className="inline-flex items-center rounded-full bg-bad/10 px-2.5 py-0.5 text-xs whitespace-nowrap text-bad">{L(lang, '已停用', 'Banned')}</span>
    : <Pill tone="ok">{L(lang, '正常', 'Active')}</Pill>;
}

function RunStatus({ r, lang }: { r: RunRow; lang: Lang }) {
  if (r.grading === 'done') return <Pill tone="ok">{L(lang, '已评分', 'Graded')}</Pill>;
  if (r.grading === 'running') return <Pill tone="warn">{L(lang, '评分中', 'Grading')}</Pill>;
  if (r.grading === 'failed') return <span className="inline-flex items-center rounded-full bg-bad/10 px-2.5 py-0.5 text-xs whitespace-nowrap text-bad">{L(lang, '评分失败', 'Grading failed')}</span>;
  return <Pill>{L(lang, '进行中', 'In progress')}</Pill>;
}

function Banner({ tone, children, onClose }: { tone: 'bad' | 'ok'; children: ReactNode; onClose: () => void }) {
  return (
    <div className={`mt-4 flex items-start justify-between gap-3 rounded-lg px-4 py-3 text-sm ${tone === 'bad' ? 'bg-bad/10 text-bad' : 'bg-ok/10 text-ok'}`}>
      <p>{children}</p>
      <button type="button" onClick={onClose} aria-label="Close" className="grid size-5 shrink-0 place-items-center opacity-60 hover:opacity-100"><Cross /></button>
    </div>
  );
}

export function AdminUsers({ adminApi, lang }: { adminApi: AdminApi; lang: Lang }) {
  const { token } = useAdminToken();
  const selfId = useMe()?.user?.id;
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<UserRow[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [dialog, setDialog] = useState<Dialog>();
  const [detailId, setDetailId] = useState<string>();
  const [detailKey, setDetailKey] = useState(0);
  const [busy, setBusy] = useState<string>();

  // Debounce the search box.
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  const load = useCallback(() => {
    setLoading(true);
    adminApi<UserRow[]>(`/api/admin/users${query ? `?q=${encodeURIComponent(query)}` : ''}`)
      .then((r) => { setRows(r); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [adminApi, query]);
  useEffect(load, [load]);

  /** After a change: refresh the list and the open detail view. */
  const changed = useCallback((message: string) => {
    setNotice(message); setError(undefined); load(); setDetailKey((k) => k + 1);
  }, [load]);

  async function patch(u: UserRow, change: { role?: Role; status?: Status }, message: string) {
    setBusy(u.id);
    try { await adminApi(`/api/admin/users/${u.id}`, { method: 'PATCH', json: change }); changed(message); return true; }
    catch (e) { setError((e as Error).message); setNotice(undefined); return false; }
    finally { setBusy(undefined); }
  }

  async function exportCsv() {
    try { await downloadCsv('/api/admin/export/users.csv', 'fde-gym-users.csv', token); }
    catch (e) { setError((e as Error).message); }
  }

  const who = (u: UserRow) => u.name || u.email;
  const th = 'h-10 px-3 font-medium whitespace-nowrap';

  return (
    <>
      <RegistrationCard adminApi={adminApi} lang={lang} />
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="relative block min-w-0 sm:w-80">
          <span className="sr-only">{L(lang, '搜索成员', 'Search members')}</span>
          <svg viewBox="0 0 16 16" aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-label-3">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} className="field pl-8" placeholder={L(lang, '搜索名字或邮箱', 'Search name or email')} />
          {loading && rows && <span className="absolute top-1/2 right-3 size-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-fill-1 border-t-label-3" />}
        </label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" tone="outline" onClick={() => void exportCsv()}>{L(lang, '导出 CSV', 'Export CSV')}</Button>
          <Button size="sm" onClick={() => setDialog({ kind: 'create' })}>+ {L(lang, '新建成员', 'Add member')}</Button>
        </div>
      </div>

      {error && <Banner tone="bad" onClose={() => setError(undefined)}>{error}</Banner>}
      {notice && !error && <Banner tone="ok" onClose={() => setNotice(undefined)}>{notice}</Banner>}

      <div className="card mt-4 overflow-hidden">
        {!rows ? (
          <div className="flex items-center gap-2 px-5 py-16 text-label-3"><span className="size-4 animate-spin rounded-full border-2 border-fill-1 border-t-label-3" />{L(lang, '加载中……', 'Loading…')}</div>
        ) : rows.length ? (
          <div className="overflow-x-auto">
            <table className={`w-full min-w-[900px] text-sm transition-opacity ${loading ? 'opacity-60' : ''}`}>
              <thead>
                <tr className="border-b border-divider text-left text-xs text-label-3">
                  <th className={`${th} pl-5`}>{L(lang, '成员', 'Member')}</th>
                  <th className={th}>{L(lang, '角色', 'Role')}</th>
                  <th className={th}>{L(lang, '状态', 'Status')}</th>
                  <th className={th}>{L(lang, '注册时间', 'Joined')}</th>
                  <th className={th}>{L(lang, '最近登录', 'Last sign-in')}</th>
                  <th className={`${th} text-right`}>{L(lang, '练习数', 'Runs')}</th>
                  <th className={`${th} text-right`}>{L(lang, '已评分', 'Graded')}</th>
                  <th className={`${th} text-right`}>{L(lang, '平均得分率', 'Mean score')}</th>
                  <th className={`${th} w-14 pr-5 text-right`}><span className="sr-only">{L(lang, '操作', 'Actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => {
                  const self = u.id === selfId;
                  return (
                    <tr key={u.id} onClick={() => setDetailId(u.id)} className={`group h-11 cursor-pointer transition-colors even:bg-fill-4 hover:bg-fill-3 ${u.status === 'banned' ? 'text-label-3' : ''}`}>
                      <td className="max-w-[300px] py-2 pr-3 pl-5">
                        <p className="truncate font-medium group-hover:text-link">
                          {u.name || <span className="text-label-3">{L(lang, '（未填名字）', '(no name)')}</span>}
                          {self && <span className="ml-1.5 text-xs font-normal text-label-3">{L(lang, '（你）', '(you)')}</span>}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-label-3">{u.email}</p>
                      </td>
                      <td className="px-3 py-2"><RolePill role={u.role} lang={lang} /></td>
                      <td className="px-3 py-2"><StatusPill status={u.status} lang={lang} /></td>
                      <td className="px-3 py-2 whitespace-nowrap text-label-2 tabular-nums" title={fmtTime(u.createdAt, lang)}>{fmtDate(u.createdAt, lang)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-label-2" title={u.lastLoginAt ? fmtTime(u.lastLoginAt, lang) : undefined}>
                        {u.lastLoginAt ? ago(u.lastLoginAt, lang) : <span className="text-label-4">{L(lang, '从未', 'Never')}</span>}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${u.runs ? '' : 'text-label-4'}`}>{u.runs}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${u.graded ? '' : 'text-label-4'}`}>{u.graded}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${u.avgRate === null ? 'text-label-4' : ''}`}>{pct(u.avgRate)}</td>
                      <td className="py-2 pr-5 pl-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <RowMenu lang={lang} disabled={busy === u.id} label={L(lang, `${who(u)} 的操作`, `Actions for ${who(u)}`)} items={[
                          { label: L(lang, '查看详情', 'View details'), onClick: () => setDetailId(u.id) },
                          u.role === 'admin'
                            ? { label: L(lang, '取消管理员', 'Remove admin'), disabled: self, hint: self ? L(lang, '不能取消自己', 'Not yourself') : undefined,
                                onClick: () => void patch(u, { role: 'user' }, L(lang, `已取消 ${who(u)} 的管理员身份`, `${who(u)} is no longer an admin`)) }
                            : { label: L(lang, '设为管理员', 'Make admin'),
                                onClick: () => void patch(u, { role: 'admin' }, L(lang, `已将 ${who(u)} 设为管理员`, `${who(u)} is now an admin`)) },
                          { label: L(lang, '重置密码', 'Set password'), onClick: () => setDialog({ kind: 'password', user: u }) },
                          u.status === 'banned'
                            ? { label: L(lang, '恢复', 'Restore'), onClick: () => void patch(u, { status: 'active' }, L(lang, `已恢复 ${who(u)}`, `${who(u)} restored`)) }
                            : { label: L(lang, '停用', 'Ban'), danger: true, disabled: self, hint: self ? L(lang, '不能停用自己', 'Not yourself') : undefined,
                                onClick: () => setDialog({ kind: 'ban', user: u }) },
                        ]} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty action={query ? undefined : <Button size="sm" onClick={() => setDialog({ kind: 'create' })}>+ {L(lang, '新建成员', 'Add member')}</Button>}>
            {query ? L(lang, `没有匹配“${query}”的成员。`, `No members match "${query}".`) : L(lang, '还没有注册成员。', 'No members yet.')}
          </Empty>
        )}
      </div>
      {rows && <p className="mt-3 text-xs text-label-3">
        {query ? L(lang, `找到 ${rows.length} 个成员。`, `${rows.length} found.`) : L(lang, `共 ${rows.length} 个成员。`, `${rows.length} members.`)}
        {' '}{L(lang, '练习数包括成员登录时认领的匿名练习。', 'Runs include anonymous practice claimed when the member signed in.')}
      </p>}

      {dialog?.kind === 'create' && (
        <CreateDialog adminApi={adminApi} lang={lang} onClose={() => setDialog(undefined)}
          onDone={(email) => { setDialog(undefined); changed(L(lang, `已创建成员 ${email}`, `Added ${email}`)); }} />
      )}
      {dialog?.kind === 'password' && (
        <PasswordDialog adminApi={adminApi} lang={lang} user={dialog.user} onClose={() => setDialog(undefined)}
          onDone={() => { setDialog(undefined); changed(L(lang, `已为 ${who(dialog.user)} 设置新密码，TA 已被登出`, `New password set for ${who(dialog.user)}; they were signed out`)); }} />
      )}
      {dialog?.kind === 'ban' && (
        <BanDialog lang={lang} user={dialog.user} busy={busy === dialog.user.id} onClose={() => setDialog(undefined)}
          onConfirm={async () => {
            const u = dialog.user;
            if (await patch(u, { status: 'banned' }, L(lang, `已停用 ${who(u)}`, `${who(u)} banned`))) setDialog(undefined);
            else setDialog(undefined);
          }} />
      )}
      {detailId && <DetailDrawer key={`${detailId}:${detailKey}`} adminApi={adminApi} lang={lang} id={detailId} onClose={() => setDetailId(undefined)} />}
    </>
  );
}

// ---- "⋯" menu (rendered in a portal so the table's scroll box does not clip it)

type MenuItem = { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; hint?: string };

function RowMenu({ items, label, lang, disabled }: { items: MenuItem[]; label: string; lang: Lang; disabled?: boolean }) {
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number }>();

  const close = useCallback(() => setPos(undefined), []);
  function toggle() {
    if (pos) { close(); return; }
    const r = button.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  }

  // Flip above the button when there is no room below.
  useLayoutEffect(() => {
    if (!pos || !menu.current || !button.current) return;
    const h = menu.current.offsetHeight;
    const r = button.current.getBoundingClientRect();
    if (pos.top + h > window.innerHeight - 8 && r.top - h - 4 > 8) setPos({ ...pos, top: r.top - h - 4 });
    menu.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [pos]);

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); button.current?.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const i = list.indexOf(document.activeElement as HTMLButtonElement);
        list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [pos, close]);

  return (
    <>
      <button ref={button} type="button" onClick={toggle} disabled={disabled} aria-label={label} aria-haspopup="menu" aria-expanded={!!pos}
        className={`inline-grid size-8 place-items-center rounded-md text-base leading-none text-label-3 transition-colors hover:bg-fill-2 hover:text-label-1 disabled:opacity-40 ${pos ? 'bg-fill-2 text-label-1' : ''}`}>
        ⋯
      </button>
      {pos && createPortal(
        <div ref={menu} role="menu" aria-label={label} className="menu fixed z-40 w-44 text-left" style={{ top: pos.top, right: pos.right }}>
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" disabled={it.disabled} title={it.hint}
              onClick={() => { close(); it.onClick(); }}
              className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-[13px] outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${it.danger ? 'text-bad hover:bg-bad/10 focus:bg-bad/10' : 'text-label-1 hover:bg-fill-3 focus:bg-fill-3'}`}>
              {it.label}
              {it.hint && <span className="text-[11px] text-label-3">{it.hint}</span>}
            </button>
          ))}
          <span className="sr-only">{L(lang, '按 Esc 关闭', 'Esc to close')}</span>
        </div>,
        document.body,
      )}
    </>
  );
}

// ---- dialogs

const passwordRule = (lang: Lang) => L(lang, '至少 8 位，必须同时包含字母和数字。', 'At least 8 characters, with both letters and digits.');

function ErrorLine({ message }: { message?: string }) {
  return message ? <p className="rounded-lg bg-bad/10 px-3 py-2 text-[13px] text-bad">{message}</p> : null;
}

function PasswordInput({ value, onChange, lang, autoFocus, label }: { value: string; onChange: (v: string) => void; lang: Lang; autoFocus?: boolean; label: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input type={show ? 'text' : 'password'} aria-label={label} autoComplete="new-password" autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} className="field pr-14" />
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute top-1/2 right-2 -translate-y-1/2 rounded px-1.5 py-0.5 text-xs text-label-3 hover:bg-fill-3 hover:text-label-1">
        {show ? L(lang, '隐藏', 'Hide') : L(lang, '显示', 'Show')}
      </button>
    </div>
  );
}

function CreateDialog({ adminApi, lang, onClose, onDone }: { adminApi: AdminApi; lang: Lang; onClose: () => void; onDone: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [admin, setAdmin] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await adminApi('/api/admin/users', { method: 'POST', json: { email: email.trim(), name: name.trim(), password, role: admin ? 'admin' : 'user' } });
      onDone(email.trim());
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal title={L(lang, '新建成员', 'Add member')} onClose={onClose} lang={lang}
      actions={<>
        <Button size="sm" tone="secondary" onClick={onClose}>{L(lang, '取消', 'Cancel')}</Button>
        <Button size="sm" type="submit" form="create-member" disabled={busy}>{busy ? L(lang, '创建中……', 'Adding…') : L(lang, '创建', 'Add')}</Button>
      </>}>
      <form id="create-member" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        <label className="block">
          <span className="field-label">{L(lang, '邮箱', 'Email')}</span>
          <input type="email" autoFocus required value={email} onChange={(e) => { setEmail(e.target.value); setError(undefined); }} className="field" placeholder="name@example.com" />
        </label>
        <label className="block">
          <span className="field-label">{L(lang, '名字', 'Name')}</span>
          <input required value={name} onChange={(e) => { setName(e.target.value); setError(undefined); }} className="field" />
        </label>
        <div>
          <span className="field-label">{L(lang, '初始密码', 'Initial password')}</span>
          <PasswordInput label={L(lang, '初始密码', 'Initial password')} value={password} onChange={(v) => { setPassword(v); setError(undefined); }} lang={lang} />
          <p className="mt-1.5 text-xs text-label-3">{passwordRule(lang)} {L(lang, '请自行告知成员，成员登录后可以自己修改。', 'Tell the member yourself; they can change it after signing in.')}</p>
        </div>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-fill-4 px-3 py-2.5">
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} className="mt-0.5 size-4 accent-brand" />
          <span>
            <span className="block text-[13px] font-medium">{L(lang, '设为管理员', 'Make admin')}</span>
            <span className="block text-xs text-label-3">{L(lang, '可以进入管理后台，管理题目、成员和设置。', 'Can open this console and manage cases, members and settings.')}</span>
          </span>
        </label>
        <ErrorLine message={error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function PasswordDialog({ adminApi, lang, user, onClose, onDone }: { adminApi: AdminApi; lang: Lang; user: UserRow; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try { await adminApi(`/api/admin/users/${user.id}/password`, { method: 'POST', json: { password } }); onDone(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal title={L(lang, '重置密码', 'Set a new password')} onClose={onClose} lang={lang}
      actions={<>
        <Button size="sm" tone="secondary" onClick={onClose}>{L(lang, '取消', 'Cancel')}</Button>
        <Button size="sm" type="submit" form="set-password" disabled={busy || !password}>{busy ? L(lang, '保存中……', 'Saving…') : L(lang, '设置新密码', 'Set password')}</Button>
      </>}>
      <form id="set-password" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        <p className="text-sm text-label-2">
          {L(lang, '为', 'For')} <span className="font-medium text-label-1">{user.name || user.email}</span>
          {user.name && <span className="text-label-3">（{user.email}）</span>}
        </p>
        <div>
          <span className="field-label">{L(lang, '新密码', 'New password')}</span>
          <PasswordInput label={L(lang, '新密码', 'New password')} value={password} onChange={(v) => { setPassword(v); setError(undefined); }} lang={lang} autoFocus />
          <p className="mt-1.5 text-xs text-label-3">{passwordRule(lang)}</p>
        </div>
        <p className="rounded-lg bg-warn/15 px-3 py-2 text-[13px] text-warn-text">
          {L(lang, '成员会在所有设备上被登出，需要用新密码重新登录。', 'The member will be signed out on every device and must sign in with the new password.')}
        </p>
        <ErrorLine message={error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function BanDialog({ lang, user, busy, onClose, onConfirm }: { lang: Lang; user: UserRow; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal title={L(lang, '停用成员', 'Ban member')} onClose={onClose} lang={lang}
      actions={<>
        <Button size="sm" tone="secondary" onClick={onClose}>{L(lang, '取消', 'Cancel')}</Button>
        <button type="button" disabled={busy} onClick={onConfirm}
          className="inline-flex h-8 items-center rounded-lg bg-bad/10 px-3 text-[13px] font-medium text-bad transition-colors hover:bg-bad/20 disabled:cursor-not-allowed disabled:opacity-50">
          {L(lang, '确认停用', 'Ban')}
        </button>
      </>}>
      <p className="text-sm leading-relaxed text-label-2">
        {L(lang, '确定停用', 'Ban')} <span className="font-medium text-label-1">{user.name || user.email}</span>
        {user.name && <span className="text-label-3">（{user.email}）</span>}{L(lang, '？', '?')}
      </p>
      <p className="text-sm leading-relaxed text-label-2">
        {L(lang, '停用后 TA 会立即在所有设备上被登出，也不能再登录。练习记录会保留，之后可以随时恢复。',
          'They are signed out everywhere at once and cannot sign in again. Their runs are kept, and you can restore them at any time.')}
      </p>
    </Modal>
  );
}

// ---- detail drawer

function DetailDrawer({ adminApi, lang, id, onClose }: { adminApi: AdminApi; lang: Lang; id: string; onClose: () => void }) {
  const [data, setData] = useState<Detail>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    adminApi<Detail>(`/api/admin/users/${id}`).then(setData).catch((e) => setError((e as Error).message));
  }, [adminApi, id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const u = data?.user;
  const graded = data?.runs.filter((r) => r.rate !== null) ?? [];
  const avg = graded.length ? graded.reduce((a, r) => a + r.rate!, 0) / graded.length : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-label={L(lang, '成员详情', 'Member details')}
        className="glass-thick flex h-full w-full max-w-xl flex-col bg-layer-1 shadow-menu" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-divider px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{u ? u.name || u.email : L(lang, '成员详情', 'Member details')}</h2>
            {u && <p className="mt-0.5 truncate text-xs text-label-3">{u.email}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label={L(lang, '关闭', 'Close')} className="grid size-7 shrink-0 place-items-center rounded-md text-label-3 hover:bg-fill-3 hover:text-label-1"><Cross /></button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {error && <p className="m-5 rounded-lg bg-bad/10 px-4 py-3 text-sm text-bad">{error}</p>}
          {!data && !error && <div className="flex items-center gap-2 px-5 py-16 text-label-3"><span className="size-4 animate-spin rounded-full border-2 border-fill-1 border-t-label-3" />{L(lang, '加载中……', 'Loading…')}</div>}
          {u && data && <>
            <section className="px-5 py-4">
              <div className="flex flex-wrap gap-1.5"><RolePill role={u.role} lang={lang} /><StatusPill status={u.status} lang={lang} /></div>
              <dl className="mt-4 grid grid-cols-[96px_1fr] gap-x-3 gap-y-2 text-[13px]">
                <dt className="text-label-3">{L(lang, '注册时间', 'Joined')}</dt><dd className="text-label-2 tabular-nums">{fmtTime(u.createdAt, lang)}</dd>
                <dt className="text-label-3">{L(lang, '最近登录', 'Last sign-in')}</dt><dd className="text-label-2 tabular-nums">{u.lastLoginAt ? fmtTime(u.lastLoginAt, lang) : L(lang, '从未登录', 'Never')}</dd>
                <dt className="text-label-3">{L(lang, '匿名身份', 'Anonymous IDs')}</dt>
                <dd className="text-label-2">{u.claimed ? L(lang, `认领了 ${u.claimed} 个匿名身份`, `Claimed ${u.claimed}`) : L(lang, '没有认领', 'None claimed')}</dd>
                <dt className="text-label-3">ID</dt><dd className="font-mono text-xs break-all text-label-3">{u.id}</dd>
              </dl>
              <div className="mt-4 grid grid-cols-3 gap-2">
                {[[L(lang, '练习', 'Runs'), String(data.runs.length)], [L(lang, '已评分', 'Graded'), String(graded.length)], [L(lang, '平均得分率', 'Mean score'), pct(avg)]].map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-fill-4 px-3 py-2">
                    <p className="text-xs text-label-3">{k}</p>
                    <p className="mt-0.5 text-lg font-semibold">{v}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="border-t border-divider pt-4">
              <h3 className="px-5 text-sm font-semibold">{L(lang, '练习记录', 'Runs')} <span className="font-normal text-label-3 tabular-nums">{data.runs.length}</span></h3>
              {data.runs.length ? (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[480px] text-[13px]">
                    <thead>
                      <tr className="border-b border-divider text-left text-xs text-label-3">
                        <th className="h-9 pl-5 font-medium">{L(lang, '题目', 'Case')}</th>
                        <th className="h-9 px-2 font-medium">{L(lang, '时间', 'Started')}</th>
                        <th className="h-9 px-2 font-medium">{L(lang, '状态', 'Status')}</th>
                        <th className="h-9 pr-5 pl-2 text-right font-medium">{L(lang, '得分率', 'Score')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.runs.map((r) => (
                        <tr key={r.runId} className="h-11 even:bg-fill-4">
                          <td className="max-w-[220px] py-1.5 pr-2 pl-5">
                            <Link to="/admin?tab=cases" className="block truncate text-label-1 hover:text-link" title={r.title}>{r.title}</Link>
                            <p className="truncate text-xs text-label-3" title={r.angle ?? undefined}>{r.caseId}{r.variant && r.variant !== 'base' ? ` · ${r.variant}` : ''}</p>
                          </td>
                          <td className="px-2 py-1.5 whitespace-nowrap text-label-2 tabular-nums" title={fmtTime(r.startedAt, lang)}>{ago(r.startedAt, lang)}</td>
                          <td className="px-2 py-1.5"><RunStatus r={r} lang={lang} /></td>
                          <td className={`py-1.5 pr-5 pl-2 text-right tabular-nums ${r.rate === null ? 'text-label-4' : ''}`}>{pct(r.rate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <Empty>{L(lang, '还没有练习记录。', 'No runs yet.')}</Empty>}
            </section>
          </>}
        </div>
      </aside>
    </div>
  );
}

type RegMode = 'open' | 'email' | 'closed';

/** Who may sign up: anyone, anyone with a verified e-mail, or nobody (admins create members). */
type RegState = { mode: RegMode; closedMessage: string; allowAnonymous: boolean; mailConfigured: boolean };

function RegistrationCard({ adminApi, lang }: { adminApi: AdminApi; lang: Lang }) {
  const [state, setState] = useState<RegState>();
  const [saving, setSaving] = useState<RegMode>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState('');
  const [savingMessage, setSavingMessage] = useState(false);
  const [savedMessage, setSavedMessage] = useState(false);
  useEffect(() => {
    adminApi<RegState>('/api/admin/settings/registration').then((r) => { setState(r); setMessage(r.closedMessage); }).catch((e) => setError((e as Error).message));
  }, [adminApi]);

  async function choose(mode: RegMode) {
    if (!state || mode === state.mode) return;
    setSaving(mode); setError(undefined);
    try { setState(await adminApi('/api/admin/settings/registration', { method: 'PUT', json: { mode } })); }
    catch (e) { setError((e as Error).message); }
    setSaving(undefined);
  }

  async function saveMessage() {
    setSavingMessage(true); setError(undefined); setSavedMessage(false);
    try {
      const r = await adminApi<RegState>('/api/admin/settings/registration', { method: 'PUT', json: { closedMessage: message } });
      setState(r); setMessage(r.closedMessage); setSavedMessage(true);
    } catch (e) { setError((e as Error).message); }
    setSavingMessage(false);
  }
  const messageDirty = !!state && message.trim() !== state.closedMessage;
  const [savingAnon, setSavingAnon] = useState(false);
  async function toggleAnonymous() {
    if (!state) return;
    setSavingAnon(true); setError(undefined);
    try { setState(await adminApi<RegState>('/api/admin/settings/registration', { method: 'PUT', json: { allowAnonymous: !state.allowAnonymous } })); }
    catch (e) { setError((e as Error).message); }
    setSavingAnon(false);
  }

  const options: { mode: RegMode; title: string; desc: string }[] = [
    { mode: 'open', title: L(lang, '开放注册', 'Open'), desc: L(lang, '任何人填邮箱和密码即可注册', 'Anyone can sign up with an email and password') },
    { mode: 'email', title: L(lang, '邮箱验证注册', 'Verified email'), desc: L(lang, '注册前要收邮箱验证码，确认邮箱属于本人', 'A code is emailed first to prove the address') },
    { mode: 'closed', title: L(lang, '关闭注册', 'Closed'), desc: L(lang, '不能自助注册，由管理员在下方新建成员', 'No self sign-up; create members below') },
  ];
  return (
    <section className="card mt-5 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{L(lang, '注册与访问', 'Sign-up and access')}</h2>
        <p className="text-xs text-label-3">{L(lang, '网站还没有任何账号时，第一个人总能注册并成为管理员。', 'With no accounts yet, the first person can always sign up and becomes admin.')}</p>
      </div>
      <div role="radiogroup" className="mt-4 grid gap-2 sm:grid-cols-3">
        {options.map((o) => {
          const on = state?.mode === o.mode;
          const blocked = o.mode === 'email' && state && !state.mailConfigured;
          return (
            <button key={o.mode} type="button" role="radio" aria-checked={on} disabled={!state || !!saving || !!blocked} onClick={() => void choose(o.mode)}
              className={`rounded-lg border px-3.5 py-3 text-left transition-[border-color,background-color,box-shadow] disabled:cursor-not-allowed ${on ? 'border-brand-line bg-brand-soft shadow-[0_0_0_3px_var(--color-brand-soft)]' : 'border-transparent bg-fill-4 hover:bg-fill-3'} ${blocked ? 'opacity-60' : ''}`}>
              <span className="flex items-center gap-2 text-sm font-medium">
                <span aria-hidden className={`grid size-4 place-items-center rounded-full border ${on ? 'border-brand-text' : 'border-label-4'}`}>
                  {on && <span className="size-2 rounded-full bg-brand-text" />}
                </span>
                {o.title}
                {saving === o.mode && <span className="text-xs font-normal text-label-3">{L(lang, '保存中…', 'Saving…')}</span>}
              </span>
              <span className="mt-1 block pl-6 text-xs leading-relaxed text-label-3">
                {blocked ? L(lang, '需要先在「邮件服务」里配置发信', 'Set up Mail first') : o.desc}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex items-start justify-between gap-4 border-t border-divider pt-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{L(lang, '允许不登录直接练习', 'Allow practice without an account')}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-label-3">
            {state?.allowAnonymous === false
              ? L(lang, '已关闭：没登录的人不能开始或继续练习；他们在浏览器里的旧记录会在登录后归到账号下。', 'Off: signed-out visitors can’t start or continue runs; their browser runs move to their account when they sign in.')
              : L(lang, '开启：没登录也能练习，记录只保存在访客自己的浏览器里。每次练习都会调用模型、产生费用。', 'On: anyone can practise without an account; runs stay in their browser. Every run calls the models and costs money.')}
          </p>
        </div>
        <button type="button" role="switch" aria-checked={!!state?.allowAnonymous} aria-label={L(lang, '允许不登录直接练习', 'Allow practice without an account')}
          disabled={!state || savingAnon} onClick={() => void toggleAnonymous()}
          className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${state?.allowAnonymous ? 'bg-brand' : 'bg-fill-1'}`}>
          <span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-layer-1 shadow transition-transform ${state?.allowAnonymous ? 'translate-x-5' : ''}`} />
        </button>
      </div>
      <div className="mt-4 border-t border-divider pt-4">
        <label className="block">
          <span className="field-label">{L(lang, '关闭注册时给访客的提示', 'Note shown while sign-up is closed')}</span>
          <textarea value={message} onChange={(e) => { setMessage(e.target.value); setSavedMessage(false); }} rows={2} maxLength={500}
            placeholder={L(lang, '例如：内测期间暂不开放注册，需要账号请联系 admin@example.com', 'e.g. Sign-up is invite-only during the beta — email admin@example.com for an account')}
            className="field resize-y leading-relaxed" />
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button size="sm" tone={messageDirty ? 'primary' : 'secondary'} disabled={!messageDirty || savingMessage} onClick={() => void saveMessage()}>
            {savingMessage ? L(lang, '保存中…', 'Saving…') : L(lang, '保存提示', 'Save note')}
          </Button>
          <span className="text-xs text-label-3">
            {savedMessage ? L(lang, '已保存', 'Saved')
              : L(lang, '访客在关闭注册时点「注册」会看到这段话，其中的邮箱和链接可以点击。留空则显示默认说明。', 'Visitors see this when they open sign-up while it is closed; emails and links become clickable. Leave empty for the default text.')}
          </span>
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
    </section>
  );
}
