/**
 * Admin endpoints for members, the dashboard, CSV exports and server settings (sign-up, mail).
 * Every route here calls `requireAdmin` first.
 */
import type { Context, Hono } from 'hono';
import {
  countAdmins, createUser, emailProblem, getUser, listUsers, passwordProblem, setPassword, updateUser, type User, type UserRole, type UserStatus,
} from './accounts';
import { currentUser, publicUser } from './auth';
import { catalog } from './catalog';
import { AgentInput, agentView, saveAgent } from './agent-settings';
import { MailInput, mailView, saveMail, sendMail } from './mail';
import { allowAnonymous, registrationInfo, setAllowAnonymous, setRegistration, type RegistrationMode } from './registration';
import { mailConfigured } from './mail';
import { humanRuns, SessionError } from './session';

type Run = Awaited<ReturnType<typeof humanRuns>>[number];

/** A graded run's score as a rate: uplift net of contact cost, kept within 0 to 1 (a run can do harm, or beat the reference). */
const scoreRate = (r: Run): number | null => (r.totalScore === null ? null : Math.min(1, Math.max(0, r.totalScore)));

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function ownerIndex(users: User[]) {
  const owner = new Map<string, string>();
  for (const u of users) for (const id of [u.id, ...u.legacyIds]) owner.set(id, u.id);
  return owner;
}

async function userRows(q: string) {
  const users = await listUsers(q);
  const owner = ownerIndex(await listUsers());
  const byUser = new Map<string, Run[]>();
  for (const r of await humanRuns()) {
    const u = owner.get(r.learnerId);
    if (u) byUser.set(u, [...(byUser.get(u) ?? []), r]);
  }
  return users.map((u) => {
    const runs = byUser.get(u.id) ?? [];
    const graded = runs.map(scoreRate).filter((x): x is number => x !== null);
    return {
      ...publicUser(u), status: u.status, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
      runs: runs.length, graded: graded.length, avgRate: avg(graded), lastRunAt: runs[0]?.startedAt ?? null,
    };
  });
}

const DAY = 86_400_000;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

async function dashboard() {
  const users = await listUsers();
  const runs = await humanRuns();
  const cat = await catalog();
  const owner = ownerIndex(users);
  const now = Date.now();
  const days = Array.from({ length: 30 }, (_, i) => dayKey(now - (29 - i) * DAY));
  const series = Object.fromEntries(days.map((d) => [d, { users: 0, runs: 0, graded: 0 }]));
  for (const u of users) { const d = dayKey(u.createdAt); if (series[d]) series[d].users++; }
  for (const r of runs) {
    const d = dayKey(r.startedAt);
    if (series[d]) { series[d].runs++; if (r.grading === 'done') series[d].graded++; }
  }
  const active7 = new Set(runs.filter((r) => now - r.startedAt < 7 * DAY).map((r) => owner.get(r.learnerId) ?? r.learnerId));
  const byCase = new Map<string, Run[]>();
  for (const r of runs) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
  const rates = runs.map(scoreRate).filter((x): x is number => x !== null);
  const buckets = [0, 0.2, 0.4, 0.6, 0.8].map((lo) => ({ from: lo, to: lo + 0.2, n: rates.filter((x) => x >= lo && (x < lo + 0.2 || (lo === 0.8 && x <= 1))).length }));
  return {
    totals: {
      users: users.length, admins: users.filter((u) => u.role === 'admin').length, banned: users.filter((u) => u.status === 'banned').length,
      runs: runs.length, graded: runs.filter((r) => r.grading === 'done').length, active7: active7.size,
      anonymousLearners: new Set(runs.filter((r) => !owner.has(r.learnerId)).map((r) => r.learnerId)).size,
      avgRate: avg(rates),
    },
    series: days.map((d) => ({ day: d, ...series[d] })),
    cases: [...byCase].map(([caseId, rs]) => {
      const g = rs.map(scoreRate).filter((x): x is number => x !== null);
      return { caseId, title: cat.card(caseId)?.title ?? caseId, started: rs.length, graded: g.length, avgRate: avg(g) };
    }).sort((a, b) => b.started - a.started),
    distribution: buckets,
  };
}

/** CSV with a BOM so Excel opens the Chinese text correctly. */
function csv(c: Context, name: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    // Leading = + - @ would be run as a formula by spreadsheet apps.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const text = '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  return c.body(text, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` });
}

async function body<T>(c: Context): Promise<Partial<T>> {
  return (await c.req.json().catch(() => ({}))) as Partial<T>;
}
const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : '');

export function adminRoutes(app: Hono, requireAdmin: (c: Context) => Promise<void>) {
  // ---- dashboard
  app.get('/api/admin/stats', async (c) => { await requireAdmin(c); return c.json(await dashboard()); });

  // ---- members
  app.get('/api/admin/users', async (c) => { await requireAdmin(c); return c.json(await userRows(c.req.query('q') ?? '')); });

  app.get('/api/admin/users/:id', async (c) => {
    await requireAdmin(c);
    const u = await getUser(c.req.param('id'));
    if (!u) throw new SessionError('没有这个用户', 404);
    const ids = [u.id, ...u.legacyIds];
    const cat = await catalog();
    const runs = (await humanRuns()).filter((r) => ids.includes(r.learnerId)).map((r) => ({ ...r, rate: scoreRate(r), title: cat.card(r.caseId)?.title ?? r.caseId, angle: cat.variantAngle(r.caseId, r.variant) ?? null }));
    return c.json({ user: { ...publicUser(u), status: u.status, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, claimed: u.legacyIds.length }, runs });
  });

  app.post('/api/admin/users', async (c) => {
    await requireAdmin(c);
    const b = await body<{ email: string; name: string; password: string; role: UserRole }>(c);
    const email = String(b.email ?? '').trim(), name = String(b.name ?? '').trim(), password = String(b.password ?? '');
    const problem = emailProblem(email) ?? (name ? undefined : '请填写名字') ?? passwordProblem(password);
    if (problem) throw new SessionError(problem);
    let u: User;
    try { u = await createUser(email, name, password); } catch (e) { throw new SessionError((e as Error).message, 409); }
    if (b.role === 'admin') u = await updateUser(u.id, { role: 'admin' });
    return c.json(publicUser(u));
  });

  app.patch('/api/admin/users/:id', async (c) => {
    await requireAdmin(c);
    const id = c.req.param('id');
    const target = await getUser(id);
    if (!target) throw new SessionError('没有这个用户', 404);
    const b = await body<{ role: UserRole; status: UserStatus; name: string }>(c);
    if (b.role && !['user', 'admin'].includes(b.role)) throw new SessionError('角色不对');
    if (b.status && !['active', 'banned'].includes(b.status)) throw new SessionError('状态不对');
    const me = await currentUser(c);
    if (me?.id === id && (b.status === 'banned' || b.role === 'user')) throw new SessionError('不能停用自己或取消自己的管理员身份');
    // Keep at least one active admin account.
    const losingAdmin = target.role === 'admin' && target.status === 'active' && (b.role === 'user' || b.status === 'banned');
    if (losingAdmin && (await countAdmins()) <= 1) throw new SessionError('至少要保留一个管理员');
    const u = await updateUser(id, { role: b.role, status: b.status, name: b.name });
    return c.json({ ...publicUser(u), status: u.status });
  });

  app.post('/api/admin/users/:id/password', async (c) => {
    await requireAdmin(c);
    const u = await getUser(c.req.param('id'));
    if (!u) throw new SessionError('没有这个用户', 404);
    const b = await body<{ password: string }>(c);
    const problem = passwordProblem(String(b.password ?? ''));
    if (problem) throw new SessionError(problem);
    await setPassword(u.id, String(b.password)); // also signs the member out everywhere
    return c.json({ ok: true });
  });

  // ---- exports
  app.get('/api/admin/export/users.csv', async (c) => {
    await requireAdmin(c);
    return csv(c, 'fde-gym-users.csv',
      ['id', 'email', 'name', 'role', 'status', 'created_at', 'last_login_at', 'runs', 'graded', 'avg_score_rate', 'last_run_at'],
      (await userRows('')).map((u) => [u.id, u.email, u.name, u.role, u.status, iso(u.createdAt), iso(u.lastLoginAt), u.runs, u.graded, u.avgRate === null ? '' : u.avgRate.toFixed(3), iso(u.lastRunAt)]));
  });

  app.get('/api/admin/export/runs.csv', async (c) => {
    await requireAdmin(c);
    const users = await listUsers();
    const owner = ownerIndex(users);
    const email = new Map(users.map((u) => [u.id, u.email]));
    return csv(c, 'fde-gym-runs.csv',
      ['run_id', 'case_id', 'variant', 'user_email', 'anonymous_id', 'started_at', 'status', 'uplift', 'uplift_net'],
      (await humanRuns()).map((r) => {
        const u = owner.get(r.learnerId);
        return [r.runId, r.caseId, r.variant, u ? email.get(u) : '', u ? '' : r.learnerId, iso(r.startedAt), r.status, r.uplift ?? '', r.totalScore ?? ''];
      }));
  });

  // ---- sign-up policy
  app.get('/api/admin/settings/registration', async (c) => {
    await requireAdmin(c);
    const r = await registrationInfo();
    return c.json({ mode: r.configured, closedMessage: r.closedMessage, allowAnonymous: await allowAnonymous(), mailConfigured: await mailConfigured() });
  });

  app.put('/api/admin/settings/registration', async (c) => {
    await requireAdmin(c);
    const b = await body<{ mode: RegistrationMode; closedMessage: string; allowAnonymous: boolean }>(c);
    try {
      if (b.mode !== undefined || typeof b.closedMessage === 'string') {
        await setRegistration({ mode: b.mode, closedMessage: typeof b.closedMessage === 'string' ? b.closedMessage : undefined });
      }
      if (typeof b.allowAnonymous === 'boolean') await setAllowAnonymous(b.allowAnonymous);
    } catch (e) { throw new SessionError((e as Error).message); }
    const r = await registrationInfo();
    return c.json({ mode: r.configured, closedMessage: r.closedMessage, allowAnonymous: await allowAnonymous(), mailConfigured: await mailConfigured() });
  });

  // ---- the coding agent learners direct
  app.get('/api/admin/settings/agent', async (c) => { await requireAdmin(c); return c.json(await agentView()); });

  app.put('/api/admin/settings/agent', async (c) => {
    await requireAdmin(c);
    const parsed = AgentInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new SessionError(parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}：${i.message}`).join('；'));
    await saveAgent(parsed.data);
    return c.json(await agentView());
  });

  // ---- mail settings
  app.get('/api/admin/settings/mail', async (c) => { await requireAdmin(c); return c.json(await mailView()); });

  app.put('/api/admin/settings/mail', async (c) => {
    await requireAdmin(c);
    const parsed = MailInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new SessionError(parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}：${i.message}`).join('；'));
    await saveMail(parsed.data);
    return c.json(await mailView());
  });

  app.post('/api/admin/settings/mail/test', async (c) => {
    await requireAdmin(c);
    const b = await body<{ to: string }>(c);
    const to = String(b.to ?? '').trim() || (await currentUser(c))?.email || '';
    if (emailProblem(to)) throw new SessionError('请填写收件邮箱');
    try { await sendMail(to, 'FDE Gym 测试邮件', '这是一封测试邮件：邮件服务配置正确。\n\n— FDE Gym'); }
    catch (e) { throw new SessionError(`发送失败：${(e as Error).message}`, 502); }
    return c.json({ ok: true, to });
  });
}
