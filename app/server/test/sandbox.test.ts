/**
 * The sandbox on this machine's own disk (../sandbox-local): what the harness and the coding agent
 * do in a run's workspace, and what they cannot do outside it. Works on folders it makes itself;
 * needs no database, case or model.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { LocalProvider } from '../sandbox-local';

const data = realpathSync(mkdtempSync(join(tmpdir(), 'fdegym-sandbox-test-')));
let box: LocalProvider;
before(async () => {
  const { LocalProvider } = await import('../sandbox-local');
  box = new LocalProvider({ runsDir: join(data, 'runs'), dataDir: data, readOnly: ['TASK.md', 'docs'] });
});
after(() => rmSync(data, { recursive: true, force: true }));

let runs = 0;
async function newRun(files: Record<string, string> = {}) {
  const id = `run-${++runs}`;
  const ws = join(data, 'runs', id, 'workspace');
  mkdirSync(ws, { recursive: true });
  for (const [path, content] of Object.entries({ 'TASK.md': 'brief\n', 'docs/rules.md': 'rule\n', ...files })) {
    mkdirSync(join(ws, path, '..'), { recursive: true });
    writeFileSync(join(ws, path), content);
  }
  await box.create(id, { readOnly: ['TASK.md', 'docs'] });
  return { id, ws };
}
async function run(id: string, command: string | string[], opts: Parameters<LocalProvider['exec']>[2] = {}) {
  let out = '', err = '';
  const r = await box.exec(id, command, { ...opts, onData: (b, s) => { if (s === 'stdout') out += b; else err += b; } });
  return { ...r, out, err };
}

test('a command runs in the workspace and its output comes as it is printed, stdout and stderr apart', async () => {
  const { id, ws } = await newRun();
  const r = await run(id, 'pwd; echo oops >&2; exit 3');
  assert.deepEqual({ code: r.code, timedOut: r.timedOut, aborted: r.aborted }, { code: 3, timedOut: false, aborted: false });
  assert.equal(realpathSync(r.out.trim()), realpathSync(ws));
  assert.equal(r.err, 'oops\n');
  // A folder of the workspace to start in, and a program with its arguments instead of a shell line.
  mkdirSync(join(ws, 'system'));
  assert.equal((await run(id, 'basename "$PWD"', { cwd: 'system' })).out, 'system\n');
  assert.equal((await run(id, ['/bin/echo', 'a b', '$HOME'])).out, 'a b $HOME\n');
});

test('a command gets a small environment of its own, not the server\'s', async () => {
  const { id, ws } = await newRun();
  process.env.FDEGYM_TEST_SECRET = 'do-not-pass';
  try {
    const r = await run(id, 'env', { env: { EXTRA: 'given' } });
    assert.doesNotMatch(r.out, /do-not-pass/);
    assert.match(r.out, /^EXTRA=given$/m);
    assert.match(r.out, new RegExp(`^HOME=${ws}$`, 'm'));
  } finally { delete process.env.FDEGYM_TEST_SECRET; }
});

test('a command that runs too long, or is stopped, ends with everything it started', async () => {
  const { id, ws } = await newRun();
  const t0 = Date.now();
  const late = await run(id, '(sleep 2; touch late.txt) & sleep 30', { timeoutMs: 300 });
  assert.equal(late.timedOut, true);
  assert.equal(late.signal, 'SIGKILL');
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 300);
  const stopped = await run(id, '(sleep 2; touch stopped.txt) & sleep 30', { signal: stop.signal });
  assert.equal(stopped.aborted, true);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  await new Promise((ok) => setTimeout(ok, 2500));
  assert.equal(existsSync(join(ws, 'late.txt')), false);
  assert.equal(existsSync(join(ws, 'stopped.txt')), false);
});

test('files: read (all or the start), written with their folders, looked at, listed, copied and removed', async () => {
  const { id, ws } = await newRun({ 'system/app.py': 'print(1)\n', 'system/__pycache__/app.pyc': 'x' });
  assert.equal((await box.readFile(id, 'system/app.py')).toString(), 'print(1)\n');
  assert.equal((await box.readFile(id, 'system/app.py', { maxBytes: 5 })).toString(), 'print');
  await box.writeFile(id, 'deliverables/deep/note.md', 'hello');
  assert.equal(readFileSync(join(ws, 'deliverables/deep/note.md'), 'utf8'), 'hello');
  await box.writeFile(id, 'run.sh', '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(statSync(join(ws, 'run.sh')).mode & 0o777, 0o755);
  await box.mkdir(id, 'scratch/a/b');
  assert.deepEqual(await box.stat(id, 'scratch/a'), { file: false, dir: true, bytes: 0, mode: statSync(join(ws, 'scratch/a')).mode });
  assert.equal((await box.stat(id, 'system/app.py'))?.bytes, 9);
  assert.equal(await box.stat(id, 'nothing.txt'), null);
  await box.copy(id, 'system', 'system copy');
  await assert.rejects(box.copy(id, 'system/app.py', 'system copy/app.py'));
  assert.deepEqual((await box.list(id, { skip: new Set(['__pycache__']) })).map((e) => `${e.dir ? 'd' : 'f'} ${e.path}`), [
    'd deliverables', 'd deliverables/deep', 'f deliverables/deep/note.md', 'd docs', 'f docs/rules.md', 'd scratch', 'd scratch/a', 'd scratch/a/b',
    'd system', 'f system/app.py', 'd system copy', 'f system copy/app.py', 'f run.sh', 'f TASK.md',
  ]);
  assert.equal((await box.list(id, { max: 3 })).length, 3);
  await box.delete(id, 'system copy');
  assert.equal(existsSync(join(ws, 'system copy')), false);
});

test('nothing outside the workspace is reached, through a link either, nor made through a link that points nowhere yet', async () => {
  const { id, ws } = await newRun();
  const outside = join(data, 'outside.txt');
  writeFileSync(outside, 'secret');
  symlinkSync(outside, join(ws, 'out-link'));
  symlinkSync(data, join(ws, 'out-dir'));
  symlinkSync(join(data, 'made-by-link.txt'), join(ws, 'dangling'));
  for (const path of ['../outside.txt', '/etc/hostname', 'out-link', 'out-dir/outside.txt']) {
    await assert.rejects(box.readFile(id, path), /不在工作区内/, path);
    await assert.rejects(box.writeFile(id, path, 'x'), /不在工作区内/, path);
  }
  await assert.rejects(box.writeFile(id, 'dangling', 'x'), /不在工作区内/);
  await assert.rejects(box.exec(id, 'true', { cwd: 'out-dir' }), /不在工作区内/);
  await assert.rejects(box.copy(id, 'TASK.md', 'out-dir/copied.md'), /不在工作区内/);
  assert.equal(readFileSync(outside, 'utf8'), 'secret');
  assert.equal(existsSync(join(data, 'made-by-link.txt')), false);
  assert.equal(existsSync(join(data, 'copied.md')), false);
});

test('what was kept read-only is not changed by the server, under its own name or through a link', async () => {
  const { id, ws } = await newRun();
  symlinkSync('docs', join(ws, 'papers'));
  symlinkSync('TASK.md', join(ws, 'brief.md'));
  for (const path of ['TASK.md', 'docs/rules.md', 'docs/new.md', 'papers/rules.md', 'brief.md']) await assert.rejects(box.writeFile(id, path, 'changed'), /不能修改/, path);
  for (const path of ['TASK.md', 'docs', 'docs/rules.md', 'papers/rules.md']) await assert.rejects(box.delete(id, path), /不能修改/, path);
  await assert.rejects(box.mkdir(id, 'docs/more'), /不能修改/);
  await assert.rejects(box.copy(id, 'TASK.md', 'papers/task.md'), /不能修改/);
  assert.equal(readFileSync(join(ws, 'TASK.md'), 'utf8'), 'brief\n');
  assert.equal(readFileSync(join(ws, 'docs/rules.md'), 'utf8'), 'rule\n');
  // Still to be read, and a link of the learner's own to them can go.
  assert.equal((await box.readFile(id, 'papers/rules.md')).toString(), 'rule\n');
  await box.delete(id, 'papers');
  await box.delete(id, 'brief.md');
  assert.equal(existsSync(join(ws, 'papers')), false);
  assert.equal(existsSync(join(ws, 'docs/rules.md')), true);
  assert.equal(existsSync(join(ws, 'TASK.md')), true);
});

test('ending a sandbox ends what runs in it and removes its workspace', async () => {
  const { id, ws } = await newRun();
  const t0 = Date.now();
  const r = run(id, 'sleep 30');
  await new Promise((ok) => setTimeout(ok, 300));
  await box.destroy(id);
  assert.equal((await r).signal, 'SIGKILL');
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(existsSync(ws), false);
  await assert.rejects(box.stat(id, 'TASK.md'), /工作区已不存在/);
});
