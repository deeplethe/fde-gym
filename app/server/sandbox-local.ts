/**
 * The sandbox on this machine's own disk (see ./sandbox): a run's workspace is a folder beside the
 * rest of the run, and its commands are processes of this machine, kept from everything else as
 * far as the host allows.
 *
 * Inside the runner's container (the server running as root, FDEGYM_EXEC_UID_BASE set) every run
 * gets a user id of its own: the workspace belongs to it, commands run as it, and everything else
 * the server and the harness write is closed to it. That keeps a learner at the terminal out of the
 * repository (answers, graders), the model key, the databases and other learners' workspaces.
 * Outside a container on macOS, commands run under the system sandbox instead. On any other host
 * there is nothing: the runner says so at start-up.
 *
 * The server itself reads and writes the workspace with its own rights, so it never follows a link
 * out of it, and what it writes is handed to the run's user as if a command had made it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lchownSync, lstatSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { ROOT } from './engine-paths';
import type { ExecOptions, ExecResult, FileEntry, SandboxProvider, SandboxStat } from './sandbox';
import { SandboxUnavailable } from './sandbox';
import { SessionError } from './session-error';

const UID_BASE = Number(process.env.FDEGYM_EXEC_UID_BASE) || undefined;
export const ISOLATED = UID_BASE !== undefined;
if (ISOLATED) {
  if (process.getuid?.() !== 0) throw new Error('FDEGYM_EXEC_UID_BASE needs the server to run as root (inside its container), so it can start commands as other users');
  // Whatever the server and the harness create from here on is theirs alone; workspaces are handed over explicitly.
  process.umask(0o077);
}

/**
 * Outside a container on macOS, commands run under the system sandbox: no reading or writing the
 * home directory, the repository or the site's data (the cases are in it), except the run's own
 * workspace. FDEGYM_EXEC_SANDBOX=0 turns it off.
 */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const SANDBOXED = !ISOLATED && process.platform === 'darwin' && process.env.FDEGYM_EXEC_SANDBOX !== '0' && existsSync(SANDBOX_EXEC)
  // A process that is itself sandboxed cannot start another sandbox; find out now, not on a learner's first command.
  && spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

/**
 * In the container a run's commands also run under limits of their own, so that one run cannot
 * take the machine from the others: so many processes at once, counted for the run's own user
 * (FDEGYM_EXEC_NPROC, default 512; a fork bomb stops there), and no file larger than
 * FDEGYM_EXEC_FSIZE_MB (default 2048). Memory and CPU are the container's to limit.
 */
const PRLIMIT = '/usr/bin/prlimit';
const LIMITS = ISOLATED && existsSync(PRLIMIT)
  ? [`--nproc=${Math.max(16, Number(process.env.FDEGYM_EXEC_NPROC) || 512)}`, `--fsize=${Math.max(1, Number(process.env.FDEGYM_EXEC_FSIZE_MB) || 2048) * 1024 * 1024}`, '--core=0', '--']
  : undefined;
/** The program and arguments to start, with the run's limits put on them where there are any. */
export const limited = (program: string, args: string[]): [string, string[]] => (LIMITS ? [PRLIMIT, [...LIMITS, program, ...args]] : [program, args]);

/** Paths go into the profile inside double quotes. */
const quotable = (p: string) => !/["\\]/.test(p);
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const inside = (p: string, base: string) => p === base || p.startsWith(base + sep);

function chownTree(path: string, uid: number) {
  lchownSync(path, uid, uid);
  if (statSync(path).isDirectory()) for (const e of readdirSync(path)) chownTree(join(path, e), uid);
}

/** Root's, and only to be read (and run, where it could be) by the run's group. */
function keepTree(path: string, gid: number) {
  lchownSync(path, 0, gid);
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  chmodSync(path, st.isDirectory() || (st.mode & 0o100) ? 0o750 : 0o640);
  if (st.isDirectory()) for (const e of readdirSync(path)) keepTree(join(path, e), gid);
}

export class LocalProvider implements SandboxProvider {
  readonly isolation = ISOLATED ? 'user' as const : SANDBOXED ? 'sandbox' as const : 'none' as const;
  /** What each run has running, to be ended with it. */
  private readonly running = new Map<string, Set<number>>();
  /** What was kept read-only in each run's workspace, for the macOS profile (it is not written down anywhere else). */
  private readonly kept = new Map<string, string[]>();

  /** `runsDir/<id>/workspace` is a run's workspace; `dataDir` is everything of the site's on this disk. */
  constructor(private readonly opts: { runsDir: string; dataDir: string; readOnly?: string[] }) {}

  workspace(id: string) { return join(this.opts.runsDir, id, 'workspace'); }
  private uidFile(id: string) { return join(this.opts.runsDir, id, 'uid'); }
  /** The run's own user, where runs have one. */
  uid(id: string): number | undefined { return ISOLATED && existsSync(this.uidFile(id)) ? Number(readFileSync(this.uidFile(id), 'utf8')) : undefined; }

  private nextUid(): number {
    const counter = join(this.opts.dataDir, 'exec-uid.next');
    const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    writeFileSync(counter, String(n + 1));
    return UID_BASE! + n;
  }

  /** Give the run's workspace to a user of its own and close the rest of the run folder to it. */
  async create(id: string, { readOnly }: { readOnly: string[] }) {
    this.kept.set(id, readOnly);
    if (!ISOLATED) return;
    const uid = this.nextUid();
    writeFileSync(this.uidFile(id), String(uid));
    // Folders on the way to the workspace can be passed through, not listed.
    for (const d of [this.opts.dataDir, this.opts.runsDir, join(this.opts.runsDir, id)]) chmodSync(d, 0o711);
    const ws = this.workspace(id);
    chownTree(ws, uid);
    for (const k of readOnly) if (existsSync(join(ws, k))) keepTree(join(ws, k), uid);
    // The workspace itself stays root's, open to the run's group and sticky: the user can make and
    // remove what is theirs in it, and cannot rename or remove what was kept from them.
    lchownSync(ws, 0, uid);
    chmodSync(ws, 0o1770);
  }

  /**
   * Absolute path of a workspace-relative path; refuses anything that leaves the workspace. That
   * includes a link inside the workspace that points out of it: the server reads and writes with
   * more rights than the learner's commands have, so it must not follow one.
   */
  resolve(id: string, path: string): string {
    return this.locate(id, path).abs;
  }

  /** `abs` as asked for, and `real`: where that really is, every link on the way resolved. */
  private locate(id: string, path: string): { abs: string; real: string } {
    const root = this.workspace(id);
    if (!existsSync(root)) throw new SessionError('这次练习的工作区已不存在', 410);
    const abs = resolve(root, path);
    if (!inside(abs, root)) throw new SessionError('路径不在工作区内');
    // Where the deepest part of the path that is there really is, links resolved. A link whose
    // target is not there counts as there: following it would make whatever it names.
    const there = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
    let existing = abs;
    while (!there(existing) && existing !== root) existing = dirname(existing);
    let real: string;
    try { real = realpathSync(existing); } catch { throw new SessionError('路径不在工作区内'); }
    if (!inside(real, realpathSync(root))) throw new SessionError('路径不在工作区内');
    return { abs, real: join(real, relative(existing, abs)) };
  }

  /** A path the server is to change: not one of what was kept read-only, reached by its own name or through a link. */
  private writable(id: string, path: string, { followLast = true } = {}): string {
    const { abs, real: through } = this.locate(id, path);
    const ws = this.workspace(id);
    // A link that is itself to be removed is not followed; the links above it are.
    const real = followLast || abs === ws ? through : join(this.locate(id, dirname(abs)).real, basename(abs));
    const rel = relative(realpathSync(ws), real).split(sep).join('/');
    if ((this.kept.get(id) ?? this.opts.readOnly ?? []).some((k) => rel === k || rel.startsWith(`${k}/`))) throw new SessionError('这个文件不能修改');
    return abs;
  }

  /** The server made it; it, and any folder made for it, belong to the run's user. */
  private handOver(id: string, abs: string, upTo = this.workspace(id)) {
    const uid = this.uid(id);
    if (uid !== undefined) for (let p = abs; p !== upTo && p !== this.workspace(id); p = dirname(p)) lchownSync(p, uid, uid);
  }

  /**
   * The macOS profile a run's commands start under. `also`: more that may be read (and, for
   * `write`, written) besides the workspace.
   */
  profile(id: string, also: { read?: string[]; write?: string[] } = {}): string | undefined {
    const ws = real(this.workspace(id));
    const closed = [...new Set([homedir(), ROOT, this.opts.dataDir].map(real))];
    const read = (also.read ?? []).map(real), write = (also.write ?? []).map(real);
    if (![ws, ...closed, ...read, ...write].every(quotable)) return undefined;
    // A program started from one of these folders resolves its own path, which looks at (not into) each folder on the way down.
    const above = new Set<string>();
    for (const p of [...read, ...write]) for (let d = dirname(p); d !== dirname(d); d = dirname(d)) above.add(d);
    return '(version 1)(allow default)'
      + closed.map((p) => `(deny file-read* (subpath "${p}"))(deny file-write* (subpath "${p}"))`).join('')
      + [ws, ...write].map((p) => `(allow file-read* (subpath "${p}"))(allow file-write* (subpath "${p}"))`).join('')
      // What was handed over to be read stays as it was.
      + (this.kept.get(id) ?? this.opts.readOnly ?? []).map((k) => `(deny file-write* (subpath "${join(ws, k)}"))`).join('')
      + read.map((p) => `(allow file-read* (subpath "${p}"))`).join('')
      + [...above].map((p) => `(allow file-read-metadata (literal "${p}"))`).join('');
  }

  async exec(id: string, command: string | string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const dir = this.resolve(id, opts.cwd || '.');
    const uid = this.uid(id);
    if (ISOLATED && uid === undefined) throw new SandboxUnavailable(`run ${id} has no user of its own`);
    const profile = SANDBOXED ? this.profile(id) : undefined;
    if (SANDBOXED && !profile) throw new SandboxUnavailable(`no sandbox profile can be written for run ${id}`);
    const argv = typeof command === 'string' ? ['/bin/sh', '-c', command] : command;
    if (opts.signal?.aborted) return { code: null, signal: null, timedOut: false, aborted: true };
    const child = spawn(...limited(profile ? SANDBOX_EXEC : argv[0], [...(profile ? ['-p', profile, argv[0]] : []), ...argv.slice(1)]), {
      cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...(uid === undefined ? {} : { uid, gid: uid }),
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: this.workspace(id), TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'en_US.UTF-8',
        PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', TERM: 'dumb', ...opts.env,
      },
    });
    const pid = child.pid;
    const mine = this.running.get(id) ?? new Set<number>();
    if (pid) { mine.add(pid); this.running.set(id, mine); }
    let timedOut = false, aborted = false;
    // The command is the leader of a group of its own (detached): ending the group ends whatever it started.
    const kill = () => { if (pid) try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } };
    const onAbort = () => { aborted = true; kill(); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs) : undefined;
    child.stdout!.on('data', (b: Buffer) => opts.onData?.(b, 'stdout'));
    child.stderr!.on('data', (b: Buffer) => opts.onData?.(b, 'stderr'));
    return new Promise((done) => {
      let over = false;
      const end = (code: number | null, signal: string | null) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (pid) { mine.delete(pid); if (!mine.size && this.running.get(id) === mine) this.running.delete(id); }
        done({ code, signal, timedOut, aborted });
      };
      child.once('error', () => end(127, null));
      child.once('close', end);
    });
  }

  async readFile(id: string, path: string, { maxBytes }: { maxBytes?: number } = {}): Promise<Buffer> {
    const abs = this.resolve(id, path);
    if (maxBytes === undefined) return readFileSync(abs);
    const fd = openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(maxBytes, statSync(abs).size));
      let got = 0;
      while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, got); if (!n) break; got += n; }
      return buf.subarray(0, got);
    } finally { closeSync(fd); }
  }

  async writeFile(id: string, path: string, data: string | Uint8Array, opts: { mode?: number } = {}) {
    const abs = this.writable(id, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
    if (opts.mode !== undefined) chmodSync(abs, opts.mode & 0o777);
    this.handOver(id, abs);
  }

  async mkdir(id: string, path: string) {
    const abs = this.writable(id, path);
    const first = mkdirSync(abs, { recursive: true });
    if (first) this.handOver(id, abs, dirname(first));
  }

  async stat(id: string, path: string): Promise<SandboxStat | null> {
    const abs = this.resolve(id, path);
    if (!existsSync(abs)) return null;
    const st = statSync(abs);
    return { file: st.isFile(), dir: st.isDirectory(), bytes: st.isFile() ? st.size : 0, mode: st.mode };
  }

  async list(id: string, { skip = new Set(), max = Infinity }: { skip?: ReadonlySet<string>; max?: number } = {}): Promise<FileEntry[]> {
    const root = this.workspace(id);
    const out: FileEntry[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
        if (skip.has(e.name) || e.isSymbolicLink() || out.length >= max) continue;
        const abs = join(dir, e.name);
        const path = relative(root, abs).split(sep).join('/');
        if (e.isDirectory()) { out.push({ path, dir: true, bytes: 0 }); walk(abs); }
        else if (e.isFile()) out.push({ path, dir: false, bytes: statSync(abs).size });
      }
    };
    walk(root);
    return out;
  }

  async copy(id: string, from: string, to: string) {
    const target = this.writable(id, to);
    cpSync(this.resolve(id, from), target, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true });
    const uid = this.uid(id);
    if (uid !== undefined) chownTree(target, uid);
  }

  async delete(id: string, path: string) {
    rmSync(this.writable(id, path, { followLast: false }), { recursive: true, force: true });
  }

  async destroy(id: string) {
    for (const pid of this.running.get(id) ?? []) try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    this.running.delete(id);
    this.kept.delete(id);
    rmSync(this.workspace(id), { recursive: true, force: true });
  }
}
