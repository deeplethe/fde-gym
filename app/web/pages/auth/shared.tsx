/**
 * Building blocks for the sign-in pages: a centred card (LeetCode's login), labelled fields
 * and the small helpers they share.
 */
import { Logo } from '@/components/site-chrome';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';
import { container } from '@/components/ui';
import { L, type Lang } from '@/lib/i18n';

/** Only same-site paths are allowed as the place to return to after signing in. */
export function safeNext(raw: string | null | undefined, fallback = '/'): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  return raw;
}

/** `/login?next=…` (or /register), keeping the return path when there is one. */
export function authLink(page: 'login' | 'register', next?: string): string {
  return next && next !== '/' ? `/${page}?next=${encodeURIComponent(next)}` : `/${page}`;
}

/** Same rule as the server: at least 8 characters, with both letters and digits. */
export function passwordProblem(pw: string, lang: Lang): string | undefined {
  if (pw.length < 8) return L(lang, '密码至少 8 位', 'Password must be at least 8 characters');
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return L(lang, '密码必须同时包含字母和数字', 'Password needs both letters and digits');
  return undefined;
}

export const passwordRule = (lang: Lang) => L(lang, '至少 8 位，同时包含字母和数字', 'At least 8 characters, with letters and digits');

/** Centred card with the site's name, a title and an optional line under it. */
export function AuthShell({ title, sub, children, footer }: { title: ReactNode; sub?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className={`${container} flex justify-center py-6 sm:py-12`}>
      <div className="w-full max-w-[400px]">
        <div className="card px-6 py-8 sm:px-8">
          <Link to="/" className="mx-auto block w-fit"><Logo className="text-[26px]" /></Link>
          <h1 className="mt-3 text-center text-base font-medium text-label-2">{title}</h1>
          {sub && <p className="mt-1.5 text-center text-sm text-label-3">{sub}</p>}
          <div className="mt-6">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-sm text-label-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Label, input and a hint (or error) under it. */
export function Field({ label, hint, invalid, ...input }: { label: ReactNode; hint?: ReactNode; invalid?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      <input {...input} aria-invalid={invalid || undefined} className={`field ${invalid ? '!border-bad/60' : ''}`} />
      {hint && <span className={`mt-1.5 block text-xs ${invalid ? 'text-bad' : 'text-label-3'}`}>{hint}</span>}
    </label>
  );
}

export function FormError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p role="alert" className="rounded-md bg-bad/10 px-3 py-2 text-[13px] text-bad">{children}</p>;
}

export function FormNotice({ children, tone = 'ok' }: { children: ReactNode; tone?: 'ok' | 'info' }) {
  return (
    <p role="status" className={`flex gap-2 rounded-md px-3 py-2.5 text-[13px] leading-relaxed text-label-1 ${tone === 'ok' ? 'bg-ok/10' : 'bg-fill-4'}`}>
      {tone === 'ok' && (
        <svg viewBox="0 0 16 16" aria-hidden className="mt-0.5 size-4 shrink-0 text-ok"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      )}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export const linkClass = 'text-link hover:underline';

/** Plain text with e-mail addresses and web links made clickable (no HTML is ever rendered). */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(/([\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?:\/\/[^\s，。；、）)]+)/g);
  return <>{parts.map((p, i) => (i % 2 === 0 ? p
    : p.includes('@') && !p.startsWith('http')
      ? <a key={i} href={`mailto:${p}`} className="text-link hover:underline">{p}</a>
      : <a key={i} href={p} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">{p}</a>))}</>;
}
