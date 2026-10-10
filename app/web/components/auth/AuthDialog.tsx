/**
 * Sign-in, sign-up and "forgot password" as one dialog over the current page (LeetCode style),
 * opened from anywhere with `useAuth().open('login' | 'register' | 'forgot', { next })`.
 * The /login, /register and /forgot addresses still work: they open the dialog over the home page.
 */
import { Logo } from '@/components/site-chrome';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Button, ButtonLink, Cross } from '@/components/ui';
import { api } from '@/lib/client';
import { L, useLang, type Lang } from '@/lib/i18n';
import { refreshMe, useMe } from '@/lib/me';
import { refreshSiteConfig, useSiteConfig } from '@/lib/site';
import { Field, FormError, FormNotice, Linkified, linkClass, passwordProblem, passwordRule, safeNext } from '@/pages/auth/shared';

export type AuthView = 'login' | 'register' | 'forgot';
interface OpenOptions {
  /** Where to go after signing in (same-site paths only); stay on the page when absent. */
  next?: string;
  /** Called when the dialog closes without signing in. */
  onCancel?: () => void;
}
interface AuthApi { open: (view: AuthView, opts?: OpenOptions) => void; close: () => void }

const AuthContext = createContext<AuthApi>({ open: () => {}, close: () => {} });
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ view: AuthView; opts: OpenOptions }>();
  const open = useCallback((view: AuthView, opts: OpenOptions = {}) => { void refreshSiteConfig(); setState({ view, opts }); }, []);
  const close = useCallback(() => setState(undefined), []);
  return (
    <AuthContext.Provider value={{ open, close }}>
      {children}
      {state && <AuthDialog view={state.view} opts={state.opts} setView={(view) => setState({ ...state, view })} close={close} />}
    </AuthContext.Provider>
  );
}

function AuthDialog({ view, opts, setView, close }: { view: AuthView; opts: OpenOptions; setView: (v: AuthView) => void; close: () => void }) {
  const { lang } = useLang();
  const navigate = useNavigate();
  const cancel = useCallback(() => { close(); opts.onCancel?.(); }, [close, opts]);
  /** Signed in: close, then go on to `next` if there is one. */
  const done = useCallback(() => {
    close();
    if (opts.next) navigate(safeNext(opts.next), { replace: true });
  }, [close, navigate, opts.next]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel]);

  const titles: Record<AuthView, string> = {
    login: L(lang, '登录', 'Sign in'),
    register: L(lang, '注册账号', 'Create your account'),
    forgot: L(lang, '重置密码', 'Reset your password'),
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/30 p-4 backdrop-blur-[3px]" onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <div role="dialog" aria-modal="true" aria-label={titles[view]} className="glass-thick relative w-full max-w-[400px] rounded-xl bg-layer-1 px-6 py-7 shadow-menu sm:px-8">
        <button type="button" onClick={cancel} aria-label={L(lang, '关闭', 'Close')}
          className="absolute top-3 right-3 grid size-8 place-items-center rounded-md text-label-3 transition-colors hover:bg-fill-3 hover:text-label-1"><Cross /></button>
        <p className="text-center"><Logo className="text-[26px]" /></p>
        <h2 className="mt-3 text-center text-base font-medium text-label-2">{titles[view]}</h2>
        <div className="mt-6">
          {view === 'login' && <LoginForm lang={lang} onDone={done} setView={setView} />}
          {view === 'register' && <RegisterForm lang={lang} onDone={done} setView={setView} />}
          {view === 'forgot' && <ForgotForm lang={lang} setView={setView} />}
        </div>
      </div>
    </div>
  );
}

// ---- sign in

function LoginForm({ lang, onDone, setView }: { lang: Lang; onDone: () => void; setView: (v: AuthView) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await api('/api/auth/login', { method: 'POST', json: { email, password } });
      await refreshMe();
      onDone();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label={L(lang, '邮箱', 'Email')} type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      <div>
        <Field label={L(lang, '密码', 'Password')} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <div className="mt-1.5 text-right text-xs">
          <button type="button" onClick={() => setView('forgot')} className={linkClass}>{L(lang, '忘记密码？', 'Forgot password?')}</button>
        </div>
      </div>
      <FormError>{error}</FormError>
      <Button type="submit" size="lg" disabled={busy} className="w-full">{busy ? L(lang, '正在登录……', 'Signing in…') : L(lang, '登录', 'Sign in')}</Button>
      <p className="text-center text-sm text-label-3">
        {L(lang, '没有账号？', 'No account? ')}<button type="button" onClick={() => setView('register')} className={linkClass}>{L(lang, '注册', 'Sign up')}</button>
      </p>
    </form>
  );
}

// ---- sign up (open, e-mail code, or closed)

function RegisterForm({ lang, onDone, setView }: { lang: Lang; onDone: () => void; setView: (v: AuthView) => void }) {
  const me = useMe();
  const site = useSiteConfig();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [wait, setWait] = useState(0);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string>();
  const [result, setResult] = useState<{ claimed: boolean; firstAdmin: boolean }>();
  useEffect(() => { if (wait <= 0) return; const t = setTimeout(() => setWait(wait - 1), 1000); return () => clearTimeout(t); }, [wait]);

  const toLogin = <p className="text-center text-sm text-label-3">{L(lang, '已有账号？', 'Have an account? ')}<button type="button" onClick={() => setView('login')} className={linkClass}>{L(lang, '登录', 'Sign in')}</button></p>;

  if (!site) return <p className="py-6 text-center text-sm text-label-3">{L(lang, '加载中……', 'Loading…')}</p>;

  if (result) {
    return (
      <div className="space-y-4">
        {result.firstAdmin && <FormNotice>{L(lang, '你是这个网站第一个注册的用户，已自动成为管理员。可以在管理后台配置模型和邮件服务。', 'You are the first account on this site, so you are its admin. Set up models and mail in the admin pages.')}</FormNotice>}
        {result.claimed && <FormNotice>{L(lang, '你在这个浏览器里的练习记录已归到账号下。', 'The runs you practised in this browser now belong to your account.')}</FormNotice>}
        <div className="flex gap-2">
          {result.firstAdmin && <ButtonLink to="/admin" tone="secondary" size="lg" className="flex-1">{L(lang, '去管理后台', 'Admin')}</ButtonLink>}
          <Button size="lg" className="flex-1" onClick={onDone}>{L(lang, '继续', 'Continue')}</Button>
        </div>
      </div>
    );
  }

  if (site.registration === 'closed') {
    return (
      <div className="space-y-4">
        {site.closedMessage
          ? <p className="rounded-lg bg-fill-4 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap"><Linkified text={site.closedMessage} /></p>
          : <p className="text-sm leading-relaxed text-label-2">{L(lang, '本站目前不开放自助注册，账号由管理员开通。需要账号的话，请联系网站管理员。', 'This site doesn’t take sign-ups right now; accounts are created by an admin.')}</p>}
        {site.allowAnonymous && <p className="text-xs leading-relaxed text-label-3">{L(lang, '你仍然可以不登录直接练习，记录会保存在这个浏览器里。', 'You can still practise without an account — runs are kept in this browser.')}</p>}
        {toLogin}
      </div>
    );
  }

  const emailMode = site.registration === 'email';
  const pwProblem = passwordProblem(password, lang);

  async function sendCode() {
    setError(undefined);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError(L(lang, '先填写正确的邮箱', 'Enter a valid email first')); return; }
    setSending(true);
    try { await api('/api/auth/register/code', { method: 'POST', json: { email: email.trim() } }); setSentTo(email.trim()); setWait(60); }
    catch (err) { setError((err as Error).message); }
    setSending(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (pwProblem) return;
    setBusy(true); setError(undefined);
    const hadAnonymousRuns = !!me?.learner && !me.user;
    try {
      const r = await api<{ firstAdmin?: boolean }>('/api/auth/register', { method: 'POST', json: { email, name, password, ...(emailMode ? { code } : {}) } });
      await refreshMe();
      if (hadAnonymousRuns || r.firstAdmin) setResult({ claimed: hadAnonymousRuns, firstAdmin: !!r.firstAdmin });
      else onDone();
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label={L(lang, '邮箱', 'Email')} type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      {emailMode && (
        <div>
          <span className="field-label">{L(lang, '邮箱验证码', 'Verification code')}</span>
          <div className="flex gap-2">
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code"
              placeholder={L(lang, '6 位数字', '6 digits')} className="field min-w-0 flex-1 font-mono tracking-[0.3em]" required />
            <Button type="button" tone="secondary" size="lg" className="w-32" disabled={sending || wait > 0} onClick={() => void sendCode()}>
              {sending ? L(lang, '发送中…', 'Sending…') : wait > 0 ? L(lang, `${wait} 秒后重发`, `Resend in ${wait}s`) : sentTo ? L(lang, '重新发送', 'Resend') : L(lang, '发送验证码', 'Send code')}
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-label-3">
            {sentTo ? L(lang, `验证码已发到 ${sentTo}，10 分钟内有效。没收到的话看看垃圾邮件。`, `Code sent to ${sentTo}, valid for 10 minutes. Check spam if it isn't there.`)
              : L(lang, '本站注册需要验证邮箱。', 'This site verifies your email address before sign-up.')}
          </p>
        </div>
      )}
      <Field label={L(lang, '名字', 'Name')} autoComplete="name" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} hint={L(lang, '显示在提交记录和排行榜上', 'Shown on your submissions and on the leaderboard')} />
      <Field label={L(lang, '密码', 'Password')} type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)}
        invalid={tried && !!pwProblem} hint={tried && pwProblem ? pwProblem : passwordRule(lang)} />
      {me?.learner && !me.user && (
        <p className="text-xs leading-relaxed text-label-3">
          {L(lang, `这个浏览器里以“${me.learner.name}”身份做的练习，注册后会归到新账号下。`, `Runs practised in this browser as “${me.learner.name}” will move to the new account.`)}
        </p>
      )}
      <FormError>{error}</FormError>
      <Button type="submit" size="lg" disabled={busy} className="w-full">{busy ? L(lang, '正在注册……', 'Signing up…') : L(lang, '注册', 'Sign up')}</Button>
      {toLogin}
    </form>
  );
}

// ---- forgot password

function ForgotForm({ lang, setView }: { lang: Lang; setView: (v: AuthView) => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try { await api('/api/auth/forgot', { method: 'POST', json: { email } }); setSent(true); }
    catch (err) { setError((err as Error).message); } // 503 when the site has no mail service
    setBusy(false);
  }
  const back = <p className="text-center text-sm"><button type="button" onClick={() => setView('login')} className={linkClass}>{L(lang, '返回登录', 'Back to sign in')}</button></p>;
  if (sent) {
    return (
      <div className="space-y-4">
        <FormNotice>{L(lang, '如果这个邮箱注册过，你会收到一封重置邮件。', 'If this email has an account, a reset email is on its way.')}</FormNotice>
        <p className="text-xs leading-relaxed text-label-3">
          {L(lang, '链接 1 小时内有效。没收到的话，看看垃圾邮件，或者', 'The link is valid for 1 hour. Nothing arrived? Check spam, or ')}
          <button type="button" onClick={() => setSent(false)} className={linkClass}>{L(lang, '换个邮箱再试', 'try another email')}</button>{L(lang, '。', '.')}
        </p>
        {back}
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-label-3">{L(lang, '填写注册时用的邮箱，我们会发一封重置邮件。', 'Enter the email you signed up with and we’ll send a reset link.')}</p>
      <Field label={L(lang, '邮箱', 'Email')} type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      <FormError>{error}</FormError>
      <Button type="submit" size="lg" disabled={busy} className="w-full">{busy ? L(lang, '正在发送……', 'Sending…') : L(lang, '发送重置邮件', 'Send reset email')}</Button>
      {back}
    </form>
  );
}

/** /login, /register, /forgot: the dialog over the home page; closing goes home, signing in goes to ?next. */
export function AuthRoute({ view, children }: { view: AuthView; children: ReactNode }) {
  const { open } = useAuth();
  const navigate = useNavigate();
  const me = useMe();
  useEffect(() => {
    if (me === undefined) return;
    const next = new URLSearchParams(window.location.search).get('next');
    if (me.user && view !== 'forgot') { navigate(safeNext(next), { replace: true }); return; }
    open(view, { next: safeNext(next), onCancel: () => navigate('/', { replace: true }) });
  }, [me, view, open, navigate]);
  return <>{children}</>;
}
