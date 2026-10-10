/**
 * What keeps open runs from filling the runners (../session): a learner may have only so many open
 * at once, and a run left alone long enough is ended. Needs the local PostgreSQL and works in a
 * database of its own there; without one the tests are skipped.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';

const ADMIN = process.env.FDEGYM_TEST_DATABASE_URL || 'postgres://fdegym:fdegym@127.0.0.1:5432/fdegym';
const NAME = `fdegym_test_runs_${process.pid}`;
const tmp = mkdtempSync(join(tmpdir(), 'fdegym-runs-test-'));
const DAY = 86_400_000;

let session: typeof import('../session');
let dbm: typeof import('../db');
let reachable = false;

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN, connectionTimeoutMillis: 2000 });
  try { await admin.connect(); } catch { return; }
  reachable = true;
  await admin.query(`CREATE DATABASE ${NAME}`);
  await admin.end();
  // Read when the modules load, so set first. No runner of any kind: these runs are on machines that are not there.
  Object.assign(process.env, {
    FDEGYM_DATABASE_URL: ADMIN.replace(/\/[^/]*$/, `/${NAME}`), FDEGYM_DATA: tmp,
    FDEGYM_MAX_OPEN_RUNS: '2', FDEGYM_RUN_IDLE_DAYS: '14', FDEGYM_LOCAL_RUNNER: '0',
  });
  dbm = await import('../db');
  await dbm.migrate();
  session = await import('../session');
});

after(async () => {
  if (!reachable) return;
  await dbm.closeDb();
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
  await admin.end();
  rmSync(tmp, { recursive: true, force: true });
});

const run = (id: string, learner: string, status: string, started: number, active?: number) =>
  dbm.db.run("INSERT INTO runs (id, case_id, learner_id, learner_name, started_at, status, runner, last_active) VALUES ($1, 'a_case', $2, 'Someone', $3, $4, 'a-runner-that-is-gone', $5)", [id, learner, started, status, active ?? null]);
const statusOf = async (id: string) => (await dbm.db.one<{ status: string }>('SELECT status FROM runs WHERE id = $1', [id]))?.status;

test('a learner with as many open runs as allowed is told to finish one first', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const now = Date.now();
  await run('open-1', 'busy-learner', 'running', now);
  await run('open-2', 'busy-learner', 'running', now);
  await run('done-1', 'busy-learner', 'graded', now);
  // The check comes before anything is asked of the case or of a runner.
  const record = { card: { id: 'a_case' }, bundleSha: '' } as never;
  await assert.rejects(session.startSession({ record, learnerId: 'busy-learner', name: 'Someone' }), /已经有 2 次练习还没交付/);
  // Someone else is not held back by it: they get as far as finding no runner to take the run.
  await assert.rejects(session.startSession({ record, learnerId: 'another-learner', name: 'Other' }), /没有可用的沙箱机/);
});

test('runs left alone for longer than a run may be are ended; the others are not', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const now = Date.now();
  await run('idle-never-opened', 'l1', 'running', now - 20 * DAY);
  await run('idle-opened-long-ago', 'l1', 'running', now - 40 * DAY, now - 15 * DAY);
  await run('old-but-used-lately', 'l2', 'running', now - 40 * DAY, now - 1 * DAY);
  await run('new', 'l2', 'running', now - 1 * DAY);
  await run('graded-long-ago', 'l3', 'graded', now - 60 * DAY);
  assert.equal(await session.endIdleRuns(), 2);
  assert.equal(await statusOf('idle-never-opened'), 'abandoned');
  assert.equal(await statusOf('idle-opened-long-ago'), 'abandoned');
  assert.equal(await statusOf('old-but-used-lately'), 'running');
  assert.equal(await statusOf('new'), 'running');
  assert.equal(await statusOf('graded-long-ago'), 'graded');
  assert.equal(await session.endIdleRuns(), 0);
});

test('opening a run counts as using it', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const now = Date.now();
  await run('visited', 'l4', 'running', now - 20 * DAY);
  await session.openSession('visited', ['l4']);
  for (let i = 0; i < 50; i++) {
    if ((await dbm.db.one<{ last_active: number | null }>("SELECT last_active FROM runs WHERE id = 'visited'"))?.last_active) break;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.equal(await session.endIdleRuns(), 0);
  assert.equal(await statusOf('visited'), 'running');
});

test('runs long over have their files cleared; recent ones, open ones and ones whose runner is only away are left', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const now = Date.now();
  const over = (id: string, status: string, runner: string, finished: number) =>
    dbm.db.run("INSERT INTO runs (id, case_id, learner_id, learner_name, started_at, finished_at, status, runner) VALUES ($1, 'a_case', 'l9', 'Someone', $2, $2, $3, $4)", [id, finished, status, runner]);
  await dbm.db.run("INSERT INTO runners (name, capacity, first_seen, last_seen) VALUES ('known-but-away', 5, $1, $1)", [now]);
  await over('old-on-forgotten-runner', 'graded', 'forgotten-runner', now - 40 * DAY);
  await over('old-abandoned-on-forgotten-runner', 'abandoned', 'forgotten-runner', now - 31 * DAY);
  await over('old-on-runner-that-is-away', 'graded', 'known-but-away', now - 40 * DAY);
  await over('recent', 'graded', 'forgotten-runner', now - 5 * DAY);
  await over('old-but-failed-grading', 'failed', 'forgotten-runner', now - 40 * DAY);
  const gone = async (id: string) => (await dbm.db.one<{ workspace_gone: boolean }>('SELECT workspace_gone FROM runs WHERE id = $1', [id]))?.workspace_gone;
  // These two, and whatever earlier tests left that is as old.
  assert.ok(await session.clearOldWorkspaces() >= 2);
  assert.equal(await gone('old-on-forgotten-runner'), true);
  assert.equal(await gone('old-abandoned-on-forgotten-runner'), true);
  assert.equal(await gone('old-on-runner-that-is-away'), false);
  assert.equal(await gone('recent'), false);
  assert.equal(await gone('old-but-failed-grading'), false);
  assert.equal(await session.clearOldWorkspaces(), 0);
  // The run still opens, and says where its files went.
  const view = await (await session.openSession('old-on-forgotten-runner', ['l9'])).view();
  assert.match(view.task, /文件已经清理/);
  assert.deepEqual(view.files, []);
});

test('a run looked back over: what was asked, told to the agent and run by hand, in the order it happened', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const t0 = Date.now() - 3_600_000;
  await dbm.db.run("INSERT INTO runs (id, case_id, learner_id, learner_name, started_at, finished_at, status, runner, uplift, uplift_net) VALUES ('looked-back', 'a_case', 'l7', 'Someone', $1, $2, 'graded', 'a-runner-that-is-gone', 0.9, 0.85)", [t0, t0 + 50 * 60_000]);
  const said = (kind: string, who: string | null, question: string | null, answer: string, min: number) =>
    dbm.db.run('INSERT INTO messages (run_id, kind, who, question, answer, ts) VALUES ($1, $2, $3, $4, $5, $6)', ['looked-back', kind, who, question, answer, t0 + min * 60_000]);
  const agentRow = (message: object, min: number) =>
    dbm.db.run('INSERT INTO agent_messages (run_id, message, ts) VALUES ($1, $2::jsonb, $3)', ['looked-back', JSON.stringify(message), t0 + min * 60_000]);
  await agentRow({ v: 2, item: { kind: 'user', text: 'Read the brief.' } }, 2);
  await agentRow({ v: 2, item: { kind: 'tool', id: 'a', name: 'read', args: { path: 'TASK.md' }, output: '…', failed: false } }, 2.1);
  await agentRow({ v: 2, item: { kind: 'assistant', text: 'It asks for an assistant.' } }, 2.2);
  await said('ask', 'ops', 'Who decides this rule?', 'Compliance does.', 10);
  await dbm.db.run('INSERT INTO commands (run_id, cwd, command, output, code, ts) VALUES ($1, $2, $3, $4, $5, $6)', ['looked-back', '', 'python3 system/check.py', 'boom', 1, t0 + 20 * 60_000]);
  await agentRow({ v: 2, item: { kind: 'user', text: 'Make it hand those three to a person.' } }, 30);
  await agentRow({ v: 2, item: { kind: 'tool', id: 'b', name: 'edit', args: { path: 'system/x.py' }, output: 'no', failed: true } }, 30.1);
  await agentRow({ v: 2, item: { kind: 'tool', id: 'c', name: 'edit', args: { path: 'system/x.py' }, output: 'ok', failed: false } }, 30.2);
  await agentRow({ v: 2, item: { kind: 'assistant', text: 'Done.' } }, 30.3);
  await said('inbox', 'it', 'note-1', 'The sandbox moves on Friday.', 40);

  const events = await (await session.openSession('looked-back', ['l7'])).timeline();
  assert.deepEqual(events.map((e) => e.kind), ['start', 'agent', 'ask', 'command', 'agent', 'inbox', 'end']);
  assert.deepEqual(events[1], { ts: t0 + 2 * 60_000, kind: 'agent', text: 'Read the brief.', steps: 1, failed: 0, said: 'It asks for an assistant.' });
  assert.deepEqual(events[2], { ts: t0 + 10 * 60_000, kind: 'ask', who: 'ops', question: 'Who decides this rule?', answer: 'Compliance does.' });
  assert.deepEqual(events[3], { ts: t0 + 20 * 60_000, kind: 'command', command: 'python3 system/check.py', code: 1 });
  assert.deepEqual({ ...events[4], ts: 0 }, { ts: 0, kind: 'agent', text: 'Make it hand those three to a person.', steps: 2, failed: 1, said: 'Done.' });
  assert.deepEqual(events[6], { ts: t0 + 50 * 60_000, kind: 'end', status: 'graded', score: 0.85 });
  // Somebody else's run is not theirs to look back over.
  await assert.rejects(session.openSession('looked-back', ['someone-else']), /不是你的练习/);
});
