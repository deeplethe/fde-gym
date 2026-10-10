/**
 * FDE Gym web server: the JSON API for the site and the learner workspace, and — in production —
 * the built front end (dist/). Run with tsx, which lets it use TypeScript directly; the harness in ../harness is driven as a subprocess.
 * Data is in PostgreSQL (./db) and the cases' files in object storage (./storage).
 *
 *   pnpm dev     Vite (front end, port 5173) + this server (port 8787, API only)
 *   pnpm build   build the front end into dist/
 *   pnpm start   this server serves the API and dist/ (port from PORT, default 8787)
 *   (API_PORT overrides PORT; the dev script pins it to 8787, where Vite proxies /api)
 */
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { adminRoutes } from './admin-users';
import { authRoutes, currentUser, identity, publicUser } from './auth';
import { casesFromStorage, importArchive, importFolder } from './cases-store';
import { catalog, deleteCase, editCase, type Catalog } from './catalog';
import { db, migrate } from './db';
import { IMPORT_DIR } from './engine-paths';
import { errorText, langOf, translate } from './errors';
import { setLearner } from './learner';
import { agentRoutes, forgetLocalTurns, resumeTurns } from './agent';
import { agentConfig, contextWindow } from './agent-settings';
import { relayRoutes } from './llm-relay';
import { localRunner } from './runner-api';
import { attachRunners, forgetRunner, LOCAL_RUNNER, onRunnerConnected, REMOTE_RUNNERS, runnerList, runnerRoutes, setRunner } from './runners';
import { allowAnonymous } from './registration';
import { clearOldWorkspaces, endIdleRuns, humanRuns, learnerRuns, openSession, pickVariant, SessionError, startSession } from './session';
import { progress, standings, submissions } from './standings';
import { ensureBucket, storageName } from './storage';

const app = new Hono();

app.onError((e, c) => {
  const status = e instanceof SessionError ? e.status : 500;
  if (status === 500) console.error(e);
  return c.json({ error: errorText(e, langOf(c)) }, status as 400);
});

/** The requester's own session. */
async function mySession(c: Context) {
  const who = await identity(c);
  if (!who) throw new SessionError('请先开始一次练习', 401);
  // Anonymous practice switched off: continuing needs an account too (signing in claims this browser's runs).
  if (!who.user && !(await allowAnonymous())) throw new SessionError('本站需要登录后练习。登录后，你在这个浏览器里的练习记录会归到账号下', 401);
  return openSession(c.req.param('id')!, who.ids);
}

authRoutes(app);
// For the machines that run cases: where they fetch cases, and where their model calls go.
runnerRoutes(app);
relayRoutes(app);
agentRoutes(app);

async function body<T>(c: Context): Promise<Partial<T>> {
  return (await c.req.json().catch(() => ({}))) as Partial<T>;
}

/** An admin account, or the maintainer token (FDEGYM_ADMIN_TOKEN, for scripts and first set-up). */
function tokenAdmin(authorization: string | undefined): boolean {
  const token = process.env.FDEGYM_ADMIN_TOKEN;
  const given = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
  if (!token || !given) return false;
  const a = Buffer.from(token), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
const admin = async (c: Context) => tokenAdmin(c.req.header('authorization')) || (await currentUser(c))?.role === 'admin';
async function requireAdmin(c: Context) { if (!(await admin(c))) throw new SessionError('需要管理员权限', 403); }

// ---- site

app.get('/api/cases', async (c) => c.json((await catalog()).open()));

/** A paused case is still shown to admins. */
async function caseFor(c: Context, cat: Catalog, id: string) {
  const record = cat.record(id);
  if (!record || (record.hidden && !(await admin(c)))) throw new SessionError('没有这道题', 404);
  return record;
}
/** With the versions the requester has already started, so the start form can mark them. */
app.get('/api/cases/:id', async (c) => {
  const { card } = await caseFor(c, await catalog(), c.req.param('id'));
  // The requester's latest run on each of the scenario's cases, so the list can show what is done and how it went.
  const mine = new Map<number, { runId: string; grading?: string; totalScore: number | null }>();
  for (const r of await learnerRuns((await identity(c))?.ids ?? [])) if (r.caseId === card.id && r.status !== 'abandoned' && r.version > 0 && !mine.has(r.version)) mine.set(r.version, { runId: r.runId, grading: r.grading, totalScore: r.totalScore });
  return c.json({ ...card, myCases: [...mine].map(([version, r]) => ({ version, ...r })) });
});
/** Everyone's submissions per case, and where the requester stands on each. */
app.get('/api/progress', async (c) => c.json(await progress((await identity(c))?.ids ?? [])));
/** Members, ranked. */
app.get('/api/leaderboard', async (c) => c.json(await standings((await currentUser(c))?.id)));
/** The latest submissions and how each was judged; `?mine=1` for the requester's own. */
app.get('/api/submissions', async (c) => c.json(await submissions((await identity(c))?.ids ?? [], { mine: c.req.query('mine') === '1', limit: Number(c.req.query('limit')) || 50 })));
app.get('/api/me', async (c) => {
  const who = await identity(c);
  return c.json({
    learner: who ? { name: who.name } : null,
    user: who?.user ? publicUser(who.user) : null,
    runs: who ? await learnerRuns(who.ids) : [],
  });
});

// ---- learner sessions

app.post('/api/sessions', async (c) => {
  const b = await body<{ caseId: string; name: string; version: number | 'random'; variant: string }>(c);
  if (!b.caseId) throw new SessionError('缺少题目');
  // Signed in: the run belongs to the account. Otherwise to this browser's anonymous learner.
  const user = await currentUser(c);
  if (!user && !(await allowAnonymous())) throw new SessionError('请先登录再开始练习', 401);
  const cat = await catalog();
  const record = await caseFor(c, cat, b.caseId);
  const { card } = record;
  if (record.hidden) throw new SessionError('这道题已暂停开放，不能开始新的练习');
  // Before the learner cookie is (re)set: which versions this person has done decides what "random" avoids.
  const owners = (await identity(c))?.ids ?? [];
  const learner = user ? { id: user.id, name: user.name } : setLearner(c, b.name ?? '');
  // An admin may name the variant itself; everyone else picks a version number or leaves it to chance.
  const variant = typeof b.variant === 'string' && cat.variantKeys(card.id).includes(b.variant) && await admin(c) ? b.variant : await pickVariant(cat, card.id, b.version, owners);
  return c.json({ runId: await startSession({ record, learnerId: learner.id, name: learner.name, variant }) });
});

app.get('/api/sessions/:id', async (c) => {
  const view = await (await mySession(c)).view();
  return c.json({ ...view, gradingError: view.gradingError && translate(view.gradingError, langOf(c), 'Grading failed. Please retry.') });
});

app.get('/api/sessions/:id/messages', async (c) => c.json({ messages: await (await mySession(c)).messages() }));
app.get('/api/sessions/:id/commands', async (c) => c.json({ commands: await (await mySession(c)).commands() }));

app.get('/api/sessions/:id/file', async (c) => {
  const path = c.req.query('path');
  if (!path) throw new SessionError('缺少 path');
  return c.json({ path, ...await (await mySession(c)).readFile(path) });
});

app.put('/api/sessions/:id/file', async (c) => {
  const b = await body<{ path: string; content: string }>(c);
  if (!b.path || typeof b.content !== 'string') throw new SessionError('缺少 path 或 content');
  return c.json(await (await mySession(c)).writeFile(b.path, b.content));
});

app.delete('/api/sessions/:id/file', async (c) => {
  const path = c.req.query('path');
  if (!path) throw new SessionError('缺少 path');
  return c.json(await (await mySession(c)).deletePath(path));
});

app.post('/api/sessions/:id/ask', async (c) => {
  const b = await body<{ to: string; question: string }>(c);
  if (!b.to || !b.question) throw new SessionError('缺少 to 或 question');
  return c.json(await (await mySession(c)).ask(b.to, b.question));
});

app.post('/api/sessions/:id/wait', async (c) => {
  const b = await body<{ hours: number }>(c);
  return c.json(await (await mySession(c)).wait(Number(b.hours)));
});

/** Opening the inbox reads it: the new messages come back, and are in /messages from then on. */
app.post('/api/sessions/:id/inbox', async (c) => c.json({ messages: await (await mySession(c)).readInbox() }));

app.post('/api/sessions/:id/pilot', async (c) => c.json(await (await mySession(c)).pilot()));

/**
 * Run a command in the workspace, streamed as server-sent events: `out` ({ text }) as it prints,
 * then `done` ({ code, signal, truncated }) or `error` ({ error }).
 */
app.post('/api/sessions/:id/exec', async (c) => {
  const b = await body<{ command: string; cwd: string }>(c);
  if (!b.command) throw new SessionError('缺少 command');
  const session = await mySession(c);
  const lang = langOf(c);
  return streamSSE(c, async (sse) => {
    try {
      const r = await session.exec(b.command!, typeof b.cwd === 'string' ? b.cwd : '', (text) => { void sse.writeSSE({ event: 'out', data: JSON.stringify({ text }) }); });
      await sse.writeSSE({ event: 'done', data: JSON.stringify(r) });
    } catch (e) {
      if (!(e instanceof SessionError)) console.error(e);
      await sse.writeSSE({ event: 'error', data: JSON.stringify({ error: errorText(e, lang) }) });
    }
  });
});

app.post('/api/sessions/:id/exec/stop', async (c) => c.json(await (await mySession(c)).stopCommand()));

app.get('/api/sessions/:id/agent', async (c) => c.json(await (await mySession(c)).agentState()));

/**
 * Give the coding agent a message, streamed as server-sent events: `item` (what it says, and each
 * tool it uses), `result` ({ id, output } for a tool), then `done` ({ end, spend }) or `error`.
 */
app.post('/api/sessions/:id/agent', async (c) => {
  const b = await body<{ message: string }>(c);
  if (!b.message) throw new SessionError('消息不能为空');
  const session = await mySession(c);
  const lang = langOf(c);
  return streamSSE(c, async (sse) => {
    try {
      const r = await session.agentTurn(b.message!, (e) => { void sse.writeSSE({ event: e.event, data: JSON.stringify(e.data) }); });
      await sse.writeSSE({ event: 'done', data: JSON.stringify(r) });
    } catch (e) {
      if (!(e instanceof SessionError)) console.error(e);
      await sse.writeSSE({ event: 'error', data: JSON.stringify({ error: errorText(e, lang) }) });
    }
  });
});

/** What has changed in the workspace since it was built, one file's change as a diff, and putting a file back. */
app.get('/api/sessions/:id/changes', async (c) => c.json(await (await mySession(c)).changes()));
app.get('/api/sessions/:id/diff', async (c) => c.json(await (await mySession(c)).diff(c.req.query('path') ?? '')));
app.post('/api/sessions/:id/duplicate', async (c) => {
  const b = await body<{ path: string; lang: string }>(c);
  // The copy is named in the language the page is being read in, which the page knows best.
  return c.json(await (await mySession(c)).duplicate(b.path ?? '', b.lang === 'zh' || b.lang === 'en' ? b.lang : langOf(c)));
});
app.get('/api/sessions/:id/sqlite', async (c) => c.json(await (await mySession(c)).sqlite(c.req.query('path') ?? '', c.req.query('table') ?? '', Number(c.req.query('offset')) || 0)));
app.post('/api/sessions/:id/revert', async (c) => c.json(await (await mySession(c)).revert((await body<{ path: string }>(c)).path ?? '')));

/** The run looked back over, in order: see Session.timeline. */
app.get('/api/sessions/:id/timeline', async (c) => c.json({ events: await (await mySession(c)).timeline() }));

app.post('/api/sessions/:id/agent/stop', async (c) => c.json(await (await mySession(c)).stopAgent()));

app.post('/api/sessions/:id/submit', async (c) => c.json(await (await mySession(c)).submit()));
/** End a run without submitting it. */
app.post('/api/sessions/:id/abandon', async (c) => c.json(await (await mySession(c)).abandon()));
app.post('/api/sessions/:id/grade', async (c) => { await (await mySession(c)).retryGrading(); return c.json({ ok: true }); });

// ---- admin

adminRoutes(app, requireAdmin);

/** The library as admins see it: every case, how it is filed, which version of its files it is on, and how it is doing. */
async function adminCases() {
  const cat = await catalog();
  const runs = await humanRuns();
  return cat.records.map((r) => {
    const mine = runs.filter((x) => x.caseId === r.card.id);
    const graded = mine.filter((x) => x.totalScore !== null);
    return {
      id: r.card.id, title: r.card.title, org: r.org, sector: r.card.sector.label, region: r.card.region, difficulty: r.card.difficulty, hidden: r.hidden,
      versions: r.card.versions, bundle: r.bundleSha.slice(0, 12), bytes: r.bundleBytes, updatedAt: r.updatedAt,
      started: mine.length, graded: graded.length,
      avgNet: graded.length ? graded.reduce((n, x) => n + x.totalScore!, 0) / graded.length : null,
    };
  });
}

app.get('/api/admin/cases', async (c) => { await requireAdmin(c); return c.json(await adminCases()); });

/** The real names behind the version numbers, and what each changes. Admins only: these give the answers away. */
app.get('/api/admin/cases/:id/variants', async (c) => {
  await requireAdmin(c);
  const record = (await catalog()).record(c.req.param('id'));
  if (!record) throw new SessionError('没有这道题', 404);
  return c.json(record.variants.map((v, i) => ({ version: i + 1, key: v.key, angle: i === 0 ? null : v.angle ?? v.key })));
});

/**
 * Add a case, or replace the files of one: the body is a .tar.gz of the case's folder. The files go
 * to object storage and the listing into the database; runs already under way stay on the version
 * they started on.
 */
app.post('/api/admin/cases/import', async (c) => {
  await requireAdmin(c);
  const archive = Buffer.from(await c.req.arrayBuffer());
  if (!archive.length) throw new SessionError('没有收到文件');
  try { return c.json(await importArchive(archive)); } catch (e) {
    console.error(e);
    throw new SessionError(`导入失败：${(e as Error).message}`);
  }
});

/** Whether a case is on offer, and how it is filed (organisation, sector, region, difficulty). */
app.patch('/api/admin/cases/:id', async (c) => {
  await requireAdmin(c);
  const id = c.req.param('id');
  const b = await body<{ hidden: boolean; org: string; sector: string; region: string; difficulty: string }>(c);
  if (b.hidden !== undefined && typeof b.hidden !== 'boolean') throw new SessionError('hidden 必须是 true 或 false');
  if (!(await editCase(id, b))) throw new SessionError('没有这道题', 404);
  return c.json((await adminCases()).find((x) => x.id === id));
});

app.delete('/api/admin/cases/:id', async (c) => {
  await requireAdmin(c);
  if (!(await deleteCase(c.req.param('id')))) throw new SessionError('没有这道题', 404);
  return c.json({ ok: true });
});

// ---- the machines that run cases

/**
 * What tells whether a grade really ran the delivered system, for scripts/smoke_cases.py: the measure
 * and the baseline's, whether the system loaded, the incidents, and how the code was started. For an
 * admin only: incidents can quote what the held-out traffic did.
 */
app.get('/api/admin/runs/:id/check', async (c) => {
  await requireAdmin(c);
  const row = await db.one<{ status: string; result: Record<string, any> | null }>('SELECT status, result FROM runs WHERE id = $1', [c.req.param('id')]);
  if (!row) throw new SessionError('没有这次练习', 404);
  const r = row.result ?? {};
  return c.json({ status: row.status, kpi: r.kpi ?? null, kpi_baseline: r.kpi_baseline ?? null, service_loads: r.gates?.service_loads ?? null, incidents: r.incidents ?? [], isolation: r.gates?.isolation ?? null });
});

app.get('/api/admin/runners', async (c) => { await requireAdmin(c); return c.json(await runnerList()); });

app.patch('/api/admin/runners/:name', async (c) => {
  await requireAdmin(c);
  const b = await body<{ draining: boolean; disabled: boolean }>(c);
  if (!(await setRunner(c.req.param('name'), b))) throw new SessionError('没有这台沙箱机', 404);
  return c.json(await runnerList());
});

app.delete('/api/admin/runners/:name', async (c) => {
  await requireAdmin(c);
  if (!(await forgetRunner(c.req.param('name')))) throw new SessionError('没有这台沙箱机', 404);
  return c.json(await runnerList());
});

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// ---- built front end (production)

const DIST = join(dirname(fileURLToPath(import.meta.url)), '../dist');
if (existsSync(DIST)) {
  app.use('/*', serveStatic({ root: DIST }));
  const index = readFileSync(join(DIST, 'index.html'), 'utf8');
  app.get('*', (c) => c.html(index)); // client-side routes
}

// API_PORT wins so that a PORT meant for the dev front end (Vite) doesn't pull the API onto it.
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? '127.0.0.1';
// Learners' code runs with this server's privileges (see ./harness). Listening beyond this machine
// has to be a deliberate choice, made once the server itself is inside a container or VM.
if (!['127.0.0.1', 'localhost', '::1'].includes(hostname) && process.env.FDEGYM_ALLOW_REMOTE !== '1') {
  console.error(`Refusing to listen on ${hostname}: anyone who can reach this server can run code on it (learners' workspaces are executed here). Run it inside a disposable container or VM and set FDEGYM_ALLOW_REMOTE=1.`);
  process.exit(1);
}
const here = localRunner.info;
if (LOCAL_RUNNER && here.execMode !== 'off' && here.isolation === 'none') {
  console.warn('Commands run by learners and by the agent are not isolated on this host: they can read other runs, the cases fetched to this machine and the model key. Run the server in its container, or on macOS outside any other sandbox; or let other machines run the cases (FDEGYM_LOCAL_RUNNER=0, see docs/self-hosting.md).');
}

// The database and the object store have to be there before anything is served.
try {
  await migrate();
  await ensureBucket();
  casesFromStorage();
  // The coding agent's turns that were under way: those on this machine went down with it; those on a runner are taken up when it connects.
  await forgetLocalTurns();
  onRunnerConnected((runner) => { void resumeTurns(runner).catch((e) => console.error(e)); });
  // How much the agent's model can read at once is asked of its provider now, so that the first page shown has it.
  void agentConfig().then((cfg) => cfg && contextWindow(cfg)).catch(() => undefined);
  // Runs nobody has come back to are ended, so that they do not hold a runner's places for ever.
  const tidy = () => {
    void endIdleRuns().then((n) => { if (n) console.log(`ended ${n} run${n === 1 ? '' : 's'} left idle`); }).catch((e) => console.error(e))
      // And runs long over no longer keep their files on a runner's disk.
      .then(() => clearOldWorkspaces()).then((n) => { if (n) console.log(`cleared the files of ${n} run${n === 1 ? '' : 's'} long over`); }).catch((e) => console.error(e));
  };
  setTimeout(tidy, 60_000).unref();
  setInterval(tidy, 3_600_000).unref();
  // A grading is waited for by this process; one that was under way when the site stopped has nobody waiting for it.
  await db.run("UPDATE runs SET status = 'failed', error = $1 WHERE status = 'grading'", ['评分被中断，请重试']);
  // Cases found in the import folder are brought into the library: new ones, and ones whose files changed.
  if (IMPORT_DIR && existsSync(IMPORT_DIR)) {
    const r = await importFolder(IMPORT_DIR);
    const changed = r.imported.filter((x) => x.outcome !== 'unchanged');
    if (changed.length) console.log(`cases from ${IMPORT_DIR}: ${changed.map((x) => `${x.id} ${x.outcome}`).join(', ')}`);
    for (const f of r.failed) console.error(`case ${f.id} was not imported: ${f.error}`);
  }
} catch (e) {
  console.error((e as Error).message);
  console.error('The site needs a PostgreSQL database and S3-compatible object storage. On this machine, `docker compose up -d postgres storage` in the repository root starts both.');
  process.exit(1);
}

const server = serve({ fetch: app.fetch, port, hostname }, async () => {
  const n = (await catalog()).records.length;
  const own = !LOCAL_RUNNER ? 'none of its own' : here.execMode === 'off' ? 'its own, without a terminal' : `its own (commands: ${{ user: 'one user per run', sandbox: 'sandboxed to the workspace', none: 'NOT ISOLATED' }[here.isolation]})`;
  console.log(`FDE Gym server on http://${hostname}:${port} (${n} case${n === 1 ? '' : 's'} in the library; files in ${storageName()}; sandboxes: ${own}${REMOTE_RUNNERS ? ', and the runners that connect' : ''})`);
  if (!LOCAL_RUNNER && !REMOTE_RUNNERS) console.warn('No runs can be started: the site runs no cases itself (FDEGYM_LOCAL_RUNNER=0) and no runner can join it (FDEGYM_RUNNER_TOKEN is not set).');
});
// Runners connect to this same server.
attachRunners(server as import('node:http').Server);
