/**
 * The sandbox as a Docker container per run (see ./sandbox), for a machine whose own processes
 * cannot be kept apart: Windows, or macOS and Linux without the runner's container, with Docker
 * Desktop or Docker Engine beside the server. FDEGYM_SANDBOX=docker turns it on.
 *
 * The workspace stays on this machine's disk, where the harness builds, serves and grades it, and
 * is bound into the run's container at /workspace; what the customer handed over is bound in again
 * on top, read-only, so a command cannot change or remove it. Commands run in the container
 * (`docker exec`), as an unprivileged user, with no capabilities, under the run's own memory, CPU
 * and process limits. The server's own reads and writes go to the disk directly, as they do for the
 * local sandbox (./sandbox-local), with the same refusals.
 *
 * The container has no network at all: not the internet, not this machine, not other runs. What a
 * command may reach, the run's own stakeholders, LLM gateway and customer services, is passed in
 * through `docker exec`'s own input and output: a small relay in the container listens on the
 * ports the workspace's tools call (127.0.0.1, as they would on the customer's machine) and hands
 * each connection to the server, which opens it to the same port on this machine. Only that run's
 * ports are relayed.
 *
 * Configuration (environment variables):
 *   FDEGYM_DOCKER         the docker command (default: docker)
 *   FDEGYM_DOCKER_IMAGE   the image a run's container starts from (default: python:3.9-slim-bookworm,
 *                         Python 3.9 with the standard library, as the customer's machine); it needs
 *                         /bin/sh, setsid and python3 (which also ends a command's process group:
 *                         the image's shell may be dash, whose kill cannot)
 *   FDEGYM_DOCKER_MEMORY  memory per run (default: 2g); FDEGYM_DOCKER_CPUS CPUs per run (default: 2);
 *   FDEGYM_EXEC_NPROC     processes per run (default: 512)
 */
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { posix, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ExecOptions, ExecResult } from './sandbox';
import { SandboxUnavailable } from './sandbox';
import { LocalProvider } from './sandbox-local';

const run = promisify(execFile);
const DOCKER = process.env.FDEGYM_DOCKER || 'docker';
const IMAGE = process.env.FDEGYM_DOCKER_IMAGE || 'python:3.9-slim-bookworm';
const WORKSPACE = '/workspace';

/** Whether a docker daemon answers here (looked at once, at start-up). */
export const dockerReady = () => spawnSync(DOCKER, ['version', '--format', '{{.Server.Version}}'], { windowsHide: true, timeout: 20_000 }).status === 0;

/**
 * The relay inside a run's container: listens on the run's ports and passes each connection to the
 * server over stdin and stdout, as frames of [kind u8][connection u32][length u32][bytes]:
 * 1 opened (the bytes are the port, u16), 2 data, 3 closed.
 */
const RELAY = `
import socket, struct, sys, threading
out, inp = sys.stdout.buffer, sys.stdin.buffer
lock, conns, ids = threading.Lock(), {}, iter(range(1, 1 << 32))
def send(kind, cid, data=b""):
    with lock:
        out.write(struct.pack(">BII", kind, cid, len(data)) + data)
        out.flush()
def pump(cid, s):
    try:
        while True:
            b = s.recv(65536)
            if not b:
                break
            send(2, cid, b)
    except OSError:
        pass
    if conns.pop(cid, None) is not None:
        send(3, cid)
def listen(port):
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(64)
    while True:
        s, _ = srv.accept()
        cid = next(ids)
        conns[cid] = s
        send(1, cid, struct.pack(">H", port))
        threading.Thread(target=pump, args=(cid, s), daemon=True).start()
for p in sys.argv[1:]:
    threading.Thread(target=listen, args=(int(p),), daemon=True).start()
def read(n):
    b = b""
    while len(b) < n:
        c = inp.read(n - len(b))
        if not c:
            sys.exit(0)
        b += c
    return b
while True:
    kind, cid, n = struct.unpack(">BII", read(9))
    data = read(n) if n else b""
    s = conns.get(cid)
    if s is None:
        continue
    if kind == 2:
        try:
            s.sendall(data)
        except OSError:
            pass
    elif kind == 3:
        conns.pop(cid, None)
        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        s.close()
`;

/**
 * How a command is started in the container: in a session of its own (so that it and everything it
 * starts can be ended together), its group written down under its tag. A shell line comes on stdin
 * (`-`), so that a long one is not cut short by the command line's length on Windows.
 */
const WRAP = 'echo $$ > /tmp/.fdegym-$0.pid; if [ "$1" = - ]; then shift; cat > /tmp/.fdegym-$0.sh; set -- /bin/sh /tmp/.fdegym-$0.sh; fi; '
  + '"$@" < /dev/null; s=$?; rm -f /tmp/.fdegym-$0.pid /tmp/.fdegym-$0.sh; exit $s';

export class DockerProvider extends LocalProvider {
  override readonly isolation = 'container' as const;
  override readonly python = 'python3';
  /** Containers of this site's data folder are named for it, so that two sites on one machine do not meet. */
  private readonly prefix: string;
  /** Runs whose container is known to be up, in this process. */
  private readonly up = new Set<string>();
  private readonly relays = new Map<string, ChildProcess>();

  /** `ports(id)`: the ports on this machine the run's commands may reach (its stakeholders, LLM gateway and services). */
  constructor(opts: { runsDir: string; dataDir: string; readOnly?: string[] }, private readonly ports: (id: string) => number[] = () => []) {
    super(opts);
    this.prefix = `fdegym-${createHash('sha256').update(opts.dataDir).digest('hex').slice(0, 8)}`;
  }

  container(id: string) { return `${this.prefix}-${id}`; }
  override workspacePath(_id: string) { return WORKSPACE; }

  private async docker(args: string[], timeout = 120_000) {
    return run(DOCKER, args, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
  }

  /** Start the run's container: the workspace bound in, what was kept bound in again read-only, no network, the run's limits. */
  private async start(id: string, readOnly: string[]) {
    const ws = this.workspace(id);
    // The user the container's commands run as owns the workspace's files on Linux and macOS; on Windows the files belong to whoever asks.
    const user = process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : '1000:1000';
    await this.docker(['rm', '-f', this.container(id)]).catch(() => undefined);
    await this.docker([
      'run', '-d', '--name', this.container(id), '--label', `fdegym.run=${id}`, '--label', `fdegym.site=${this.prefix}`,
      '--init', '--network', 'none', '--user', user, '--workdir', WORKSPACE,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', process.env.FDEGYM_DOCKER_MEMORY || '2g', '--cpus', process.env.FDEGYM_DOCKER_CPUS || '2',
      '--pids-limit', String(Math.max(16, Number(process.env.FDEGYM_EXEC_NPROC) || 512)),
      '--mount', `type=bind,source=${ws},target=${WORKSPACE}`,
      ...readOnly.filter((k) => existsSync(`${ws}${sep}${k}`)).flatMap((k) => ['--mount', `type=bind,source=${ws}${sep}${k},target=${WORKSPACE}/${k},readonly`]),
      '-e', `HOME=${WORKSPACE}`, IMAGE, 'sleep', 'infinity',
    ], 600_000); // the first run may have to pull the image
    this.up.add(id);
  }

  /** The run's container, up (started again after the machine or Docker restarted; made, for a run that had none). */
  private async ensure(id: string) {
    if (!this.up.has(id)) {
      try {
        await this.docker(['start', this.container(id)]);
        this.up.add(id);
      } catch (e) {
        if (!/no such container/i.test(String((e as { stderr?: string }).stderr ?? e))) throw new SandboxUnavailable(`the container of run ${id} cannot be started: ${String((e as { stderr?: string }).stderr ?? e).trim()}`);
        await this.start(id, this.kept.get(id) ?? this.opts.readOnly ?? []);
      }
    }
    this.relay(id);
  }

  /** The run's ports, relayed from its container to this machine (once per container start, and again if the relay ended). */
  private relay(id: string) {
    const ports = this.ports(id);
    if (!ports.length || this.relays.has(id)) return;
    const child = spawn(DOCKER, ['exec', '-i', this.container(id), 'python3', '-u', '-c', RELAY, ...ports.map(String)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.relays.set(id, child);
    const socks = new Map<number, Socket>();
    const frame = (kind: number, cid: number, data: Buffer = Buffer.alloc(0)) => {
      const head = Buffer.alloc(9);
      head.writeUInt8(kind, 0); head.writeUInt32BE(cid, 1); head.writeUInt32BE(data.length, 5);
      if (child.stdin?.writable) child.stdin.write(Buffer.concat([head, data]));
    };
    let buf = Buffer.alloc(0);
    child.stdout!.on('data', (b: Buffer) => {
      buf = Buffer.concat([buf, b]);
      while (buf.length >= 9 && buf.length >= 9 + buf.readUInt32BE(5)) {
        const kind = buf[0], cid = buf.readUInt32BE(1), data = buf.subarray(9, 9 + buf.readUInt32BE(5));
        buf = buf.subarray(9 + data.length);
        if (kind === 1) {
          const s = connect({ host: '127.0.0.1', port: data.readUInt16BE(0) });
          socks.set(cid, s);
          s.on('data', (d: Buffer) => frame(2, cid, d));
          s.on('error', () => undefined);
          s.on('close', () => { if (socks.delete(cid)) frame(3, cid); });
        } else if (kind === 2) socks.get(cid)?.write(data);
        else if (kind === 3) { const s = socks.get(cid); socks.delete(cid); s?.end(); }
      }
    });
    child.stdin!.on('error', () => undefined);
    child.on('error', () => undefined);
    child.on('exit', () => {
      for (const s of socks.values()) s.destroy();
      if (this.relays.get(id) === child) this.relays.delete(id);
    });
  }

  override async create(id: string, { readOnly }: { readOnly: string[] }) {
    this.kept.set(id, readOnly);
    try { await this.start(id, readOnly); } catch (e) {
      throw new SandboxUnavailable(`the container of run ${id} cannot be started: ${String((e as { stderr?: string }).stderr ?? e).trim()}`);
    }
  }

  override async exec(id: string, command: string | string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const cwd = relative(this.workspace(id), this.resolve(id, opts.cwd || '.')).split(sep).join('/');
    if (opts.signal?.aborted) return { code: null, signal: null, timedOut: false, aborted: true };
    await this.ensure(id);
    const tag = randomBytes(8).toString('hex');
    const env = { HOME: WORKSPACE, TMPDIR: '/tmp', LANG: 'C.UTF-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', TERM: 'dumb', ...opts.env };
    const line = typeof command === 'string';
    const child = spawn(DOCKER, [
      'exec', ...(line ? ['-i'] : []), '-w', posix.join(WORKSPACE, cwd), ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      this.container(id), 'setsid', '-w', '/bin/sh', '-c', WRAP, tag, ...(line ? ['-'] : command),
    ], { windowsHide: true, stdio: [line ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (line) { child.stdin!.on('error', () => undefined); child.stdin!.end(command); }
    let timedOut = false, aborted = false, killed = false;
    // Ending the docker client does not end the command: it is ended in the container, with everything it started
    // (waiting a moment for it to have begun: starting one through docker exec takes a while, on Windows a second).
    const kill = () => {
      if (killed) return;
      killed = true;
      this.docker(['exec', this.container(id), '/bin/sh', '-c', `f=/tmp/.fdegym-${tag}.pid; i=0; while [ ! -s $f ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; [ -s $f ] && python3 -c 'import os, sys; os.killpg(int(sys.argv[1]), 9)' $(cat $f) 2>/dev/null; rm -f $f /tmp/.fdegym-${tag}.sh`], 30_000)
        .catch(() => undefined).finally(() => child.kill());
    };
    const onAbort = () => { aborted = true; kill(); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs) : undefined;
    child.stdout!.on('data', (b: Buffer) => opts.onData?.(b, 'stdout'));
    let said = '';
    child.stderr!.on('data', (b: Buffer) => { said = (said + b.toString()).slice(-400); opts.onData?.(b, 'stderr'); });
    return new Promise((done) => {
      let over = false;
      const end = (code: number | null, signal: string | null) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        // Docker (or the machine) restarted under it: the next command starts the container again.
        if (code !== 0 && /is not running|No such container/i.test(said)) { this.up.delete(id); this.relays.get(id)?.kill(); }
        // A command that was ended reads as the local sandbox's do: killed, no exit code.
        done(killed ? { code: null, signal: 'SIGKILL', timedOut, aborted } : { code, signal, timedOut, aborted });
      };
      child.once('error', () => end(127, null));
      child.once('close', end);
    });
  }

  override async destroy(id: string) {
    this.relays.get(id)?.kill();
    this.relays.delete(id);
    this.up.delete(id);
    await this.docker(['rm', '-f', this.container(id)]).catch(() => undefined);
    await super.destroy(id);
  }
}
