/**
 * The sandbox as a container per run (../sandbox-docker), against the Docker on this machine: Docker
 * Desktop on Windows or macOS, or Docker Engine. Skipped where no Docker answers, unless
 * FDEGYM_TEST_REQUIRE_DOCKER=1 says it must be there. Pulls python:3.9-slim-bookworm the first time.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { DockerProvider } from '../sandbox-docker';

const data = realpathSync(mkdtempSync(join(tmpdir(), 'fdegym-docker-test-')));
let box: DockerProvider;
// Looked at before the tests are declared, so that they can be skipped.
const ready = spawnSync(process.env.FDEGYM_DOCKER || 'docker', ['version'], { windowsHide: true, timeout: 20_000 }).status === 0;
let host: Server;
/** What each run's commands may reach on this machine. */
const ports = new Map<string, number[]>();
const created: string[] = [];

before(async () => {
  const docker = await import('../sandbox-docker');
  if (!ready && process.env.FDEGYM_TEST_REQUIRE_DOCKER === '1') throw new Error('FDEGYM_TEST_REQUIRE_DOCKER=1, but no Docker answers here');
  box = new docker.DockerProvider({ runsDir: join(data, 'runs'), dataDir: data, readOnly: ['TASK.md', 'docs'] }, (id) => ports.get(id) ?? []);
  // A stand-in for a run's stakeholders, listening on this machine only, as the harness's servers do.
  host = createServer((req, res) => res.end(`the customer heard ${req.url}`));
  await new Promise<void>((ok) => host.listen(0, '127.0.0.1', ok));
});
after(async () => {
  for (const id of created) await box.destroy(id).catch(() => undefined);
  host?.close();
  rmSync(data, { recursive: true, force: true });
});
const skip = () => (!ready ? 'no Docker here' : false);

let runs = 0;
async function newRun(opts: { reach?: boolean } = {}) {
  const id = `run-${++runs}`;
  const ws = join(data, 'runs', id, 'workspace');
  mkdirSync(join(ws, 'docs'), { recursive: true });
  writeFileSync(join(ws, 'TASK.md'), 'brief\n');
  writeFileSync(join(ws, 'docs', 'rules.md'), 'rule\n');
  if (opts.reach) ports.set(id, [(host.address() as AddressInfo).port]);
  created.push(id);
  await box.create(id, { readOnly: ['TASK.md', 'docs'] });
  return { id, ws };
}
async function run(id: string, command: string | string[], opts: Parameters<DockerProvider['exec']>[2] = {}) {
  let out = '', err = '';
  const r = await box.exec(id, command, { ...opts, onData: (b, s) => { if (s === 'stdout') out += b; else err += b; } });
  return { ...r, out, err };
}

test('a command runs in the run\'s container, in the workspace, as a user without privileges', { skip: skip() }, async () => {
  const { id, ws } = await newRun();
  assert.equal(box.workspacePath(id), '/workspace');
  const r = await run(id, 'pwd; id -u; echo oops >&2; exit 3');
  assert.equal(r.code, 3);
  assert.equal(r.out.split('\n')[0], '/workspace');
  assert.notEqual(r.out.split('\n')[1], '0');
  assert.equal(r.err, 'oops\n');
  mkdirSync(join(ws, 'system'));
  assert.equal((await run(id, 'pwd', { cwd: 'system' })).out, '/workspace/system\n');
  assert.equal((await run(id, ['python3', '-c', 'import sys; print(sys.version_info[:2], sys.argv[1])', 'a b'])).out, '(3, 9) a b\n');
  // What it makes is in the workspace on this machine's disk, where the harness sees it.
  await run(id, 'mkdir -p deliverables && echo done > deliverables/note.md');
  assert.equal(readFileSync(join(ws, 'deliverables', 'note.md'), 'utf8'), 'done\n');
});

test('nothing of the server\'s environment goes in, and a long command line is not cut short', { skip: skip() }, async () => {
  const { id } = await newRun();
  process.env.FDEGYM_TEST_SECRET = 'do-not-pass';
  try {
    const r = await run(id, 'env', { env: { EXTRA: 'given' } });
    assert.doesNotMatch(r.out, /do-not-pass/);
    assert.match(r.out, /^EXTRA=given$/m);
    assert.match(r.out, /^HOME=\/workspace$/m);
  } finally { delete process.env.FDEGYM_TEST_SECRET; }
  const long = 'x'.repeat(100_000);
  assert.equal((await run(id, `printf '%s' '${long}' | wc -c`)).out.trim(), '100000');
});

test('what the customer handed over cannot be changed or removed by a command', { skip: skip() }, async () => {
  const { id, ws } = await newRun();
  for (const command of ['echo changed > TASK.md', 'rm -f TASK.md', 'echo new > docs/new.md', 'rm -rf docs']) {
    assert.notEqual((await run(id, command)).code, 0, command);
  }
  assert.equal(readFileSync(join(ws, 'TASK.md'), 'utf8'), 'brief\n');
  assert.equal(readFileSync(join(ws, 'docs', 'rules.md'), 'utf8'), 'rule\n');
  assert.equal(existsSync(join(ws, 'docs', 'new.md')), false);
  assert.equal((await run(id, 'cat TASK.md docs/rules.md')).out, 'brief\nrule\n');
});

test('no network: only the run\'s own ports on this machine, relayed in', { skip: skip() }, async () => {
  const { id } = await newRun({ reach: true });
  const port = (host.address() as AddressInfo).port;
  const get = (url: string) => run(id, ['python3', '-c', 'import sys, urllib.request as u; print(u.urlopen(sys.argv[1], timeout=5).read().decode())', url]);
  const asked = await get(`http://127.0.0.1:${port}/who`);
  assert.equal(asked.code, 0, asked.err);
  assert.equal(asked.out, 'the customer heard /who\n');
  // Again, and several at once.
  const many = await run(id, ['python3', '-c', `
import urllib.request as u, concurrent.futures as f
with f.ThreadPoolExecutor(8) as ex:
    print(sorted(set(ex.map(lambda i: u.urlopen("http://127.0.0.1:${port}/n", timeout=5).read().decode(), range(20)))))`]);
  assert.equal(many.out, "['the customer heard /n']\n", many.err);
  // Not the internet, not this machine otherwise.
  const out = await run(id, ['python3', '-c', 'import socket; socket.create_connection(("1.1.1.1", 443), timeout=3)']);
  assert.notEqual(out.code, 0);
  const other = await get('http://host.docker.internal:80/');
  assert.notEqual(other.code, 0);
  // A run that was given no ports reaches nothing.
  const { id: closed } = await newRun();
  const shut = await run(closed, ['python3', '-c', 'import sys, urllib.request as u; u.urlopen(sys.argv[1], timeout=3)', `http://127.0.0.1:${port}/`]);
  assert.notEqual(shut.code, 0);
});

test('a command that runs too long, or is stopped, ends with everything it started', { skip: skip() }, async () => {
  const { id, ws } = await newRun();
  const t0 = Date.now();
  const late = await run(id, '(sleep 3; touch late.txt) & sleep 60', { timeoutMs: 1000 });
  assert.equal(late.timedOut, true);
  assert.deepEqual([late.code, late.signal], [null, 'SIGKILL']);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 1000);
  const stopped = await run(id, '(sleep 3; touch stopped.txt) & sleep 60', { signal: stop.signal });
  assert.equal(stopped.aborted, true);
  assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms`);
  await new Promise((ok) => setTimeout(ok, 4000));
  assert.equal(existsSync(join(ws, 'late.txt')), false);
  assert.equal(existsSync(join(ws, 'stopped.txt')), false);
  const sleeping = await run(id, ['python3', '-c', 'import os; print(sum(open("/proc/%s/cmdline" % p).read().split(chr(0))[:2] in (["sleep", "3"], ["sleep", "60"]) for p in os.listdir("/proc") if p.isdigit()))']);
  assert.equal(sleeping.out, '0\n', sleeping.err);
});

test('a container that went away is made again on the next command; ending the run removes it and its workspace', { skip: skip() }, async () => {
  const { id, ws } = await newRun();
  const { execFileSync } = await import('node:child_process');
  execFileSync('docker', ['rm', '-f', box.container(id)], { windowsHide: true, stdio: 'ignore' });
  await run(id, 'true'); // finds it gone
  assert.equal((await run(id, 'cat TASK.md')).out, 'brief\n');
  assert.notEqual((await run(id, 'echo changed > TASK.md')).code, 0);
  await box.destroy(id);
  assert.equal(existsSync(ws), false);
  assert.throws(() => execFileSync('docker', ['inspect', box.container(id)], { windowsHide: true, stdio: 'ignore' }));
});
