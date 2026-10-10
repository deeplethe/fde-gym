/**
 * Admin → Mail: the SMTP server used for password-reset mail. The password is stored encrypted
 * and never read back; leaving it empty keeps the stored one. "Send test mail" uses the saved
 * settings and really sends a message.
 */
import { useEffect, useId, useState } from 'react';
import { Select } from '@/components/Select';
import { Button, Card, Pill, SectionTitle } from '@/components/ui';
import type { AdminApi } from '@/lib/admin';
import { L, type Lang } from '@/lib/i18n';
import { useMe } from '@/lib/me';

type MailView = { configured: false } | { configured: true; host: string; port: number; secure: boolean; user?: string; from: string; hasPass: boolean };
interface Form { host: string; port: string; secure: boolean; user: string; pass: string; clearPass: boolean; from: string }

const toForm = (v: MailView): Form => v.configured
  ? { host: v.host, port: String(v.port), secure: v.secure, user: v.user ?? '', pass: '', clearPass: false, from: v.from }
  : { host: '', port: '465', secure: true, user: '', pass: '', clearPass: false, from: '' };

export function AdminMail({ adminApi, lang }: { adminApi: AdminApi; lang: Lang }) {
  const id = useId();
  const me = useMe();
  const [view, setView] = useState<MailView>();
  const [form, setForm] = useState<Form>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    adminApi<MailView>('/api/admin/settings/mail').then((v) => { setView(v); setForm(toForm(v)); }).catch((e) => setError((e as Error).message));
  }, [adminApi]);

  if (!view || !form) return <Card className="mt-5">{error ? <p className="text-bad">{error}</p> : <p className="text-label-3">{L(lang, '加载中……', 'Loading…')}</p>}</Card>;

  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(view));
  const set = (patch: Partial<Form>) => { setForm({ ...form, ...patch }); setSaved(false); setError(undefined); };

  async function save() {
    if (!form) return;
    const port = Number(form.port);
    if (!form.host.trim()) return setError(L(lang, '请填写 SMTP 服务器。', 'Enter the SMTP server.'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return setError(L(lang, '端口应为 1–65535 的整数。', 'Port must be a whole number from 1 to 65535.'));
    if (form.from.trim().length < 3) return setError(L(lang, '请填写发件人。', 'Enter the sender.'));
    setSaving(true); setError(undefined);
    try {
      const next = await adminApi<MailView>('/api/admin/settings/mail', {
        method: 'PUT',
        json: {
          host: form.host.trim(), port, secure: form.secure, from: form.from.trim(),
          ...(form.user.trim() ? { user: form.user.trim() } : {}),
          ...(form.pass ? { pass: form.pass } : form.clearPass ? { pass: '' } : {}),
        },
      });
      setView(next); setForm(toForm(next)); setSaved(true);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  const hasPass = view.configured && view.hasPass;

  return (
    <div className="mt-5 space-y-5">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SectionTitle className="!mb-0" sub={L(lang, '用于发送「忘记密码」的重置邮件。', 'Used to send password-reset mail.')}>
            {L(lang, 'SMTP 设置', 'SMTP settings')}
          </SectionTitle>
          {view.configured
            ? <Pill tone="ok">{L(lang, '已配置', 'Configured')}</Pill>
            : <Pill tone="warn">{L(lang, '未配置', 'Not configured')}</Pill>}
        </div>

        <div className="mt-4 rounded-lg bg-fill-4 px-4 py-3 text-[13px] leading-relaxed text-label-2">
          {L(lang, '「忘记密码」功能依赖邮件服务：未配置时，用户无法自助重置密码。另外还需要在服务器上设置环境变量 ',
            '“Forgot password” depends on this: without mail, members cannot reset their own passwords. The server also needs the environment variable ')}
          <code className="rounded bg-fill-3 px-1 py-0.5 font-mono text-xs">FDEGYM_PUBLIC_URL</code>
          {L(lang, '（网站的对外地址，如 https://gym.example.com），邮件里的重置链接会指向这个地址。',
            ' (the site’s public address, e.g. https://gym.example.com); reset links in the mail point there.')}
        </div>

        <form onSubmit={(e) => { e.preventDefault(); void save(); }} autoComplete="off" className="mt-5 grid max-w-3xl gap-4 sm:grid-cols-6">
          <label className="block sm:col-span-4">
            <span className="field-label">{L(lang, 'SMTP 服务器', 'SMTP server')}</span>
            <input value={form.host} onChange={(e) => set({ host: e.target.value })} placeholder="smtp.example.com" spellCheck={false} className="field font-mono text-[13px]" />
          </label>
          <label className="block sm:col-span-2">
            <span className="field-label">{L(lang, '端口', 'Port')}</span>
            <input value={form.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} inputMode="numeric" className="field font-mono tabular-nums" />
          </label>
          <div className="sm:col-span-3">
            <span id={`${id}-secure`} className="field-label">{L(lang, '加密方式', 'Encryption')}</span>
            <Select aria-labelledby={`${id}-secure`} value={form.secure ? 'ssl' : 'starttls'}
              onChange={(v) => set({ secure: v === 'ssl', port: v === 'ssl' ? '465' : '587' })}
              options={[
                { value: 'ssl', label: 'SSL/TLS', hint: L(lang, '一连接就加密，通常端口 465', 'Encrypted from the start, usually port 465') },
                { value: 'starttls', label: 'STARTTLS', hint: L(lang, '连接后升级加密，通常端口 587', 'Upgrades after connecting, usually port 587') },
              ]} />
          </div>
          <div className="hidden sm:col-span-3 sm:block" />
          <label className="block sm:col-span-3">
            <span className="field-label">{L(lang, '用户名', 'Username')}</span>
            <input value={form.user} onChange={(e) => set({ user: e.target.value })} placeholder={L(lang, '通常是邮箱地址', 'Usually the mail address')} spellCheck={false}
              autoComplete="off" className="field font-mono text-[13px]" />
          </label>
          <div className="sm:col-span-3">
            <label className="block">
              <span className="field-label">{L(lang, '密码', 'Password')}</span>
              <input type="password" value={form.pass} disabled={form.clearPass} autoComplete="new-password"
                onChange={(e) => set({ pass: e.target.value, ...(e.target.value ? { clearPass: false } : {}) })}
                placeholder={form.clearPass ? L(lang, '保存后清除密码', 'The password will be cleared on save') : hasPass ? L(lang, '已设置，留空表示不改', 'Set — leave empty to keep') : L(lang, '未设置', 'Not set')} className="field font-mono" />
            </label>
            {hasPass && (
              <label className="mt-2 flex items-center gap-2 text-[13px] text-label-2">
                <input type="checkbox" checked={form.clearPass} onChange={(e) => set({ clearPass: e.target.checked, ...(e.target.checked ? { pass: '' } : {}) })} className="size-4 accent-brand" />
                {L(lang, '清除密码', 'Clear the password')}
              </label>
            )}
          </div>
          <label className="block sm:col-span-6">
            <span className="field-label">{L(lang, '发件人', 'From')}</span>
            <input value={form.from} onChange={(e) => set({ from: e.target.value })} placeholder="FDE Gym <noreply@example.com>" spellCheck={false} className="field font-mono text-[13px]" />
            <span className="mt-1 block text-xs text-label-3">{L(lang, '多数邮件服务要求发件地址与登录的用户名一致或已验证。', 'Most providers require the From address to match the login or be verified.')}</span>
          </label>

          <div className="flex flex-wrap items-center justify-end gap-3 sm:col-span-6">
            <p className={`mr-auto text-sm ${error ? 'text-bad' : saved ? 'text-ok' : dirty ? 'text-brand-text' : 'text-label-3'}`}>
              {error ?? (saved ? L(lang, '已保存。', 'Saved.') : dirty ? L(lang, '有未保存的修改', 'Unsaved changes') : '')}
            </p>
            {dirty && <Button type="button" tone="ghost" onClick={() => { setForm(toForm(view)); setError(undefined); }}>{L(lang, '放弃修改', 'Discard')}</Button>}
            <Button type="submit" tone={dirty ? 'primary' : 'secondary'} disabled={!dirty || saving}>{saving ? L(lang, '保存中……', 'Saving…') : L(lang, '保存', 'Save')}</Button>
          </div>
        </form>
      </Card>

      <TestMail adminApi={adminApi} lang={lang} configured={view.configured} dirty={dirty} defaultTo={me?.user?.email ?? ''} />
    </div>
  );
}

/** Sends one real message with the saved settings. */
function TestMail({ adminApi, lang, configured, dirty, defaultTo }: { adminApi: AdminApi; lang: Lang; configured: boolean; dirty: boolean; defaultTo: string }) {
  const [to, setTo] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const value = to ?? defaultTo;

  async function send() {
    setBusy(true); setResult(undefined);
    try {
      const r = await adminApi<{ ok: boolean; to: string }>('/api/admin/settings/mail/test', { method: 'POST', json: { to: value.trim() } });
      setResult({ ok: true, message: L(lang, `已发送到 ${r.to}，请查收（可能在垃圾邮件里）。`, `Sent to ${r.to}. Check the inbox (and spam).`) });
    } catch (e) { setResult({ ok: false, message: (e as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <Card>
      <SectionTitle sub={L(lang, '用已保存的设置真实发送一封邮件，确认能收到。', 'Really sends one message with the saved settings.')}>
        {L(lang, '发送测试邮件', 'Send a test mail')}
      </SectionTitle>
      <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="flex max-w-3xl flex-wrap items-end gap-3">
        <label className="block min-w-0 flex-1 basis-64">
          <span className="field-label">{L(lang, '收件邮箱', 'To')}</span>
          <input type="email" value={value} onChange={(e) => { setTo(e.target.value); setResult(undefined); }} placeholder="you@example.com" className="field" />
        </label>
        <Button type="submit" tone="secondary" disabled={!configured || busy || !value.trim()}
          title={!configured ? L(lang, '请先保存邮件设置', 'Save the settings first') : L(lang, '会真实发送一封邮件', 'Really sends a message')}>
          {busy ? L(lang, '发送中……', 'Sending…') : L(lang, '发送测试邮件', 'Send test mail')}
        </Button>
      </form>
      <p className={`mt-2 text-xs ${result ? (result.ok ? 'text-ok' : 'text-bad') : 'text-label-3'}`}>
        {result ? `${result.ok ? '✓' : '✗'} ${result.message}`
          : !configured ? L(lang, '保存邮件设置后才能测试。', 'Save the settings before testing.')
            : dirty ? L(lang, '注意：测试使用已保存的设置，不包括上面未保存的修改。', 'Note: the test uses the saved settings, not the unsaved edits above.')
              : defaultTo ? L(lang, '默认发给当前管理员邮箱。', 'Defaults to your own address.')
                : L(lang, '用口令进入后台时没有账号邮箱，请填写收件邮箱。', 'Signed in with the token, so there is no account address: enter one.')}
      </p>
    </Card>
  );
}
