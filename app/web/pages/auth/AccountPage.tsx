import { useState, type ReactNode } from 'react';
import { Navigate } from 'react-router';
import { Button, container, Loading, PageHeader } from '@/components/ui';
import { api } from '@/lib/client';
import { L, useLang } from '@/lib/i18n';
import { refreshMe, useMe, type Account } from '@/lib/me';
import { Field, FormError, FormNotice, passwordProblem, passwordRule } from './shared';

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="card p-5 sm:p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      {sub && <p className="mt-1 text-[13px] text-label-3">{sub}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function AccountPage() {
  const { lang } = useLang();
  const me = useMe();
  if (me === undefined) return <Loading label={L(lang, '加载中……', 'Loading…')} />;
  if (!me.user) return <Navigate to="/login?next=%2Faccount" replace />;
  return (
    <div className={container}>
      <div className="mx-auto max-w-[640px]">
        <PageHeader title={L(lang, '账号设置', 'Account settings')} sub={me.user.email} />
        <div className="mt-6 space-y-6">
          <ProfileForm key={me.user.id} user={me.user} />
          <PasswordForm />
        </div>
      </div>
    </div>
  );
}

function ProfileForm({ user }: { user: Account }) {
  const { lang } = useLang();
  const [name, setName] = useState(user.name);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const dirty = name.trim() !== user.name;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await api('/api/account', { method: 'PATCH', json: { name } });
      await refreshMe();
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title={L(lang, '基本资料', 'Profile')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={L(lang, '邮箱', 'Email')} value={user.email} disabled readOnly hint={L(lang, '邮箱暂不支持修改', 'Email can’t be changed yet')} />
        <Field label={L(lang, '名字', 'Name')} required maxLength={40} value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }}
          hint={L(lang, '显示在提交记录和排行榜上', 'Shown on your submissions and on the leaderboard')} />
        <FormError>{error}</FormError>
        {saved && <FormNotice>{L(lang, '已保存。', 'Saved.')}</FormNotice>}
        <div className="flex justify-end">
          <Button type="submit" disabled={busy || !dirty || !name.trim()}>{busy ? L(lang, '正在保存……', 'Saving…') : L(lang, '保存', 'Save')}</Button>
        </div>
      </form>
    </Section>
  );
}

function PasswordForm() {
  const { lang } = useLang();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const pwProblem = passwordProblem(next, lang);
  const mismatch = again !== next;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    setSaved(false);
    if (pwProblem || mismatch) return;
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/account/password', { method: 'POST', json: { current, next } });
      setSaved(true);
      setCurrent(''); setNext(''); setAgain(''); setTried(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title={L(lang, '修改密码', 'Change password')} sub={L(lang, '改完后，其他设备上的登录会失效', 'Other devices will be signed out')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={L(lang, '当前密码', 'Current password')} type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        <Field label={L(lang, '新密码', 'New password')} type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)}
          invalid={tried && !!pwProblem} hint={tried && pwProblem ? pwProblem : passwordRule(lang)} />
        <Field label={L(lang, '再输入一次新密码', 'Repeat new password')} type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)}
          invalid={tried && !pwProblem && mismatch} hint={tried && !pwProblem && mismatch ? L(lang, '两次输入的密码不一样', 'The passwords don’t match') : undefined} />
        <FormError>{error}</FormError>
        {saved && <FormNotice>{L(lang, '密码已更新，其他设备上的登录已失效。', 'Password updated. Other devices have been signed out.')}</FormNotice>}
        <div className="flex justify-end">
          <Button type="submit" disabled={busy}>{busy ? L(lang, '正在保存……', 'Saving…') : L(lang, '更新密码', 'Update password')}</Button>
        </div>
      </form>
    </Section>
  );
}
