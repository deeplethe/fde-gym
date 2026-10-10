import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, ButtonLink } from '@/components/ui';
import { api } from '@/lib/client';
import { L, useLang } from '@/lib/i18n';
import { refreshMe } from '@/lib/me';
import { AuthShell, Field, FormError, FormNotice, linkClass, passwordProblem, passwordRule } from './shared';

export function ResetPage() {
  const { lang } = useLang();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();

  const pwProblem = passwordProblem(password, lang);
  const mismatch = again !== password;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (pwProblem || mismatch) return;
    setBusy(true);
    setError(undefined);
    try {
      await api('/api/auth/reset', { method: 'POST', json: { token, password } });
      await refreshMe();
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const back = <Link to="/login" className={linkClass}>{L(lang, '返回登录', 'Back to sign in')}</Link>;

  if (!token) {
    return (
      <AuthShell title={L(lang, '重置链接不完整', 'Incomplete reset link')} footer={back}>
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-label-2">{L(lang, '这个链接缺少重置凭证。请直接点击邮件里的链接，或者重新申请一封。', 'This link is missing its reset token. Open the link from the email as is, or ask for a new one.')}</p>
          <ButtonLink to="/forgot" size="lg" className="w-full">{L(lang, '重新发送重置邮件', 'Send a new reset email')}</ButtonLink>
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell title={L(lang, '密码已重置', 'Password reset')}>
        <div className="space-y-5">
          <FormNotice>{L(lang, '新密码已生效，你已经登录。', 'Your new password is set and you’re signed in.')}</FormNotice>
          <div className="flex gap-2">
            <ButtonLink to="/me" tone="secondary" size="lg" className="flex-1">{L(lang, '我的练习', 'My runs')}</ButtonLink>
            <ButtonLink to="/cases" size="lg" className="flex-1">{L(lang, '去题库', 'Browse cases')}</ButtonLink>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={L(lang, '设置新密码', 'Set a new password')} footer={back}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={L(lang, '新密码', 'New password')} type="password" autoComplete="new-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)}
          invalid={tried && !!pwProblem} hint={tried && pwProblem ? pwProblem : passwordRule(lang)} />
        <Field label={L(lang, '再输入一次', 'Repeat new password')} type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)}
          invalid={tried && !pwProblem && mismatch} hint={tried && !pwProblem && mismatch ? L(lang, '两次输入的密码不一样', 'The passwords don’t match') : undefined} />
        <FormError>{error}</FormError>
        {error && <p className="text-xs"><Link to="/forgot" className={linkClass}>{L(lang, '重新申请重置邮件', 'Request a new reset email')}</Link></p>}
        <Button type="submit" size="lg" disabled={busy} className="w-full">
          {busy ? L(lang, '正在保存……', 'Saving…') : L(lang, '重置密码', 'Reset password')}
        </Button>
      </form>
    </AuthShell>
  );
}
