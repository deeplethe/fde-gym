/**
 * Driving the FDE-Gym harness in ../harness on this machine: harness/run.py the way an evaluation
 * drives it (new, serve, grade), so a person works in the same workspace, talks to the same
 * stakeholders and is graded by the same replay as an agent. This is what a sandbox machine does;
 * the site reaches it through ./runner-api, on its own machine or on another.
 *
 * Configuration (environment variables):
 *   FDEGYM_ROOT        repository root (default: the parent of app/)
 *   FDEGYM_DATA        learner runs and the cases fetched to run them (default: ~/.fdegym-app)
 *   FDEGYM_PYTHON      interpreter for the harness and for learners' commands (default: python3)
 *   FDEGYM_EXEC        `local` runs learners' commands on this machine, `off` removes the terminal
 *   FDEGYM_EXEC_UID_BASE  run each learner's commands as their own unprivileged user (see below)
 *   plus what the harness itself reads (FDEGYM_OPENROUTER_KEY_FILE, FDEGYM_PROXY, FDEGYM_MODEL)
 *
 * A learner's code runs with this server's privileges, both in the terminal and when the run is
 * graded (grading executes the delivered system). That is how the harness treats agents too. It is
 * fine on your own machine; a public deployment has to put the whole server in a disposable
 * container or VM. See docs/self-hosting.md.
 *
 * Inside that container (the server running as root, FDEGYM_EXEC_UID_BASE set) every run gets a
 * user id of its own: the workspace belongs to it, terminal commands run as it, and everything
 * else the server and the harness write is closed to it. That keeps a learner at the terminal out
 * of the repository (answers, graders), the model key, the databases and other learners'
 * workspaces. It does not cover code the harness itself executes from the workspace: a trial run
 * and grading import the delivered system into the harness's own process.
 */
import { execFile, spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, lchownSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { connect } from 'node:net';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { localCases } from './case-cache';
import { DATA_DIR, HARNESS_DIR, PYTHON, ROOT, RUNS_DIR } from './engine-paths';
import { SessionError } from './session-error';

const run = promisify(execFile);
const RUN_PY = join(HARNESS_DIR, 'run.py');
/**
 * What the harness is started with. Learner runs are kept in the site's data folder, and `cases` is
 * the folder holding the version of the case this run is on. The site's own secrets (the database,
 * object storage, the settings key, the maintainer token) are not the harness's business, and what
 * it is started with is inherited by everything it starts, so they are left out.
 */
const SITE_SECRET = /^(FDEGYM_DATABASE_URL|DATABASE_URL|PG[A-Z]+|FDEGYM_S3_.*|AWS_.*|FDEGYM_SECRET|FDEGYM_ADMIN_TOKEN|FDEGYM_ADMIN_EMAILS|FDEGYM_RUNNER_TOKEN)$/;
function harnessEnv(cases: string, name: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SITE_SECRET.test(k)));
  // What the learner delivered is run by the harness on a trial day and when it is graded: as the run's own user, where runs have one.
  const uid = runUid(name);
  return { ...env, FDEGYM_RUNS: RUNS_DIR, FDEGYM_ENGAGEMENTS: cases, PYTHONDONTWRITEBYTECODE: '1', ...relayEnv(name), ...(uid === undefined ? {} : { FDEGYM_DELIVERED_UID: String(uid) }) };
}

/**
 * A machine that holds no model key calls the site's relay instead (see ./llm-relay): the run was
 * given the relay's address and a token good for that run alone, kept beside its workspace where
 * the run's own user cannot read it. The harness reads the token where it would read a key.
 */
export interface Relay { url: string; token: string }
const relayFile = (name: string) => join(runDir(name), 'relay.json');
const relayKey = (name: string) => join(runDir(name), 'relay.key');
function relayEnv(name: string): NodeJS.ProcessEnv {
  if (!existsSync(relayFile(name))) return {};
  const { url } = JSON.parse(readFileSync(relayFile(name), 'utf8')) as { url: string };
  return { FDEGYM_LLM_URL: url, FDEGYM_OPENROUTER_KEY_FILE: relayKey(name) };
}

const UID_BASE = Number(process.env.FDEGYM_EXEC_UID_BASE) || undefined;
export const ISOLATED = UID_BASE !== undefined;
if (ISOLATED) {
  if (process.getuid?.() !== 0) throw new Error('FDEGYM_EXEC_UID_BASE needs the server to run as root (inside its container), so it can start commands as other users');
  // Whatever the server and the harness create from here on is theirs alone; workspaces are handed over explicitly.
  process.umask(0o077);
}

const uidFile = (name: string) => join(runDir(name), 'uid');
export const runUid = (name: string): number | undefined => (ISOLATED && existsSync(uidFile(name)) ? Number(readFileSync(uidFile(name), 'utf8')) : undefined);

function nextUid(): number {
  const counter = join(DATA_DIR, 'exec-uid.next');
  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  writeFileSync(counter, String(n + 1));
  return UID_BASE! + n;
}

function chownTree(path: string, uid: number) {
  lchownSync(path, uid, uid);
  if (statSync(path).isDirectory()) for (const e of readdirSync(path)) chownTree(join(path, e), uid);
}

/**
 * What the customer handed over is to be read, not changed: the brief, their documents and data,
 * and the harness's own tools for asking them. A learner's work is in system/ and deliverables/.
 * (A trial day leaves its log under data/; the harness writes that, with its own rights.)
 * The file API refuses these paths; where runs have a user of their own they are also not that
 * user's to write, and under the macOS sandbox writing them is denied, so a command or the coding
 * agent cannot overwrite or remove them either.
 */
export const KEPT = ['TASK.md', 'bin', 'docs', 'data'];
const kept = (path: string) => KEPT.some((k) => path === k || path.startsWith(`${k}/`));

/** Root's, and only to be read (and run, where it could be) by the run's group. */
function keepTree(path: string, gid: number) {
  lchownSync(path, 0, gid);
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  chmodSync(path, st.isDirectory() || (st.mode & 0o100) ? 0o750 : 0o640);
  if (st.isDirectory()) for (const e of readdirSync(path)) keepTree(join(path, e), gid);
}

/** Give the run's workspace to a user of its own and close the rest of the run folder to it. */
function isolate(name: string) {
  const uid = nextUid();
  writeFileSync(uidFile(name), String(uid));
  // Folders on the way to the workspace can be passed through, not listed.
  for (const d of [DATA_DIR, RUNS_DIR, runDir(name)]) chmodSync(d, 0o711);
  mkdirSync(join(runDir(name), 'state'), { recursive: true }); // customer services keep their state here
  const ws = workspaceDir(name);
  chownTree(ws, uid);
  for (const k of KEPT) if (existsSync(join(ws, k))) keepTree(join(ws, k), uid);
  // The workspace itself stays root's, open to the run's group and sticky: the user can make and
  // remove what is theirs in it, and cannot rename or remove what was kept from them.
  lchownSync(ws, 0, uid);
  chmodSync(ws, 0o1770);
}

export const runDir = (name: string) => join(RUNS_DIR, name);
export const workspaceDir = (name: string) => join(runDir(name), 'workspace');
/** The workspace as it was built: beside it, closed to the run's user like the rest of the run folder. */
const baselineDir = (name: string) => join(runDir(name), 'baseline');

interface Meta { engagement: string; level: string; port: number; llm_port?: number; service_ports?: Record<string, number> }
const meta = (name: string): Meta => JSON.parse(readFileSync(join(runDir(name), 'meta.json'), 'utf8'));

/**
 * Which version of which case a run is on, kept beside its workspace: the run is served and graded
 * on that version, fetched again from object storage if this machine no longer has it.
 */
const bundleFile = (name: string) => join(runDir(name), 'bundle.json');
async function casesOf(name: string): Promise<string> {
  const b = JSON.parse(readFileSync(bundleFile(name), 'utf8')) as { id: string; sha: string };
  try { return await localCases(b.id, b.sha); } catch (e) {
    console.error(e);
    throw new SessionError('题目文件暂时取不到，请稍后再试', 503);
  }
}

/** `run.py new`: build a fresh workspace for version `sha` of the case. `relay`: where this run's model calls go, when not straight to the provider. */
export async function createRun(engagement: string, sha: string, level: string, name: string, variant?: string, relay?: Relay) {
  if (!/^[A-Za-z0-9_.-]{1,160}$/.test(name) || existsSync(runDir(name))) throw new SessionError('工作区准备失败，请稍后再试', 500);
  mkdirSync(RUNS_DIR, { recursive: true });
  let cases: string;
  try { cases = await localCases(engagement, sha); } catch (e) {
    console.error(e);
    throw new SessionError('题目文件暂时取不到，请稍后再试', 503);
  }
  try {
    await run(PYTHON, [RUN_PY, 'new', '--engagement', engagement, '--level', level, '--name', name, ...(variant && variant !== 'base' ? ['--variant', variant] : [])], { env: harnessEnv(cases, name), timeout: 120_000 });
    writeFileSync(bundleFile(name), JSON.stringify({ id: engagement, sha }));
    // The workspace as built, kept to tell later what has changed in it (see `changes`).
    cpSync(workspaceDir(name), baselineDir(name), { recursive: true, verbatimSymlinks: true });
    if (relay) {
      writeFileSync(relayKey(name), relay.token, { mode: 0o600 });
      writeFileSync(relayFile(name), JSON.stringify({ url: relay.url }), { mode: 0o600 });
    }
  } catch (e) {
    console.error(e);
    rmSync(runDir(name), { recursive: true, force: true });
    throw new SessionError('工作区准备失败，请稍后再试', 500);
  }
  if (ISOLATED) isolate(name);
}

// ---- the run's stakeholders, LLM gateway and customer services (`run.py serve`)

const portOpen = (port: number) => new Promise<boolean>((done) => {
  const s = connect({ host: '127.0.0.1', port });
  const end = (ok: boolean) => { s.destroy(); done(ok); };
  s.setTimeout(500, () => end(false));
  s.once('connect', () => end(true));
  s.once('error', () => end(false));
});

const starting = new Map<string, Promise<void>>();
const pidFile = (name: string) => join(runDir(name), 'serve.pid');

/**
 * Make sure the run's services are up. They are started detached and found again by their port, so
 * restarting this server does not restart them: the stakeholders keep what has been asked so far in
 * memory, and a restart would hand the learner a fresh question allowance and calendar.
 */
export function ensureServing(name: string): Promise<void> {
  const pending = starting.get(name);
  if (pending) return pending;
  const p = (async () => {
    const m = meta(name);
    const ports = [m.port, ...(m.llm_port ? [m.llm_port] : []), ...Object.values(m.service_ports ?? {})];
    if ((await Promise.all(ports.map(portOpen))).every(Boolean)) return;
    stopServing(name); // a half-dead set: start over
    const cases = await casesOf(name);
    const log = openSync(join(runDir(name), 'logs', 'serve.log'), 'a');
    const child = spawn(PYTHON, [RUN_PY, 'serve', '--name', name], { env: harnessEnv(cases, name), detached: true, stdio: ['ignore', log, log] });
    child.unref();
    writeFileSync(pidFile(name), String(child.pid));
    for (let i = 0; i < 100; i++) {
      if ((await Promise.all(ports.map(portOpen))).every(Boolean)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new SessionError('客户方环境没有启动成功，请稍后再试', 503);
  })().finally(() => starting.delete(name));
  starting.set(name, p);
  return p;
}

export function stopServing(name: string) {
  if (!existsSync(pidFile(name))) return;
  const pid = Number(readFileSync(pidFile(name), 'utf8'));
  // The serve process is its own group leader (detached); it stops its children on SIGTERM.
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  rmSync(pidFile(name), { force: true });
}

/** Call the run's stakeholder server (harness/npc_server.py). */
export async function npc<T>(name: string, path: '/who' | '/now' | '/ask' | '/wait' | '/pilot' | '/inbox', payload?: unknown): Promise<T> {
  await ensureServing(name);
  const res = await fetch(`http://127.0.0.1:${meta(name).port}${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    ...(payload === undefined ? {} : { body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }),
    signal: AbortSignal.timeout(path === '/pilot' ? 1_800_000 : 180_000),
  });
  const data = await res.json() as T & { error?: string };
  if (data.error) throw new SessionError(data.error);
  return data;
}

// ---- grading (`run.py grade`)

const grading = new Map<string, Promise<Record<string, unknown>>>();
/**
 * Replays held-out traffic through the workspace; takes minutes. Resolves to the harness's result.
 * Asked twice for the same run (the site lost touch and asked again), the second waits for the first.
 */
export function grade(name: string): Promise<Record<string, unknown>> {
  let p = grading.get(name);
  if (!p) {
    p = (async () => {
      await run(PYTHON, [RUN_PY, 'grade', '--name', name], { env: harnessEnv(await casesOf(name), name), timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024 });
      return JSON.parse(readFileSync(join(runDir(name), 'result.json'), 'utf8')) as Record<string, unknown>;
    })().finally(() => grading.delete(name));
    grading.set(name, p);
  }
  return p;
}

/** The run's brief, as the workspace has it. */
export function taskOf(name: string): string {
  const p = join(workspaceDir(name), 'TASK.md');
  if (!existsSync(p)) throw new SessionError('这次练习的工作区已不存在', 410);
  return readFileSync(p, 'utf8');
}

/** Remove everything this machine holds of a run: its services are stopped, a command still running is ended, its folder goes. */
export function deleteRun(name: string) {
  if (!existsSync(runDir(name))) return;
  stopServing(name);
  killExec(name);
  rmSync(runDir(name), { recursive: true, force: true });
}

// ---- workspace files

const SKIP = new Set(['__pycache__', '.DS_Store', '.git']);
const MAX_READ = 1024 * 1024;
const MAX_WRITE = 2 * 1024 * 1024;
const MAX_ENTRIES = 5000;

/**
 * Absolute path of a workspace-relative path; refuses anything that leaves the workspace. That
 * includes a link inside the workspace that points out of it: the server reads and writes with more
 * rights than the learner's commands have, so it must not follow one.
 */
export function resolveIn(name: string, path: string): string {
  const root = workspaceDir(name);
  const abs = resolve(root, path);
  const inside = (p: string, base: string) => p === base || p.startsWith(base + sep);
  if (!inside(abs, root)) throw new SessionError('路径不在工作区内');
  // Where the deepest part of the path that exists really is, links resolved.
  let existing = abs;
  while (!existsSync(existing) && existing !== root) existing = dirname(existing);
  if (!inside(realpathSync(existing), realpathSync(root))) throw new SessionError('路径不在工作区内');
  return abs;
}

export interface FileEntry { path: string; dir: boolean; bytes: number }

export function listFiles(name: string): FileEntry[] {
  const root = workspaceDir(name);
  const out: FileEntry[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (SKIP.has(e.name) || e.isSymbolicLink() || out.length >= MAX_ENTRIES) continue;
      const abs = join(dir, e.name);
      const path = relative(root, abs).split(sep).join('/');
      if (e.isDirectory()) { out.push({ path, dir: true, bytes: 0 }); walk(abs); }
      else if (e.isFile()) out.push({ path, dir: false, bytes: statSync(abs).size });
    }
  };
  walk(root);
  return out;
}

export function readFile(name: string, path: string): { content: string; bytes: number; truncated: boolean; binary: boolean } {
  const abs = resolveIn(name, path);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new SessionError(`文件不存在：${path}`, 404);
  const bytes = statSync(abs).size;
  const buf = readFileSync(abs).subarray(0, MAX_READ);
  if (buf.subarray(0, 8000).includes(0)) return { content: '', bytes, truncated: false, binary: true };
  return { content: buf.toString('utf8'), bytes, truncated: bytes > MAX_READ, binary: false };
}

/** The brief, the customer's documents and the harness's own tools are not the learner's to change (see KEPT). */
const readOnly = (path: string) => kept(path);
const clean = (path: string) => path.split('/').filter((s) => s && s !== '.').join('/');

export function writeFile(name: string, path: string, content: string) {
  path = clean(path);
  if (!path || readOnly(path)) throw new SessionError('这个文件不能修改');
  if (Buffer.byteLength(content) > MAX_WRITE) throw new SessionError('文件太大（上限 2 MB）');
  const abs = resolveIn(name, path);
  if (existsSync(abs) && !statSync(abs).isFile()) throw new SessionError('这是一个目录');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  // The server wrote it; the file, and any folder made for it, belong to the run's user.
  const uid = runUid(name);
  if (uid !== undefined) for (let p = abs; p !== workspaceDir(name); p = dirname(p)) lchownSync(p, uid, uid);
}

export function deletePath(name: string, path: string) {
  path = clean(path);
  if (!path || readOnly(path)) throw new SessionError('这个文件不能修改');
  rmSync(resolveIn(name, path), { recursive: true, force: true });
}

/**
 * A copy of a file or folder beside the original, named as a desktop names one: "report - 副本.md",
 * then "report - 副本 2.md" (or "report copy.md" for a reader of English). Returns the copy's path.
 */
export function duplicate(name: string, path: string, lang: 'zh' | 'en'): string {
  path = clean(path);
  if (!path || readOnly(path)) throw new SessionError('这里的文件是只读的，不能在原位建副本');
  const abs = resolveIn(name, path);
  if (!existsSync(abs)) throw new SessionError(`文件不存在：${path}`, 404);
  const dir = dirname(path) === '.' ? '' : dirname(path), base = path.slice(dir ? dir.length + 1 : 0);
  // The extension is what follows the last dot, unless the name only begins with one (a dotfile) or it is a folder.
  const dot = statSync(abs).isDirectory() ? -1 : base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base, ext = dot > 0 ? base.slice(dot) : '';
  const word = lang === 'zh' ? ' - 副本' : ' copy';
  for (let n = 1; n < 1000; n++) {
    const to = `${dir ? `${dir}/` : ''}${stem}${word}${n === 1 ? '' : ` ${n}`}${ext}`;
    const target = resolveIn(name, to);
    if (existsSync(target)) continue;
    cpSync(abs, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    const uid = runUid(name);
    if (uid !== undefined) chownTree(target, uid);
    return to;
  }
  throw new SessionError('副本太多了，先清理一些');
}

// ---- what has changed since the workspace was built

export interface Change { path: string; status: 'added' | 'modified' | 'deleted'; /** Lines added and removed; null for a file that is not text, or too large to compare. */ added: number | null; removed: number | null }
const MAX_COMPARE = 1024 * 1024;
const MAX_DIFF = 200_000;

/** Every file under a folder, by its path from there. Links are left out, as they are from the file tree. */
function filesUnder(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.isSymbolicLink() || out.size >= MAX_ENTRIES) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.set(relative(root, abs).split(sep).join('/'), abs);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}
const isText = (file: string) => statSync(file).size <= MAX_COMPARE && !readFileSync(file).subarray(0, 8000).includes(0);
const lines = (file: string) => { const s = readFileSync(file, 'utf8'); return s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0; };
/** `diff` between two files (either may be absent), as unified text. It exits with 1 when they differ, which is not a failure. */
async function unified(a: string | undefined, b: string | undefined, path: string, context: number): Promise<string> {
  try {
    return (await run('diff', [`-U${context}`, '--label', a ? `a/${path}` : '/dev/null', '--label', b ? `b/${path}` : '/dev/null', a ?? '/dev/null', b ?? '/dev/null'], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (e) {
    const r = e as { code?: number; stdout?: string };
    if (r.code === 1 && typeof r.stdout === 'string') return r.stdout;
    throw e;
  }
}

/** What differs in the workspace from how it was built; undefined for a run made before the copy was kept. */
export async function changes(name: string): Promise<Change[] | undefined> {
  if (!existsSync(baselineDir(name))) return undefined;
  const was = filesUnder(baselineDir(name)), now = filesUnder(workspaceDir(name));
  const out: Change[] = [];
  for (const path of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const a = was.get(path), b = now.get(path);
    if (out.length >= 500) break;
    if (a && b) {
      if (statSync(a).size === statSync(b).size && readFileSync(a).equals(readFileSync(b))) continue;
      if (!isText(a) || !isText(b)) { out.push({ path, status: 'modified', added: null, removed: null }); continue; }
      const body = (await unified(a, b, path, 0)).split('\n').slice(2);
      out.push({ path, status: 'modified', added: body.filter((l) => l.startsWith('+')).length, removed: body.filter((l) => l.startsWith('-')).length });
    } else if (b) out.push({ path, status: 'added', added: isText(b) ? lines(b) : null, removed: 0 });
    else out.push({ path, status: 'deleted', added: 0, removed: isText(a!) ? lines(a!) : null });
  }
  return out;
}

/** The change to one file since the workspace was built, as a unified diff. */
export async function diffOf(name: string, path: string): Promise<{ diff: string; truncated: boolean; binary: boolean }> {
  path = clean(path);
  const base = resolve(baselineDir(name), path);
  if (!path || !base.startsWith(baselineDir(name) + sep)) throw new SessionError('路径不在工作区内');
  const now = resolveIn(name, path);
  const a = existsSync(base) && statSync(base).isFile() ? base : undefined, b = existsSync(now) && statSync(now).isFile() ? now : undefined;
  if (!a && !b) throw new SessionError(`文件不存在：${path}`, 404);
  if ((a && !isText(a)) || (b && !isText(b))) return { diff: '', truncated: false, binary: true };
  const diff = await unified(a, b, path, 3);
  return { diff: diff.slice(0, MAX_DIFF), truncated: diff.length > MAX_DIFF, binary: false };
}

/** Put one file back as it was when the workspace was built; a file that was not there then is removed. */
export function revertFile(name: string, path: string) {
  path = clean(path);
  const base = resolve(baselineDir(name), path);
  if (!path || readOnly(path) || !base.startsWith(baselineDir(name) + sep)) throw new SessionError('这个文件不能修改');
  if (!existsSync(baselineDir(name))) throw new SessionError('这次练习没有留下最初的文件，不能还原');
  const abs = resolveIn(name, path);
  if (!(existsSync(base) && statSync(base).isFile())) { rmSync(abs, { force: true }); return; }
  mkdirSync(dirname(abs), { recursive: true });
  copyFileSync(base, abs);
  const uid = runUid(name);
  if (uid !== undefined) for (let p = abs; p !== workspaceDir(name); p = dirname(p)) lchownSync(p, uid, uid);
}

// ---- looking into a SQLite database in the workspace

export interface SqliteView {
  /** Every table and view in the file, with how many rows each holds. */
  tables: { name: string; kind: 'table' | 'view'; rows: number | null }[];
  /** The one being looked at (the first, unless another was asked for). */
  table?: string;
  columns: string[];
  rows: (string | number | null)[][];
  offset: number;
  total: number | null;
}
const SQLITE_ROWS = 200;
// Opened to be read only. Run by the interpreter the learner's own commands use, as their user:
// the file is theirs to have changed, so it is not opened with the server's rights.
const SQLITE_READER = `
import json, sqlite3, sys, urllib.parse
path, want, offset, limit = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
con = sqlite3.connect("file:" + urllib.parse.quote(path) + "?mode=ro", uri=True, timeout=5)
q = lambda name: '"' + name.replace('"', '""') + '"'
def count(name):
    try:
        return con.execute("SELECT COUNT(*) FROM " + q(name)).fetchone()[0]
    except sqlite3.Error:
        return None
tables = [{"name": n, "kind": k, "rows": count(n)} for n, k in con.execute(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name")]
out = {"tables": tables, "columns": [], "rows": [], "offset": offset, "total": None}
names = [t["name"] for t in tables]
table = want if want in names else (names[0] if names else None)
if table:
    cur = con.execute("SELECT * FROM " + q(table) + " LIMIT ? OFFSET ?", (limit, offset))
    def cell(v):
        if isinstance(v, bytes):
            return "<%d bytes>" % len(v)
        if isinstance(v, str) and len(v) > 400:
            return v[:400] + "…"
        return v
    out.update(table=table, columns=[d[0] for d in cur.description], rows=[[cell(v) for v in r] for r in cur.fetchall()],
               total=next(t["rows"] for t in tables if t["name"] == table))
json.dump(out, sys.stdout)
`;

/** The tables of a SQLite file in the workspace and one page of rows from one of them. */
export async function sqliteView(name: string, path: string, table = '', offset = 0): Promise<SqliteView> {
  const abs = resolveIn(name, path);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new SessionError(`文件不存在：${path}`, 404);
  const uid = runUid(name);
  if (ISOLATED && uid === undefined) throw new SessionError('这个文件现在不能查看');
  const profile = SANDBOXED ? sandboxProfile(name) : undefined;
  if (SANDBOXED && !profile) throw new SessionError('这个文件现在不能查看');
  const args = ['-I', '-c', SQLITE_READER, abs, table, String(Math.max(0, Math.floor(offset) || 0)), String(SQLITE_ROWS)];
  const [program, argv] = limited(profile ? SANDBOX_EXEC : PYTHON, [...(profile ? ['-p', profile, PYTHON] : []), ...args]);
  try {
    const { stdout } = await run(program, argv, {
      cwd: workspaceDir(name), timeout: 20_000, maxBuffer: 16 * 1024 * 1024, ...(uid === undefined ? {} : { uid, gid: uid }),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
    });
    return JSON.parse(stdout) as SqliteView;
  } catch (e) {
    const said = String((e as { stderr?: string }).stderr ?? '').trim().split('\n').pop() ?? '';
    throw new SessionError(/not a database|malformed|encrypted/.test(said) ? '这不是一个能打开的 SQLite 数据库' : '这个数据库现在读不出来，可以在终端里用 sqlite3 查');
  }
}

// ---- the terminal: one command at a time, in the workspace

export const EXEC_MODE: 'local' | 'off' = process.env.FDEGYM_EXEC === 'off' ? 'off' : 'local';
const EXEC_TIMEOUT_MS = Number(process.env.FDEGYM_EXEC_TIMEOUT_S ?? 1800) * 1000;
const EXEC_MAX_OUTPUT = 400_000;

/**
 * Outside a container on macOS, commands run under the system sandbox: no reading or writing the
 * home directory, the repository or the site's data (the cases are in it), except the run's own
 * workspace. So a learner's or the agent's commands cannot reach answers, graders, other runs'
 * results or the model key. Inside the container the per-run user does this job (see above). On
 * any other host there is nothing: say so at start-up. FDEGYM_EXEC_SANDBOX=0 turns it off.
 */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const SANDBOXED = !ISOLATED && process.platform === 'darwin' && process.env.FDEGYM_EXEC_SANDBOX !== '0' && existsSync(SANDBOX_EXEC)
  // A process that is itself sandboxed cannot start another sandbox; find out now, not on a learner's first command.
  && spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

/** Paths go into the profile inside double quotes. */
const quotable = (p: string) => !/["\\]/.test(p);
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

/** `also`: more that may be read (and, for `write`, written) besides the workspace; the coding agent needs its own program and a folder for its session. */
export function sandboxProfile(name: string, also: { read?: string[]; write?: string[] } = {}): string | undefined {
  const ws = real(workspaceDir(name));
  const closed = [...new Set([homedir(), ROOT, DATA_DIR].map(real))];
  const read = (also.read ?? []).map(real), write = (also.write ?? []).map(real);
  if (![ws, ...closed, ...read, ...write].every(quotable)) return undefined;
  // A program started from one of these folders resolves its own path, which looks at (not into) each folder on the way down.
  const above = new Set<string>();
  for (const p of [...read, ...write]) for (let d = dirname(p); d !== dirname(d); d = dirname(d)) above.add(d);
  return '(version 1)(allow default)'
    + closed.map((p) => `(deny file-read* (subpath "${p}"))(deny file-write* (subpath "${p}"))`).join('')
    + [ws, ...write].map((p) => `(allow file-read* (subpath "${p}"))(allow file-write* (subpath "${p}"))`).join('')
    // What was handed over to be read stays as it was (see KEPT).
    + KEPT.map((k) => `(deny file-write* (subpath "${join(ws, k)}"))`).join('')
    + read.map((p) => `(allow file-read* (subpath "${p}"))`).join('')
    + [...above].map((p) => `(allow file-read-metadata (literal "${p}"))`).join('');
}

/**
 * In the container a run's commands (and its coding agent) also run under limits of their own, so
 * that one run cannot take the machine from the others: so many processes at once, counted for the
 * run's own user (FDEGYM_EXEC_NPROC, default 512; a fork bomb stops there), and no file larger than
 * FDEGYM_EXEC_FSIZE_MB (default 2048). Memory and CPU are the container's to limit.
 */
const PRLIMIT = '/usr/bin/prlimit';
const LIMITS = ISOLATED && existsSync(PRLIMIT)
  ? [`--nproc=${Math.max(16, Number(process.env.FDEGYM_EXEC_NPROC) || 512)}`, `--fsize=${Math.max(1, Number(process.env.FDEGYM_EXEC_FSIZE_MB) || 2048) * 1024 * 1024}`, '--core=0', '--']
  : undefined;
/** The program and arguments to start, with the run's limits put on them where there are any. */
export const limited = (program: string, args: string[]): [string, string[]] => (LIMITS ? [PRLIMIT, [...LIMITS, program, ...args]] : [program, args]);

/** How far commands are kept from everything outside the workspace. */
export const EXEC_ISOLATION: 'user' | 'sandbox' | 'none' = ISOLATED ? 'user' : SANDBOXED ? 'sandbox' : 'none';

const running = new Map<string, ChildProcess>();

/**
 * Run a shell command in the workspace and stream what it prints. The environment is cut down to
 * what a command needs, so the server's own keys and settings are not handed to it.
 */
export function execIn(name: string, command: string, cwd: string, onData: (text: string) => void, timeoutMs = EXEC_TIMEOUT_MS): Promise<{ code: number | null; signal: string | null; truncated: boolean }> {
  if (EXEC_MODE === 'off') throw new SessionError('本站没有开放终端');
  if (running.has(name)) throw new SessionError('上一条命令还在运行');
  const dir = resolveIn(name, cwd || '.');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new SessionError('目录不存在');
  const ws = workspaceDir(name);
  const uid = runUid(name);
  if (ISOLATED && uid === undefined) throw new SessionError('本站没有开放终端');
  const profile = SANDBOXED ? sandboxProfile(name) : undefined;
  if (SANDBOXED && !profile) throw new SessionError('本站没有开放终端');
  const child = spawn(...limited(profile ? SANDBOX_EXEC : '/bin/sh', [...(profile ? ['-p', profile, '/bin/sh'] : []), '-c', command]), {
    cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...(uid === undefined ? {} : { uid, gid: uid }),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: ws, TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'en_US.UTF-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', TERM: 'dumb' },
  });
  running.set(name, child);
  let sent = 0, truncated = false;
  const feed = (b: Buffer) => {
    if (truncated) return;
    let text = b.toString('utf8');
    if (sent + text.length > EXEC_MAX_OUTPUT) { text = text.slice(0, EXEC_MAX_OUTPUT - sent); truncated = true; }
    sent += text.length;
    if (text) onData(text);
  };
  child.stdout!.on('data', feed);
  child.stderr!.on('data', feed);
  const timer = setTimeout(() => killExec(name), timeoutMs);
  return new Promise((done) => {
    const end = (code: number | null, signal: string | null) => { clearTimeout(timer); running.delete(name); done({ code, signal, truncated }); };
    child.once('error', () => end(127, null));
    child.once('close', end);
  });
}

/** Stop the running command and everything it started. */
export function killExec(name: string): boolean {
  const child = running.get(name);
  if (!child?.pid) return false;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  return true;
}

export const execRunning = (name: string) => running.has(name);
