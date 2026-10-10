/**
 * What has changed in a workspace since it was built (../harness): the list, one file's diff, and
 * putting a file back. Works on folders it makes itself; needs no database, case or model.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const data = realpathSync(mkdtempSync(join(tmpdir(), 'fdegym-changes-test-')));
process.env.FDEGYM_DATA = data;
let harness: typeof import('../harness');
before(async () => { harness = await import('../harness'); });
after(() => rmSync(data, { recursive: true, force: true }));

let runs = 0;
/** A run as createRun leaves it: the workspace, and the copy of it as built. */
function newRun(files: Record<string, string | Buffer>) {
  const name = `run-${++runs}`;
  const ws = join(data, 'runs', name, 'workspace');
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(ws, path, '..'), { recursive: true }); writeFileSync(join(ws, path), content); }
  cpSync(ws, join(data, 'runs', name, 'baseline'), { recursive: true });
  return { name, ws };
}

test('nothing has changed in a workspace as built', async () => {
  const { name } = newRun({ 'TASK.md': 'brief\n', 'system/app.py': 'print(1)\n' });
  assert.deepEqual(await harness.changes(name), []);
});

test('a run that kept no copy of its workspace as built says so', async () => {
  const { name } = newRun({ 'TASK.md': 'brief\n' });
  rmSync(join(data, 'runs', name, 'baseline'), { recursive: true });
  assert.equal(await harness.changes(name), undefined);
});

test('what was changed, added and removed, with how many lines', async () => {
  const { name, ws } = newRun({ 'system/app.py': 'a\nb\nc\n', 'system/old.py': 'x\ny\n', 'docs/keep.md': 'same\n', 'data/blob.bin': Buffer.from([1, 0, 2, 0]) });
  writeFileSync(join(ws, 'system/app.py'), 'a\nB\nc\nd\n');
  rmSync(join(ws, 'system/old.py'));
  mkdirSync(join(ws, 'deliverables'), { recursive: true });
  writeFileSync(join(ws, 'deliverables/note.md'), 'one\ntwo\nthree');
  writeFileSync(join(ws, 'data/blob.bin'), Buffer.from([1, 0, 3, 0]));
  // Not the learner's work, and not shown in the file tree either.
  mkdirSync(join(ws, 'system/__pycache__'));
  writeFileSync(join(ws, 'system/__pycache__/app.pyc'), 'junk');
  symlinkSync('/etc/hosts', join(ws, 'link'));
  assert.deepEqual(await harness.changes(name), [
    { path: 'data/blob.bin', status: 'modified', added: null, removed: null },
    { path: 'deliverables/note.md', status: 'added', added: 3, removed: 0 },
    { path: 'system/app.py', status: 'modified', added: 2, removed: 1 },
    { path: 'system/old.py', status: 'deleted', added: 0, removed: 2 },
  ]);
});

test('one file\'s change as a diff', async () => {
  const { name, ws } = newRun({ 'system/app.py': 'a\nb\nc\n', 'data/blob.bin': Buffer.from([1, 0, 2]) });
  writeFileSync(join(ws, 'system/app.py'), 'a\nB\nc\n');
  writeFileSync(join(ws, 'new.txt'), 'hello\n');
  const d = await harness.diffOf(name, 'system/app.py');
  assert.equal(d.binary, false);
  assert.match(d.diff, /^--- a\/system\/app\.py\n\+\+\+ b\/system\/app\.py\n@@ -1,3 \+1,3 @@\n a\n-b\n\+B\n c\n$/);
  assert.match((await harness.diffOf(name, 'new.txt')).diff, /^--- \/dev\/null\n\+\+\+ b\/new\.txt\n@@ -0,0 \+1 @@\n\+hello\n$/);
  assert.deepEqual(await harness.diffOf(name, 'data/blob.bin'), { diff: '', truncated: false, binary: true });
  await assert.rejects(harness.diffOf(name, 'no/such/file'), /文件不存在/);
  await assert.rejects(harness.diffOf(name, '../baseline/system/app.py'), /不在工作区内/);
});

test('putting a file back: a changed one as it was, a removed one restored, a new one gone', async () => {
  const { name, ws } = newRun({ 'TASK.md': 'brief\n', 'system/app.py': 'a\n', 'system/deep/old.py': 'x\n' });
  writeFileSync(join(ws, 'system/app.py'), 'changed\n');
  rmSync(join(ws, 'system/deep'), { recursive: true });
  writeFileSync(join(ws, 'system/new.py'), 'new\n');
  harness.revertFile(name, 'system/app.py');
  harness.revertFile(name, 'system/deep/old.py');
  harness.revertFile(name, 'system/new.py');
  assert.equal(readFileSync(join(ws, 'system/app.py'), 'utf8'), 'a\n');
  assert.equal(readFileSync(join(ws, 'system/deep/old.py'), 'utf8'), 'x\n');
  assert.equal(existsSync(join(ws, 'system/new.py')), false);
  assert.deepEqual(await harness.changes(name), []);
  // The brief is not the learner's to change, so not theirs to put back either; and nothing outside the workspace is touched.
  assert.throws(() => harness.revertFile(name, 'TASK.md'), /不能修改/);
  assert.throws(() => harness.revertFile(name, '../baseline/system/app.py'), /不能修改|不在工作区内/);
});

test('what the customer handed over is not changed through the file API: the brief, their documents and data, the harness\'s tools', () => {
  const { name, ws } = newRun({ 'TASK.md': 'brief\n', 'docs/rules.md': 'rule\n', 'bin/ask': '#!/bin/sh\n', 'data/notes.txt': 'n\n', 'system/app.py': 'a\n' });
  for (const path of ['TASK.md', 'docs/rules.md', 'docs/new.md', 'bin/ask', 'data/notes.txt', 'data/new.csv', 'docs', 'bin', 'data']) {
    assert.throws(() => harness.writeFile(name, path, 'changed'), /不能修改|是一个目录/, path);
    assert.throws(() => harness.deletePath(name, path), /不能修改/, path);
  }
  assert.equal(readFileSync(join(ws, 'docs/rules.md'), 'utf8'), 'rule\n');
  assert.equal(readFileSync(join(ws, 'data/notes.txt'), 'utf8'), 'n\n');
  // What is the learner's to work in stays open, a folder of their own making included.
  harness.writeFile(name, 'system/app.py', 'b\n');
  harness.writeFile(name, 'deliverables/note.md', 'done\n');
  harness.writeFile(name, 'scratch/try.py', 'x\n');
  assert.equal(readFileSync(join(ws, 'scratch/try.py'), 'utf8'), 'x\n');
});

test('a SQLite file is read as its tables and a page of rows', async () => {
  const { name, ws } = newRun({ 'TASK.md': 'brief\n', 'data/readme.txt': 'not a database\n' });
  const { execFileSync } = await import('node:child_process');
  execFileSync('python3', ['-c', `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute('create table visits (id integer primary key, dept text, note text, photo blob, score real)')
con.executemany('insert into visits (dept, note, photo, score) values (?, ?, ?, ?)', [('D%d' % (i % 3), None if i == 0 else 'n' * (500 if i == 1 else 5), b'xyz' if i == 0 else None, i / 2) for i in range(450)])
con.execute('create table "odd name" (x)')
con.execute('create view busy as select dept, count(*) n from visits group by dept')
con.commit()`, join(ws, 'data/clinic.db')]);
  const first = await harness.sqliteView(name, 'data/clinic.db');
  assert.deepEqual(first.tables, [{ name: 'odd name', kind: 'table', rows: 0 }, { name: 'visits', kind: 'table', rows: 450 }, { name: 'busy', kind: 'view', rows: 3 }]);
  assert.equal(first.table, 'odd name');
  const page = await harness.sqliteView(name, 'data/clinic.db', 'visits', 400);
  assert.deepEqual(page.columns, ['id', 'dept', 'note', 'photo', 'score']);
  assert.equal(page.total, 450);
  assert.equal(page.rows.length, 50);
  assert.deepEqual(page.rows[0], [401, 'D1', 'nnnnn', null, 200]);
  // A row's oddities: nothing there, bytes, and a text too long to show whole.
  const top = (await harness.sqliteView(name, 'data/clinic.db', 'visits')).rows;
  assert.equal(top.length, 200);
  assert.deepEqual(top[0], [1, 'D0', null, '<3 bytes>', 0]);
  assert.equal(String(top[1][2]).length, 401);
  assert.deepEqual((await harness.sqliteView(name, 'data/clinic.db', 'busy')).rows[0], ['D0', 150]);
  // A name that is not a table of the file falls back to the first; a file that is not a database says so.
  assert.equal((await harness.sqliteView(name, 'data/clinic.db', 'visits; drop table visits')).table, 'odd name');
  await assert.rejects(harness.sqliteView(name, 'data/readme.txt'), /不是一个能打开的 SQLite 数据库/);
  await assert.rejects(harness.sqliteView(name, '../../etc/passwd'), /不在工作区内/);
  // Looking does not change the file.
  assert.equal((await harness.sqliteView(name, 'data/clinic.db', 'visits')).total, 450);
});

test('a copy beside the original, named as a desktop names one', () => {
  const { name, ws } = newRun({ 'TASK.md': 'brief\n', 'docs/rules.md': 'r\n', 'system/app.py': 'a\n', 'system/.env': 'K=1\n', 'system/lib/util.py': 'u\n', 'deliverables/note': 'n\n' });
  assert.equal(harness.duplicate(name, 'system/app.py', 'zh'), 'system/app - 副本.py');
  assert.equal(harness.duplicate(name, 'system/app.py', 'zh'), 'system/app - 副本 2.py');
  assert.equal(harness.duplicate(name, 'system/app.py', 'en'), 'system/app copy.py');
  assert.equal(readFileSync(join(ws, 'system/app - 副本 2.py'), 'utf8'), 'a\n');
  // No extension to keep: a name without one, a dotfile, a folder (copied with what is in it).
  assert.equal(harness.duplicate(name, 'deliverables/note', 'en'), 'deliverables/note copy');
  assert.equal(harness.duplicate(name, 'system/.env', 'en'), 'system/.env copy');
  assert.equal(harness.duplicate(name, 'system/lib', 'zh'), 'system/lib - 副本');
  assert.equal(readFileSync(join(ws, 'system/lib - 副本/util.py'), 'utf8'), 'u\n');
  // What is kept cannot have a copy made beside it, and nothing is copied from outside.
  assert.throws(() => harness.duplicate(name, 'docs/rules.md', 'zh'), /只读/);
  assert.throws(() => harness.duplicate(name, 'TASK.md', 'zh'), /只读/);
  assert.throws(() => harness.duplicate(name, '../baseline/system/app.py', 'zh'), /不在工作区内|只读/);
  assert.throws(() => harness.duplicate(name, 'system/none.py', 'zh'), /文件不存在/);
});
