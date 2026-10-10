/**
 * The site's side of its runners: the machines that run cases (see ./runner-api).
 *
 * A runner connects to the site, not the other way round, so it can sit on another network, behind
 * a firewall or a NAT: it opens a WebSocket to /api/runner/connect with the join token
 * (FDEGYM_RUNNER_TOKEN, the same on the site and on every runner), says who it is, and from then on
 * answers the site's calls over that connection. It needs nothing else of the site's: no database,
 * no object storage, no model key. Cases it fetches from the site (/api/runner/cases/...), and its
 * model calls go through the site's relay (./llm-relay).
 *
 * Which runner gets a new run: the connected one with the most room, unless it is draining or
 * disabled. The site itself is a runner too (`local`) unless FDEGYM_LOCAL_RUNNER=0; it is used when
 * no other has room, so a site with no runners at all works as one machine. A run stays where it
 * started; when its runner is not connected, the run cannot be worked until it is back.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Context, Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import { caseArchive, sharedData } from './cases-store';
import { db, json } from './db';
import { localRunner, RunnerOffline, type FromRunner, type Runner, type RunnerInfo, type RunnerMethod, type ToRunner } from './runner-api';
import { SessionError } from './session-error';

const JOIN_TOKEN = process.env.FDEGYM_RUNNER_TOKEN || undefined;
/** Whether the site runs cases itself. */
export const LOCAL_RUNNER = process.env.FDEGYM_LOCAL_RUNNER !== '0';
/** Runners can join only where a token says who may. */
export const REMOTE_RUNNERS = !!JOIN_TOKEN;

const tokenOk = (given: string | undefined) => {
  if (!JOIN_TOKEN || !given) return false;
  const a = Buffer.from(JOIN_TOKEN), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};
const bearer = (h: string | undefined) => /^Bearer (.+)$/.exec(h ?? '')?.[1];

// ---- a connected runner

/** How long the site waits for each kind of answer. A command and a grading have limits of their own on the runner; these only catch a runner that went quiet. */
const WAIT_MS: Record<RunnerMethod, number> = {
  createRun: 300_000, ensureServing: 60_000, stopServing: 30_000, npc: 1_860_000, grade: 3_720_000, task: 30_000,
  listFiles: 30_000, readFile: 30_000, writeFile: 30_000, deletePath: 30_000, exec: 1_860_000, killExec: 30_000, execRunning: 30_000,
  agentTurn: 1_920_000, agentAttach: 1_920_000, agentStop: 30_000, deleteRun: 120_000, changes: 60_000, diff: 30_000, revertFile: 30_000, sqlite: 40_000, duplicate: 60_000,
};

class RemoteRunner implements Runner {
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onData?: (text: string) => void; timer: NodeJS.Timeout }>();
  alive = true;

  constructor(readonly name: string, readonly info: RunnerInfo, readonly capacity: number, readonly version: string, private ws: WebSocket) {}

  private call<T>(method: RunnerMethod, args: unknown[], onData?: (text: string) => void, waitMs = WAIT_MS[method]): Promise<T> {
    if (this.ws.readyState !== this.ws.OPEN) return Promise.reject(offline(this.name));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new SessionError('沙箱机没有回应，请稍后再试', 504)); }, waitMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onData, timer });
      this.ws.send(JSON.stringify({ t: 'call', id, method, args } satisfies ToRunner), (e) => { if (e) this.settle(id, undefined, offline(this.name)); });
    });
  }
  private settle(id: number, value: unknown, error?: Error) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (error) p.reject(error); else p.resolve(value);
  }
  /** A message from the runner once it has said hello. */
  receive(m: FromRunner) {
    if (m.t === 'ok') this.settle(m.id, m.value);
    else if (m.t === 'err') this.settle(m.id, undefined, new SessionError(m.message, m.status));
    else if (m.t === 'out') this.pending.get(m.id)?.onData?.(m.text);
  }
  /** The connection is gone: whatever was being waited for will not come. */
  dropped() {
    this.alive = false;
    for (const id of [...this.pending.keys()]) this.settle(id, undefined, offline(this.name));
  }
  close(code: number, reason: string) { try { this.ws.close(code, reason); } catch { /* already closed */ } }
  ping() { if (this.ws.readyState === this.ws.OPEN) this.ws.ping(); }

  createRun: Runner['createRun'] = (run) => this.call('createRun', [run]);
  ensureServing: Runner['ensureServing'] = (name) => this.call('ensureServing', [name]);
  stopServing: Runner['stopServing'] = (name) => this.call('stopServing', [name]);
  npc: Runner['npc'] = (name, path, payload) => this.call('npc', [name, path, payload], undefined, path === '/pilot' ? WAIT_MS.npc : 200_000);
  grade: Runner['grade'] = (name) => this.call('grade', [name]);
  task: Runner['task'] = (name) => this.call('task', [name]);
  listFiles: Runner['listFiles'] = (name) => this.call('listFiles', [name]);
  readFile: Runner['readFile'] = (name, path) => this.call('readFile', [name, path]);
  writeFile: Runner['writeFile'] = (name, path, content) => this.call('writeFile', [name, path, content]);
  deletePath: Runner['deletePath'] = (name, path) => this.call('deletePath', [name, path]);
  exec: Runner['exec'] = (name, command, cwd, onData, timeoutMs) => this.call('exec', [name, command, cwd, timeoutMs], onData, (timeoutMs ?? 1_800_000) + 60_000);
  killExec: Runner['killExec'] = (name) => this.call('killExec', [name]);
  execRunning: Runner['execRunning'] = (name) => this.call('execRunning', [name]);
  agentTurn: Runner['agentTurn'] = (name, turn, onLine) => this.call('agentTurn', [name, turn], onLine);
  agentAttach: Runner['agentAttach'] = (name, onLine) => this.call('agentAttach', [name], onLine);
  agentStop: Runner['agentStop'] = (name) => this.call('agentStop', [name]);
  deleteRun: Runner['deleteRun'] = (name) => this.call('deleteRun', [name]);
  // A runner answers `undefined` as null over the wire.
  changes: Runner['changes'] = async (name) => (await this.call<Awaited<ReturnType<Runner['changes']>> | null>('changes', [name])) ?? undefined;
  diff: Runner['diff'] = (name, path) => this.call('diff', [name, path]);
  revertFile: Runner['revertFile'] = (name, path) => this.call('revertFile', [name, path]);
  duplicate: Runner['duplicate'] = (name, path, lang) => this.call('duplicate', [name, path, lang]);
  sqlite: Runner['sqlite'] = (name, path, table, offset) => this.call('sqlite', [name, path, table ?? '', offset ?? 0]);
}

export { RunnerOffline };
/** Told whenever a runner connects, the first time or again (the coding agent takes up its turns there). */
const connected: ((runner: Runner) => void)[] = [];
export const onRunnerConnected = (f: (runner: Runner) => void) => { connected.push(f); };
const offline = (name: string) => new RunnerOffline(`这次练习所在的沙箱机（${name}）现在连不上，请稍后再试`, 503);

const online = new Map<string, RemoteRunner>();

// ---- the runners the site knows of (table `runners`)

interface Row { name: string; capacity: number; info: RunnerInfo; version: string; first_seen: number; last_seen: number; draining: boolean; disabled: boolean }

async function seen(r: RemoteRunner) {
  const now = Date.now();
  await db.run(`INSERT INTO runners (name, capacity, info, version, first_seen, last_seen) VALUES ($1, $2, $3::jsonb, $4, $5, $5)
    ON CONFLICT (name) DO UPDATE SET capacity = EXCLUDED.capacity, info = EXCLUDED.info, version = EXCLUDED.version, last_seen = EXCLUDED.last_seen`,
  [r.name, r.capacity, json(r.info), r.version, now]);
}

/** Runs each runner has under way (being worked or graded), by runner name. */
async function load(): Promise<Map<string, number>> {
  return new Map((await db.query<{ runner: string; n: number }>("SELECT runner, COUNT(*) AS n FROM runs WHERE status IN ('running', 'grading') GROUP BY runner")).map((r) => [r.runner, r.n]));
}

/** Where a new run goes. */
export async function pickRunner(): Promise<Runner> {
  if (online.size) {
    const [busy, rows] = await Promise.all([load(), db.query<Row>('SELECT * FROM runners WHERE name = ANY($1)', [[...online.keys()]])]);
    const open = rows.filter((r) => !r.draining && !r.disabled && (busy.get(r.name) ?? 0) < r.capacity)
      // The emptiest first, as a share of what it can take.
      .sort((a, b) => (busy.get(a.name) ?? 0) / a.capacity - (busy.get(b.name) ?? 0) / b.capacity);
    const chosen = open.map((r) => online.get(r.name)).find((r) => r?.alive);
    if (chosen) return chosen;
  }
  if (LOCAL_RUNNER) return localRunner;
  throw new SessionError(online.size ? '沙箱机都满了，请稍后再试' : '现在没有可用的沙箱机，请稍后再试', 503);
}

/** The runner a run is on. */
export function runnerNamed(name: string): Runner {
  if (name === 'local') {
    if (!LOCAL_RUNNER) throw new SessionError('这次练习在本站自己的沙箱里，而本站已不再运行沙箱', 410);
    return localRunner;
  }
  const r = online.get(name);
  if (!r?.alive) throw offline(name);
  return r;
}

/** For the admin pages: every runner the site has seen, the site itself among them. */
export async function runnerList() {
  const [busy, rows] = await Promise.all([load(), db.query<Row>('SELECT * FROM runners ORDER BY name')]);
  const remote = rows.map((r) => ({
    name: r.name, online: !!online.get(r.name)?.alive, capacity: r.capacity, active: busy.get(r.name) ?? 0, version: r.version,
    host: r.info.host, isolation: r.info.isolation, terminal: r.info.execMode !== 'off', firstSeen: r.first_seen, lastSeen: r.last_seen,
    draining: r.draining, disabled: r.disabled, local: false,
  }));
  const local = LOCAL_RUNNER || busy.has('local') ? [{
    name: 'local', online: LOCAL_RUNNER, capacity: null, active: busy.get('local') ?? 0, version: '',
    host: localRunner.info.host, isolation: localRunner.info.isolation, terminal: localRunner.info.execMode !== 'off', firstSeen: null, lastSeen: null,
    draining: false, disabled: !LOCAL_RUNNER, local: true,
  }] : [];
  return { joinable: REMOTE_RUNNERS, runners: [...local, ...remote] };
}

/**
 * `draining`: no new runs go there, the ones under way go on (before taking a machine down).
 * `disabled`: it may not connect at all.
 */
export async function setRunner(name: string, change: { draining?: boolean; disabled?: boolean }): Promise<boolean> {
  const sets: string[] = [], values: unknown[] = [];
  for (const k of ['draining', 'disabled'] as const) if (typeof change[k] === 'boolean') { values.push(change[k]); sets.push(`${k} = $${values.length}`); }
  if (!sets.length) return !!(await db.one('SELECT 1 FROM runners WHERE name = $1', [name]));
  values.push(name);
  const n = await db.run(`UPDATE runners SET ${sets.join(', ')} WHERE name = $${values.length}`, values);
  if (change.disabled) online.get(name)?.close(4003, 'disabled');
  return n > 0;
}

/** Forget a runner that is not coming back. Its runs stay on record; they can no longer be opened. */
export async function forgetRunner(name: string): Promise<boolean> {
  if (online.get(name)?.alive) throw new SessionError('这台沙箱机还连着，先停掉它再移除');
  return (await db.run('DELETE FROM runners WHERE name = $1', [name])) > 0;
}

// ---- connections

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/** Take runners' connections on the site's own HTTP server. */
export function attachRunners(server: Server) {
  if (!REMOTE_RUNNERS) return;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/api/runner/connect') return;
    if (!tokenOk(bearer(req.headers.authorization))) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws));
  });
  // A connection that stops answering is closed, so its runs are reported as unreachable rather than hanging.
  setInterval(() => { for (const r of online.values()) r.ping(); }, 20_000).unref();
}

function accept(ws: WebSocket) {
  let runner: RemoteRunner | undefined;
  let quiet = setTimeout(() => ws.terminate(), 15_000); // it has to say hello
  const heard = () => { clearTimeout(quiet); quiet = setTimeout(() => ws.terminate(), 70_000); };
  ws.on('pong', () => { heard(); if (runner) void seen(runner).catch(() => undefined); });
  ws.on('message', (data) => {
    heard();
    let m: FromRunner;
    try { m = JSON.parse(String(data)) as FromRunner; } catch { return; }
    if (runner) { runner.receive(m); return; }
    if (m.t !== 'hello' || !NAME.test(m.name) || m.name === 'local') { ws.close(4000, 'say hello first'); return; }
    void (async () => {
      const known = await db.one<{ disabled: boolean }>('SELECT disabled FROM runners WHERE name = $1', [m.name]);
      if (known?.disabled) { ws.close(4003, 'disabled'); return; }
      // The same runner connecting again (it restarted, or its line dropped): the new connection replaces the old.
      online.get(m.name)?.close(4001, 'replaced');
      runner = new RemoteRunner(m.name, m.info, Math.max(1, Math.min(10_000, Math.floor(m.capacity) || 1)), String(m.version ?? ''), ws);
      online.set(m.name, runner);
      await seen(runner);
      console.log(`runner ${m.name} connected (${m.info.host}, room for ${runner.capacity}, commands ${m.info.execMode === 'off' ? 'off' : m.info.isolation})`);
      for (const f of connected) f(runner);
    })().catch((e) => { console.error(e); ws.close(1011, 'error'); });
  });
  ws.on('close', () => {
    clearTimeout(quiet);
    if (!runner) return;
    runner.dropped();
    if (online.get(runner.name) === runner) { online.delete(runner.name); console.log(`runner ${runner.name} disconnected`); }
  });
  ws.on('error', () => ws.terminate());
}

// ---- what a runner fetches from the site

/** Cases and the data they share, for runners (the join token again). They hold no storage keys of their own. */
export function runnerRoutes(app: Hono) {
  const allowed = (c: Context) => { if (!tokenOk(bearer(c.req.header('authorization')))) throw new SessionError('not a runner', 401); };
  const bytes = (c: Context, b: Buffer) => c.body(new Uint8Array(b), 200, { 'content-type': 'application/gzip', 'content-length': String(b.length) });

  app.get('/api/runner/cases/:id/:sha', async (c) => {
    allowed(c);
    try { return bytes(c, await caseArchive(c.req.param('id'), c.req.param('sha'))); } catch { throw new SessionError('no such case version', 404); }
  });
  app.get('/api/runner/shared', async (c) => { allowed(c); return c.json({ sha: (await sharedData())?.sha ?? null }); });
  app.get('/api/runner/shared/archive', async (c) => {
    allowed(c);
    const s = await sharedData();
    if (!s) throw new SessionError('no shared data', 404);
    return bytes(c, await s.archive());
  });
}

