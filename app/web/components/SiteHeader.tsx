import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import { api } from '@/lib/client';
import { L, useLang } from '@/lib/i18n';
import { refreshMe, useMe } from '@/lib/me';
import { DEEPLETHE_URL, DeepLetheMark, GITHUB_URL, GitHubLink, LangToggle, Logo } from './site-chrome';
import { ThemeToggle } from './ThemeToggle';
import { useAuth } from './auth/AuthDialog';
import { Button, container, tabClass } from './ui';

export { DEEPLETHE_URL, DeepLetheMark, GITHUB_URL, GitHubLink, LangToggle } from './site-chrome';

/** Logo: the name set in the page's own face, no mark beside it. */
export function Wordmark({ className = '' }: { className?: string }) {
  return <Link to="/cases" className="flex shrink-0 items-center"><Logo className={`text-[18px] ${className}`} /></Link>;
}

/** Avatar button with a dropdown; closes on outside click, Escape, or picking an item. */
function Dropdown({ avatar, label, children }: { avatar: ReactNode; label?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}
        className={`flex h-8 items-center gap-2 rounded-full px-0.5 transition-colors sm:pr-2.5 ${open ? 'bg-fill-3' : 'hover:bg-fill-3'}`}>
        {avatar}
        {label && <span className="hidden max-w-[8rem] truncate text-sm sm:block">{label}</span>}
        <svg viewBox="0 0 12 12" aria-hidden className="hidden size-3 text-label-3 sm:block"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && <div role="menu" className="menu absolute right-0 top-full z-50 mt-1.5 w-60">{children(() => setOpen(false))}</div>}
    </div>
  );
}

const menuItem = 'flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-label-1 transition-colors hover:bg-fill-3';
const menuRule = <div className="my-1 h-px bg-divider" />;
const initial = (name: string) => [...name][0]?.toUpperCase();

/**
 * Top-right account. Signed in: avatar, name and the account menu. Practised anonymously: the
 * learner's name (runs live in this browser only) plus 登录, as words with an arrow. Otherwise just that.
 * Signing up is a step from there, inside the dialog.
 */
/** `compact` (the workspace's top bar): no Sign in button beside the avatar; signing in and up move into its menu, so the bar keeps one primary action. */
export function UserMenu({ compact = false }: { compact?: boolean } = {}) {
  const { lang } = useLang();
  const me = useMe();
  const navigate = useNavigate();
  const auth = useAuth();
  if (me === undefined) return <span className="size-8" />;

  // Sign-in dialog over the current page; signing in keeps you where you are.
  const authButtons = (
    <button type="button" onClick={() => auth.open('login')} className="group ml-2 flex items-center gap-1 rounded-md px-1.5 py-1 text-sm font-medium text-label-2 transition-colors hover:text-label-1">
      {L(lang, '登录', 'Sign in')}
      <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3.500 8h9M8.800 4.300 12.500 8l-3.700 3.700" /></svg>
    </button>
  );

  const { user, learner } = me;
  if (user) {
    // Leave the page first: pages that need an account (/account) would otherwise redirect to /login.
    const logout = async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
      navigate('/');
      await refreshMe();
    };
    return (
      <div className="ml-1">
        <Dropdown label={user.name}
          avatar={<span aria-hidden className="grid size-7 place-items-center rounded-full bg-brand text-xs font-semibold text-on-brand">{initial(user.name)}</span>}>
          {(close) => (
            <>
              <div className="px-3 pt-2 pb-2.5">
                <p className="truncate text-sm font-semibold">{user.name}</p>
                <p className="mt-0.5 truncate text-xs text-label-3" title={user.email}>{user.email}</p>
              </div>
              {menuRule}
              <Link role="menuitem" to="/me" className={menuItem} onClick={close}>{L(lang, '我的练习', 'My runs')}</Link>
              <Link role="menuitem" to="/account" className={menuItem} onClick={close}>{L(lang, '账号设置', 'Account settings')}</Link>
              {user.role === 'admin' && <Link role="menuitem" to="/admin" className={menuItem} onClick={close}>{L(lang, '管理后台', 'Admin')}</Link>}
              {menuRule}
              <button type="button" role="menuitem" className={`${menuItem} text-label-2`} onClick={() => { close(); void logout(); }}>{L(lang, '退出登录', 'Sign out')}</button>
            </>
          )}
        </Dropdown>
      </div>
    );
  }

  if (learner) {
    return (
      <div className="ml-1 flex items-center gap-0.5 sm:gap-1">
        <Dropdown label={learner.name}
          avatar={
            <span aria-hidden className="relative grid size-7 place-items-center rounded-full bg-fill-2 text-xs font-semibold text-label-2">
              {initial(learner.name)}
              <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-layer-1 bg-warn" />
            </span>
          }>
          {(close) => (
            <>
              <div className="px-3 pt-2 pb-2.5">
                <p className="truncate text-sm font-semibold">{learner.name}</p>
                <p className="mt-1 text-xs leading-relaxed text-label-3">
                  {L(lang, '练习记录只保存在本浏览器。登录或注册后，会自动归到账号下。', 'Your runs are saved in this browser only. Sign in or sign up to keep them with an account.')}
                </p>
              </div>
              {menuRule}
              <Link role="menuitem" to="/me" className={menuItem} onClick={close}>{L(lang, '我的练习', 'My runs')}</Link>
              {compact && (
                <>
                  {menuRule}
                  <button type="button" role="menuitem" className={menuItem} onClick={() => { close(); auth.open('login'); }}>{L(lang, '登录', 'Sign in')}</button>
                  <button type="button" role="menuitem" className={menuItem} onClick={() => { close(); auth.open('register'); }}>{L(lang, '注册', 'Sign up')}</button>
                </>
              )}
            </>
          )}
        </Dropdown>
        {!compact && authButtons}
      </div>
    );
  }

  return authButtons;
}

/** The search box in the header: it takes what is typed to the case library, which does the searching. */
function HeaderSearch() {
  const { lang } = useLang();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  return (
    <form role="search" className="relative hidden w-full max-w-[220px] sm:block" onSubmit={(e) => { e.preventDefault(); navigate(q.trim() ? `/cases?q=${encodeURIComponent(q.trim())}` : '/cases'); setQ(''); }}>
      <svg viewBox="0 0 16 16" aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-label-3">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label={L(lang, '搜索题目', 'Search cases')} placeholder={L(lang, '搜索题目', 'Search cases')}
        className="field h-8 rounded-full py-0 pr-3 pl-8" />
    </form>
  );
}

export function SiteHeader() {
  const { lang } = useLang();
  const nav: (readonly [string, string])[] = [
    ['/cases', L(lang, '题库', 'Cases')],
    ['/status', L(lang, '提交记录', 'Submissions')],
    ['/leaderboard', L(lang, '排行榜', 'Leaderboard')],
    ['/docs', L(lang, '文档', 'Docs')],
    ['/about', L(lang, '关于', 'About')],
  ];
  const item = ({ isActive }: { isActive: boolean }) => tabClass(isActive);
  return (
    <header className="sticky top-0 z-30 border-b border-divider bg-layer-1">
      <div className={`${container} flex h-14 items-center gap-4`}>
        <Wordmark />
        <HeaderSearch />
        <nav className="no-scrollbar ml-auto hidden h-full min-w-0 items-center gap-1 overflow-x-auto md:flex">
          {nav.map(([to, label]) => <NavLink key={to} to={to} className={item}>{label}</NavLink>)}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1 md:ml-2">
          <ThemeToggle />
          <LangToggle />
          <span className="hidden sm:contents"><GitHubLink /></span>
          <UserMenu />
        </div>
      </div>
      {/* On phones the links get their own row, so the account controls keep their room. */}
      <nav className={`${container} no-scrollbar flex h-11 items-center gap-1 overflow-x-auto border-t border-divider md:hidden`}>
        {nav.map(([to, label]) => <NavLink key={to} to={to} className={item}>{label}</NavLink>)}
      </nav>
    </header>
  );
}

export function SiteFooter() {
  const { lang } = useLang();
  const link = 'hover:text-label-1';
  return (
    <footer className="mt-16 border-t border-divider">
      <div className={`${container} flex flex-col gap-4 py-6 text-xs text-label-3 sm:flex-row sm:items-center sm:justify-between`}>
        <div className="flex flex-col gap-2">
          <a href={DEEPLETHE_URL} target="_blank" rel="noreferrer" aria-label="DeepLethe" className="self-start text-label-1 transition-opacity hover:opacity-70">
            <DeepLetheMark className="text-[17px]" />
          </a>
          <span>
            © {new Date().getFullYear()}{' '}
            <a href={DEEPLETHE_URL} target="_blank" rel="noreferrer" className={link}>DeepLethe</a>
            {L(lang, ' 与 ', ' and ')}
            <a href={`${GITHUB_URL}/graphs/contributors`} target="_blank" rel="noreferrer" className={link}>{L(lang, 'GitHub 贡献者', 'GitHub contributors')}</a>
            {' · '}{L(lang, '新时代的 OJ：判的是交付', 'The online judge for the new era: it judges the delivery')}
          </span>
        </div>
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          <Link to="/cases" className={link}>{L(lang, '题库', 'Cases')}</Link>
          <Link to="/status" className={link}>{L(lang, '提交记录', 'Submissions')}</Link>
          <Link to="/leaderboard" className={link}>{L(lang, '排行榜', 'Leaderboard')}</Link>
          <Link to="/docs" className={link}>{L(lang, '文档', 'Docs')}</Link>
          <Link to="/about" className={link}>{L(lang, '关于', 'About')}</Link>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className={link}>GitHub</a>
          <span>{L(lang, 'Apache-2.0 开源', 'Open source, Apache-2.0')}</span>
        </span>
      </div>
    </footer>
  );
}
