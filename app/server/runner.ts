/**
 * A runner: a machine that runs cases for an FDE Gym site (`pnpm runner`, in app/).
 *
 *   FDEGYM_SITE_URL          the site, e.g. https://gym.example.com
 *   FDEGYM_RUNNER_TOKEN      the site's join token (the same value as on the site)
 *   FDEGYM_RUNNER_NAME       what the site calls this machine (default: its host name). The name is
 *                            kept with the data folder, so the machine stays the same runner across restarts
 *   FDEGYM_RUNNER_CAPACITY   how many runs it takes at once (default 20)
 *   FDEGYM_DATA              where workspaces and fetched cases are kept (default ~/.fdegym-app)
 *   plus what ./harness reads about running commands (FDEGYM_EXEC_UID_BASE, FDEGYM_EXEC, ...)
 *
 * It connects to the site and answers its calls (./runner-api); nothing connects to it, so it can
 * be on any network that reaches the site. It holds none of the site's secrets: no database, no
 * object storage, no model key. Cases are fetched from the site, and the harness's model calls go
 * to the site's relay with a token that is good for one run.
 *
 * The site trusts what a runner reports (a run's result comes from here), and a runner does what
 * the site asks, so the join token is to be kept as carefully as an admin's password.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { setCaseSource } from './case-cache';
import { DATA_DIR, HARNESS_DIR, PYTHON } from './engine-paths';
import * as harness from './harness';
import type { AgentTurn } from './pi';
import { localInfo, localRunner, RUNNER_METHODS, type FromRunner, type NewRun, type NpcPath, type RunnerMethod, type ToRunner } from './runner-api';
import { SessionError } from './session-error';

const SITE = (process.env.FDEGYM_SITE_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.FDEGYM_RUNNER_TOKEN ?? '';
if (!/^https?:\/\//.test(SITE) || !TOKEN) {
  console.error('Set FDEGYM_SITE_URL (the site this machine runs cases for) and FDEGYM_RUNNER_TOKEN (its join token).');
  process.exit(1);
}
const CAPACITY = Math.max(1, Number(process.env.FDEGYM_RUNNER_CAPACITY) || 20);

/** Who this machine is to the site. Kept beside the runs, which are what make it that runner. */
function identity(): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, 'runner-name');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const base = (process.env.FDEGYM_RUNNER_NAME || hostname()).replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40) || 'runner';
  // Two machines given the same name are still two runners.
  const name = `${base}-${randomBytes(3).toString('hex')}`;
  writeFileSync(file, name);
  return name;
}
const NAME = identity();
const VERSION = (() => { try { return execFileSync(PYTHON, [join(HARNESS_DIR, 'run.py'), '--version'], { encoding: 'utf8' }).trim().split(' ').pop() ?? ''; } catch { return ''; } })();

// ---- cases come from the site

async function fromSite(path: string): Promise<Buffer> {
  const res = await fetch(`${SITE}${path}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} from the site`);
  return Buffer.from(await res.arrayBuffer());
}
setCaseSource({
  bundle: (id, sha) => fromSite(`/api/runner/cases/${id}/${sha}`),
  shared: async () => {
    const { sha } = JSON.parse(String(await fromSite('/api/runner/shared'))) as { sha: string | null };
    return sha ? { sha, archive: () => fromSite('/api/runner/shared/archive') } : undefined;
  },
});

// ---- answering the site

/** A run's name, as the site makes them: it becomes a folder here, so nothing else is taken. */
const runName = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(v) || v.startsWith('.')) throw new SessionError('not a run', 400);
  return v;
};
const text = (v: unknown) => (typeof v === 'string' ? v : '');

async function answer(method: RunnerMethod, args: unknown[], out: (text: string) => void): Promise<unknown> {
  switch (method) {
    case 'createRun': {
      const r = args[0] as NewRun;
      // The model is reached through the site, whatever the site says about where: this machine has no key to use otherwise.
      return localRunner.createRun({ ...r, name: runName(r.name), relay: r.relay ? { token: text(r.relay.token), url: `${SITE}/api/llm/v1/chat/completions` } : undefined });
    }
    case 'ensureServing': return localRunner.ensureServing(runName(args[0]));
    case 'stopServing': return localRunner.stopServing(runName(args[0]));
    case 'npc': return localRunner.npc(runName(args[0]), text(args[1]) as NpcPath, args[2]);
    case 'grade': return localRunner.grade(runName(args[0]));
    case 'task': return localRunner.task(runName(args[0]));
    case 'listFiles': return localRunner.listFiles(runName(args[0]));
    case 'readFile': return localRunner.readFile(runName(args[0]), text(args[1]));
    case 'writeFile': return localRunner.writeFile(runName(args[0]), text(args[1]), text(args[2]));
    case 'deletePath': return localRunner.deletePath(runName(args[0]), text(args[1]));
    case 'exec': return localRunner.exec(runName(args[0]), text(args[1]), text(args[2]), out, typeof args[3] === 'number' ? args[3] : undefined);
    case 'killExec': return localRunner.killExec(runName(args[0]));
    case 'execRunning': return localRunner.execRunning(runName(args[0]));
    case 'agentTurn': {
      const t = args[1] as AgentTurn;
      // As with a run's own model calls: through the site, whatever the site says about where.
      return localRunner.agentTurn(runName(args[0]), { ...t, message: text(t.message), model: text(t.model), token: text(t.token), system: text(t.system), url: `${SITE}/api/agent/v1` }, out);
    }
    case 'agentAttach': return localRunner.agentAttach(runName(args[0]), out);
    case 'agentStop': return localRunner.agentStop(runName(args[0]));
    case 'deleteRun': return localRunner.deleteRun(runName(args[0]));
    case 'changes': return localRunner.changes(runName(args[0]));
    case 'diff': return localRunner.diff(runName(args[0]), text(args[1]));
    case 'revertFile': return localRunner.revertFile(runName(args[0]), text(args[1]));
    case 'duplicate': return localRunner.duplicate(runName(args[0]), text(args[1]), args[2] === 'en' ? 'en' : 'zh');
    case 'sqlite': return localRunner.sqlite(runName(args[0]), text(args[1]), text(args[2]), Number(args[3]) || 0);
  }
}

// ---- the connection

let wait = 1000;
function connect() {
  const ws = new WebSocket(`${SITE.replace(/^http/, 'ws')}/api/runner/connect`, { headers: { authorization: `Bearer ${TOKEN}` }, maxPayload: 32 * 1024 * 1024 });
  const send = (m: FromRunner) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  let quiet: NodeJS.Timeout | undefined;
  const heard = () => { clearTimeout(quiet); quiet = setTimeout(() => ws.terminate(), 70_000); };

  ws.on('open', () => {
    wait = 1000;
    heard();
    send({ t: 'hello', name: NAME, capacity: CAPACITY, info: localInfo(), version: VERSION });
    console.log(`connected to ${SITE} as ${NAME}`);
  });
  ws.on('ping', heard);
  ws.on('message', (data) => {
    heard();
    let m: ToRunner;
    try { m = JSON.parse(String(data)) as ToRunner; } catch { return; }
    if (m.t !== 'call') return;
    const { id, method, args } = m;
    if (!(RUNNER_METHODS as readonly string[]).includes(method)) { send({ t: 'err', id, message: 'no such call', status: 400 }); return; }
    answer(method, Array.isArray(args) ? args : [], (t) => send({ t: 'out', id, text: t }))
      .then((value) => send({ t: 'ok', id, value: value ?? null }))
      .catch((e) => {
        if (!(e instanceof SessionError)) console.error(e);
        send({ t: 'err', id, message: e instanceof SessionError ? e.message : '沙箱机上出了错，请稍后再试', status: e instanceof SessionError ? e.status : 500 });
      });
  });
  ws.on('close', (code, reason) => {
    clearTimeout(quiet);
    if (code === 4003) { console.error('The site has disabled this runner.'); process.exit(1); }
    console.log(`disconnected from the site (${code}${reason.length ? ` ${reason}` : ''}); trying again in ${Math.round(wait / 1000)}s`);
    // Runs under way are untouched: their workspaces and the customer's people stay as they are until the site is back.
    setTimeout(connect, wait);
    wait = Math.min(30_000, wait * 2);
  });
  ws.on('unexpected-response', (_req, res) => {
    if (res.statusCode === 401) { console.error('The site refused the join token (FDEGYM_RUNNER_TOKEN).'); process.exit(1); }
    ws.terminate();
  });
  ws.on('error', (e) => { if (ws.readyState !== WebSocket.OPEN) console.error(`cannot reach ${SITE}: ${e.message}`); });
}

const info = harness.EXEC_MODE === 'off' ? 'off' : { user: 'one user per run', sandbox: 'sandboxed to the workspace', none: 'NOT ISOLATED' }[harness.EXEC_ISOLATION];
console.log(`FDE Gym runner ${NAME} (room for ${CAPACITY} runs; harness ${VERSION || 'unknown'}; commands: ${info})`);
if (harness.EXEC_MODE !== 'off' && harness.EXEC_ISOLATION === 'none') {
  console.warn('Commands run by learners are not isolated on this host: they can read other runs and the cases fetched to this machine. Run the runner in its container, or on macOS outside any other sandbox.');
}
connect();
