import { useState } from 'react';
import { useAuth } from '@/components/auth/AuthDialog';
import { api } from '@/lib/client';
import { Button, Card, container } from '@/components/ui';
import { L, useLang } from '@/lib/i18n';
import { refreshMe, useMe } from '@/lib/me';

/** Token form shown until the maintainer has entered the admin token. */
export function AdminLogin({ onSubmit, title }: { onSubmit: (token: string) => void; title?: string }) {
  const { lang } = useLang();
  const [draft, setDraft] = useState('');
  const me = useMe();
  const auth = useAuth();
  const wrongAccount = !!me?.user && me.user.role !== 'admin';
  // Signed in without admin rights: sign out, then sign in again with an admin account.
  const switchAccount = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    await refreshMe();
    auth.open('login');
  };
  return (
    <div className={`${container} flex justify-center py-8 lg:py-16`}>
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-center text-lg font-semibold">{title ?? L(lang, '管理后台', 'Admin')}</h1>
        {wrongAccount ? (
          <p className="mt-4 rounded-md bg-fill-4 px-3 py-2.5 text-[13px] leading-relaxed text-label-2">
            {L(lang, `当前登录的账号 ${me!.user!.email} 不是管理员。`, `The signed-in account ${me!.user!.email} is not an admin.`)}
          </p>
        ) : (
          <p className="mt-1.5 text-center text-sm text-label-3">{L(lang, '用管理员账号登录后进入', 'Sign in with an admin account to continue')}</p>
        )}
        {wrongAccount
          ? <Button type="button" size="lg" className="mt-5 w-full" onClick={() => void switchAccount()}>{L(lang, '退出，改用管理员账号登录', 'Sign out and use an admin account')}</Button>
          : <Button type="button" size="lg" className="mt-5 w-full" onClick={() => auth.open('login')}>{L(lang, '用管理员账号登录', 'Sign in as admin')}</Button>}
        <div className="my-5 flex items-center gap-3 text-xs text-label-4">
          <span className="h-px flex-1 bg-divider" />{L(lang, '或者使用管理员口令', 'or use the admin token')}<span className="h-px flex-1 bg-divider" />
        </div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); onSubmit(draft); }}>
          <input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} className="field min-w-0 flex-1" placeholder={L(lang, '管理员口令', 'Admin token')} autoComplete="off" aria-label={L(lang, '管理员口令', 'Admin token')} />
          <Button type="submit" tone="secondary" disabled={!draft}>{L(lang, '进入', 'Enter')}</Button>
        </form>
      </Card>
    </div>
  );
}
