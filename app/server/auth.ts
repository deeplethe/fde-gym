/**
 * Sign-in for the site: e-mail and password, a session cookie, password reset by e-mail.
 * Anonymous practice still works (the learner cookie in ./learner); on the first sign-in from a
 * browser, that browser's anonymous runs are claimed by the account.
 */
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  checkUserPassword, claimLegacy, consumeEmailCode, issueEmailCode, createReset, createSession, createUser, emailProblem, endSession, getUser,
  passwordProblem, sessionUser, setPassword, updateUser, useReset, userByEmail, verifyLogin, type User,
} from './accounts';
import { getLearner } from './learner';
import { mailConfigured, sendMail } from './mail';
import { allowAnonymous, registrationInfo } from './registration';
import { SessionError } from './session-error';

const COOKIE = 'fdegym_session';

/** Who is making the request: a signed-in user, or an anonymous learner (cookie), or nobody. */
export interface Identity {
  /** Id new runs are recorded under. */
  id: string;
  name: string;
  /** Ids whose runs this identity owns (the user's own plus claimed anonymous ones). */
  ids: string[];
  user?: User;
}

export function currentUser(c: Context): Promise<User | undefined> {
  return sessionUser(getCookie(c, COOKIE));
}

export async function identity(c: Context): Promise<Identity | undefined> {
  const user = await currentUser(c);
  if (user) return { id: user.id, name: user.name, ids: [user.id, ...user.legacyIds], user };
  const learner = getLearner(c);
  return learner ? { id: learner.id, name: learner.name, ids: [learner.id] } : undefined;
}

export const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

// Behind a reverse proxy, set FDEGYM_TRUST_PROXY=1 so the client address comes from X-Forwarded-For.
export const clientOf = (c: Context) => (process.env.FDEGYM_TRUST_PROXY === '1' && c.req.header('x-forwarded-for')?.split(',')[0].trim())
  || getConnInfo(c).remote.address || 'unknown';

/** Sliding-window limiter for sign-in, sign-up and reset requests. */
const hits = new Map<string, number[]>();
function limit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) throw new SessionError('尝试次数太多，请稍后再试', 429);
  hits.set(key, [...recent, now]);
}

async function startSession(c: Context, user: User) {
  const { token, maxAge } = await createSession(user.id);
  setCookie(c, COOKIE, token, {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge,
    secure: new URL(c.req.url).protocol === 'https:' || process.env.FDEGYM_TRUST_PROXY === '1',
  });
  // Runs practised anonymously in this browser now belong to the account.
  const learner = getLearner(c);
  if (learner) await claimLegacy(user.id, learner.id);
}

/** Where links in e-mails point. Refuses to trust the Host header outside local development. */
function publicUrl(c: Context): string {
  if (process.env.FDEGYM_PUBLIC_URL) return process.env.FDEGYM_PUBLIC_URL.replace(/\/$/, '');
  const url = new URL(c.req.url);
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return c.req.header('origin') ?? url.origin;
  throw new SessionError('服务器没有配置 FDEGYM_PUBLIC_URL，无法发送重置邮件', 500);
}

async function body<T>(c: Context): Promise<Partial<T>> {
  return (await c.req.json().catch(() => ({}))) as Partial<T>;
}
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function authRoutes(app: Hono) {
  /** How sign-up works on this site right now (the sign-up page adapts to it). */
  app.get('/api/auth/config', async (c) => {
    const r = await registrationInfo();
    return c.json({ registration: r.mode, closedMessage: r.mode === 'closed' ? r.closedMessage : '', allowAnonymous: await allowAnonymous(), userCases: false });
  });

  /** E-mail a sign-up code, when the site requires a verified address. */
  app.post('/api/auth/register/code', async (c) => {
    const b = await body<{ email: string }>(c);
    const email = str(b.email).trim();
    if (emailProblem(email)) throw new SessionError('邮箱格式不对');
    if ((await registrationInfo()).mode !== 'email') throw new SessionError('现在注册不需要验证码');
    limit(`code-ip:${clientOf(c)}`, 10, 3_600_000);
    limit(`code-email:${email.toLowerCase()}`, 5, 3_600_000);
    if (await userByEmail(email)) throw new SessionError('这个邮箱已经注册过了，请直接登录', 409);
    let code: string;
    try { code = await issueEmailCode(email); } catch (e) { throw new SessionError((e as Error).message, 429); }
    try {
      await sendMail(email, `FDE Gym 注册验证码：${code}`, `你的注册验证码是：${code}\n\n10 分钟内有效。如果不是你本人操作，忽略这封邮件即可。\n\n— FDE Gym`);
    } catch (e) {
      console.error('code mail:', (e as Error).message);
      throw new SessionError('验证码邮件发送失败，请稍后再试或联系管理员', 502);
    }
    return c.json({ ok: true });
  });

  app.post('/api/auth/register', async (c) => {
    limit(`register:${clientOf(c)}`, 10, 3_600_000);
    const b = await body<{ email: string; name: string; password: string; code: string }>(c);
    const email = str(b.email).trim(), name = str(b.name).trim(), password = str(b.password);
    const { mode } = await registrationInfo();
    if (mode === 'closed') throw new SessionError('本站暂不开放注册，请联系管理员开通账号', 403);
    const problem = emailProblem(email) ?? (name ? undefined : '请填写名字') ?? passwordProblem(password)
      ?? (mode === 'email' && !str(b.code).trim() ? '请填写邮箱验证码' : undefined);
    if (problem) throw new SessionError(problem);
    if (mode === 'email') {
      if (await userByEmail(email)) throw new SessionError('这个邮箱已经注册过了', 409);
      try { await consumeEmailCode(email, str(b.code)); } catch (e) { throw new SessionError((e as Error).message); }
    }
    let user: Awaited<ReturnType<typeof createUser>>;
    try { user = await createUser(email, name, password); } catch (e) { throw new SessionError((e as Error).message, 409); }
    await startSession(c, user);
    return c.json({ user: publicUser((await getUser(user.id))!), firstAdmin: user.firstAdmin });
  });

  app.post('/api/auth/login', async (c) => {
    const b = await body<{ email: string; password: string }>(c);
    const email = str(b.email).trim().toLowerCase();
    limit(`login-ip:${clientOf(c)}`, 30, 900_000);
    limit(`login-email:${email}`, 10, 900_000);
    const user = await verifyLogin(email, str(b.password));
    if (!user) throw new SessionError('邮箱或密码不对', 401);
    if (user.status === 'banned') throw new SessionError('这个账号已被停用，请联系管理员', 403);
    await startSession(c, user);
    return c.json({ user: publicUser((await getUser(user.id))!) });
  });

  app.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, COOKIE);
    if (token) await endSession(token);
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  /** Always answers the same way, so it can't be used to find out who has an account. */
  app.post('/api/auth/forgot', async (c) => {
    limit(`forgot:${clientOf(c)}`, 5, 3_600_000);
    const b = await body<{ email: string }>(c);
    const email = str(b.email).trim();
    if (emailProblem(email)) throw new SessionError('邮箱格式不对');
    if (!(await mailConfigured())) throw new SessionError('网站还没有配置邮件服务，请联系管理员重置密码', 503);
    const user = await userByEmail(email);
    if (user && user.status === 'active') {
      const link = `${publicUrl(c)}/reset?token=${await createReset(user.id)}`;
      await sendMail(user.email, 'FDE Gym 重置密码', `${user.name}，你好：\n\n点击下面的链接设置新密码（1 小时内有效）：\n${link}\n\n如果不是你本人操作，忽略这封邮件即可。\n\n— FDE Gym`)
        .catch((e) => { console.error('reset mail:', (e as Error).message); });
    }
    return c.json({ ok: true });
  });

  app.post('/api/auth/reset', async (c) => {
    limit(`reset:${clientOf(c)}`, 10, 3_600_000);
    const b = await body<{ token: string; password: string }>(c);
    const problem = passwordProblem(str(b.password));
    if (problem) throw new SessionError(problem);
    let user: User;
    try { user = await useReset(str(b.token), str(b.password)); } catch (e) { throw new SessionError((e as Error).message, 400); }
    if (user.status !== 'active') throw new SessionError('这个账号已被停用，请联系管理员', 403);
    await startSession(c, user);
    return c.json({ user: publicUser(user) });
  });

  app.patch('/api/account', async (c) => {
    const user = await currentUser(c);
    if (!user) throw new SessionError('请先登录', 401);
    const b = await body<{ name: string }>(c);
    const name = str(b.name).trim();
    if (!name) throw new SessionError('请填写名字');
    return c.json({ user: publicUser(await updateUser(user.id, { name })) });
  });

  app.post('/api/account/password', async (c) => {
    const user = await currentUser(c);
    if (!user) throw new SessionError('请先登录', 401);
    limit(`password:${user.id}`, 10, 900_000);
    const b = await body<{ current: string; next: string }>(c);
    if (!(await checkUserPassword(user.id, str(b.current)))) throw new SessionError('当前密码不对', 400);
    const problem = passwordProblem(str(b.next));
    if (problem) throw new SessionError(problem);
    await setPassword(user.id, str(b.next), { keepSession: getCookie(c, COOKIE) });
    return c.json({ ok: true });
  });
}
