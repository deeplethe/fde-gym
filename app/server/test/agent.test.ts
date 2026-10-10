/**
 * The site's half of the coding agent (../agent): a turn from start to end, and the relay pi's
 * model calls come through. The runner is a stand-in that plays pi's part from a script; the model
 * behind the relay is scripted too. Needs the local PostgreSQL (docker compose up -d postgres) and
 * works in a database of its own there; without one the tests are skipped.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import pg from 'pg';
import type { AgentEvent } from '../agent';
import type { AgentLine, AgentTurn } from '../pi';
import { RunnerOffline, type Runner } from '../runner-api';
import { fakeModel, freePort, type Reply, type Seen } from './fake-model';

const ADMIN = process.env.FDEGYM_TEST_DATABASE_URL || 'postgres://fdegym:fdegym@127.0.0.1:5432/fdegym';
const NAME = `fdegym_test_${process.pid}`;
const tmp = mkdtempSync(join(tmpdir(), 'fdegym-agent-test-'));

let agent: typeof import('../agent');
let dbm: typeof import('../db');
let model: Awaited<ReturnType<typeof fakeModel>>;
let site: ReturnType<typeof serve> | undefined;
let reachable = false;
let reply: (seen: Seen) => Reply = () => ({ text: 'ok' });

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN, connectionTimeoutMillis: 2000 });
  // Where a database is promised (CI), not reaching it is a failure, not a reason to skip.
  try { await admin.connect(); } catch (e) { if (process.env.FDEGYM_TEST_REQUIRE_DB) throw e; return; }
  reachable = true;
  await admin.query(`CREATE DATABASE ${NAME}`);
  await admin.end();

  model = await fakeModel((s) => reply(s));
  const port = await freePort();
  writeFileSync(join(tmp, 'key'), 'site-key\n');
  // Read when the modules load, so set first.
  Object.assign(process.env, {
    FDEGYM_DATABASE_URL: ADMIN.replace(/\/[^/]*$/, `/${NAME}`), FDEGYM_DATA: tmp, API_PORT: String(port),
    FDEGYM_OPENROUTER_KEY_FILE: join(tmp, 'key'), FDEGYM_PROXY: '',
  });
  dbm = await import('../db');
  await dbm.migrate();
  const { putSetting } = await import('../accounts');
  await putSetting('agent', { enabled: true, baseUrl: model.url, model: 'site/model', proxy: '', maxSteps: 3, maxUsd: 0.01 });
  agent = await import('../agent');
  const app = new Hono();
  agent.agentRoutes(app);
  site = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
});

after(async () => {
  if (!reachable) return;
  await new Promise<void>((ok) => (site ? site.close(() => ok()) : ok()));
  await model.close();
  await dbm.closeDb();
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
  await admin.end();
  rmSync(tmp, { recursive: true, force: true });
});

let runs = 0;
async function newRun(): Promise<string> {
  const id = `run-${++runs}`;
  await dbm.db.run("INSERT INTO runs (id, case_id, learner_id, learner_name, started_at, status) VALUES ($1, 'a_case', 'someone', 'Someone', $2, 'running')", [id, Date.now()]);
  return id;
}

/** A runner that plays pi's part: `play` is one turn, given what the site handed over and a way to say what happens. */
function runner(play: (turn: AgentTurn, say: (l: AgentLine) => void, stopped: Promise<void>) => Promise<void>) {
  let stop: () => void = () => undefined;
  const stops: string[] = [];
  const r = {
    name: 'stand-in', info: { execMode: 'local', isolation: 'none', host: 'here', agent: true },
    agentTurn: async (_name: string, turn: AgentTurn, onLine: (line: string) => void) => {
      const stopped = new Promise<void>((ok) => { stop = ok; });
      await play(turn, (l) => onLine(JSON.stringify(l)), stopped);
      return { code: 0, signal: null, stderr: '' };
    },
    agentStop: async (name: string) => { stops.push(name); stop(); return true; },
    // Unless a test says otherwise, it has no turn to take up again.
    agentAttach: async (): Promise<never> => { throw Object.assign(new Error('gone'), { status: 410 }); },
  } as unknown as Runner;
  return { r, stops };
}
/** A call to the relay, as pi makes it. */
const call = (turn: AgentTurn, body: object, token = turn.token) =>
  fetch(`${turn.url}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ask = { model: 'whatever/pi-asks-for', stream: true, messages: [{ role: 'user', content: 'hi' }] };

test('a turn: what happens is passed on in order and kept, and tools stand complete in the record', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const id = await newRun();
  const events: AgentEvent[] = [];
  const { r } = runner(async (_turn, say) => {
    say({ t: 'delta', text: 'Look' });
    say({ t: 'say', text: 'Looking.' });
    say({ t: 'tool', id: 'a', name: 'bash', args: {} });
    say({ t: 'args', id: 'a', args: { command: 'ls' } });
    say({ t: 'output', id: 'a', output: 'TASK' });
    say({ t: 'result', id: 'a', output: 'TASK.md\n', failed: false });
    say({ t: 'say', text: 'One file.', stop: 'stop' });
    say({ t: 'settled', aborted: false });
  });
  const busy: Promise<boolean>[] = [];
  const done = await agent.agentTurn(id, r, 'what is here?', (e) => { events.push(e); busy.push(agent.agentBusy(id)); });
  const busyAll = await Promise.all(busy);
  assert.equal(done.end, 'answered');
  assert.deepEqual(events.map((e) => e.event), ['delta', 'item', 'item', 'args', 'output', 'result', 'item']);
  assert.ok(busyAll.length > 0);
  assert.equal(await agent.agentBusy(id), false);
  assert.deepEqual(await agent.agentTranscript(id), [
    { kind: 'user', text: 'what is here?' },
    { kind: 'assistant', text: 'Looking.' },
    { kind: 'tool', id: 'a', name: 'bash', args: { command: 'ls' }, output: 'TASK.md\n', failed: false },
    { kind: 'assistant', text: 'One file.' },
  ]);
});

test('the relay: only the turn\'s token, the site\'s model and key, and the cost counted', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const id = await newRun();
  reply = () => ({ text: 'Hello.', usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.004 } });
  let kept: AgentTurn | undefined;
  const { r } = runner(async (turn) => {
    kept = turn;
    assert.equal((await call(turn, ask, 'fdegym-turn-not-this-one')).status, 401);
    const before = model.seen.length;
    const res = await call(turn, ask);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"content":"Hel"/);
    assert.match(text, /\[DONE\]/);
    const sent = model.seen[before];
    assert.equal(sent.authorization, 'Bearer site-key');
    assert.equal(sent.body.model, 'site/model');
    assert.equal(sent.body.stream_options.include_usage, true);
    // Not a stream: counted the same.
    assert.equal((await (await call(turn, { ...ask, stream: false })).json()).choices[0].message.content, 'Hello.');
  });
  const done = await agent.agentTurn(id, r, 'hi', () => undefined);
  assert.equal(done.end, 'answered');
  assert.equal(Math.round(done.spend.usd * 1000), 8);
  assert.equal(done.spend.tokens, 300);
  // Two calls on the bill; the conversation is as long as the last one left it, not their sum.
  assert.deepEqual([done.spend.prompt, done.spend.completion, done.spend.context], [240, 60, 150]);
  // pi is told the window the provider lists for the site's model.
  assert.equal(kept!.contextWindow, 200_000);
  // The token dies with the turn.
  assert.equal((await call(kept!, ask)).status, 401);
});

test('a run that has spent its allowance is refused the next call, and the turn ends saying so', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const id = await newRun();
  reply = () => ({ text: 'Costly.', usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.02 } });
  const { r } = runner(async (turn, say) => {
    assert.equal((await call(turn, ask)).status, 200);
    await (await call(turn, { ...ask, stream: false })).text();
    const refused = await call(turn, ask);
    assert.equal(refused.status, 402);
    // pi reports the failed call as the reply's end.
    say({ t: 'say', text: '', stop: 'error', error: '402' });
  });
  assert.equal((await agent.agentTurn(id, r, 'spend', () => undefined)).end, 'budget');
  await assert.rejects(agent.agentTurn(id, r, 'again', () => undefined), /用量已达上限/);
});

test('past the step limit the turn is stopped', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const id = await newRun();
  const { r, stops } = runner(async (_turn, say, stopped) => {
    for (const n of [1, 2, 3, 4]) {
      say({ t: 'tool', id: `s${n}`, name: 'bash', args: { command: `step ${n}` } });
      if (n < 4) say({ t: 'result', id: `s${n}`, output: 'ok', failed: false });
    }
    await stopped;
  });
  const events: AgentEvent[] = [];
  const done = await agent.agentTurn(id, r, 'go on for ever', (e) => events.push(e));
  assert.equal(done.end, 'steps');
  assert.deepEqual(stops, [id]);
  // The one cut off is closed in the record as not finished.
  const last = (await agent.agentTranscript(id)).at(-1);
  assert.deepEqual(last, { kind: 'tool', id: 's4', name: 'bash', args: { command: 'step 4' }, output: 'Stopped before this finished.', failed: true });
  assert.deepEqual(events.at(-1), { event: 'result', data: { id: 's4', output: 'Stopped before this finished.', failed: true } });
});

test('stopping: the runner is told, and the turn ends as stopped', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const id = await newRun();
  const { r, stops } = runner(async (_turn, say, stopped) => {
    say({ t: 'tool', id: 'long', name: 'bash', args: { command: 'sleep 600' } });
    await stopped;
  });
  const running = agent.agentTurn(id, r, 'sleep', () => undefined);
  await new Promise((ok) => setTimeout(ok, 50));
  await assert.rejects(agent.agentTurn(id, r, 'meanwhile', () => undefined), /上一条消息/);
  assert.equal(await agent.agentBusy(id), true);
  assert.equal(await agent.stopAgent(id, r), true);
  assert.equal((await running).end, 'stopped');
  assert.deepEqual(stops, [id]);
  assert.equal(await agent.stopAgent(id, r), false);
});

test('a model call that fails for good is an error, not an answer', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const id = await newRun();
  const { r } = runner(async (_turn, say) => {
    // Tried again and failed again: only the last reply counts.
    say({ t: 'say', text: '', stop: 'error', error: 'overloaded' });
    say({ t: 'retry', message: 'overloaded' });
    say({ t: 'say', text: '', stop: 'error', error: 'overloaded' });
  });
  await assert.rejects(agent.agentTurn(id, r, 'hi', () => undefined), /模型服务调用失败/);
  assert.equal(await agent.agentBusy(id), false);
  // Tried again and it worked: an answer.
  const { r: second } = runner(async (_turn, say) => {
    say({ t: 'say', text: '', stop: 'error', error: 'overloaded' });
    say({ t: 'say', text: 'Here now.', stop: 'stop' });
  });
  assert.equal((await agent.agentTurn(id, second, 'hi again', () => undefined)).end, 'answered');
});

test('a runner without the agent installed is said to be so', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const id = await newRun();
  const { r } = runner(async () => undefined);
  (r.info as { agent?: boolean }).agent = false;
  await assert.rejects(agent.agentTurn(id, r, 'hi', () => undefined), /没有装 coding agent/);
});

test('conversations from before the agent was pi are still shown', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const id = await newRun();
  const old = [
    { role: 'user', content: 'list the files' },
    { role: 'assistant', content: 'Listing.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'TASK.md  12' },
    { role: 'assistant', content: 'One file.' },
  ];
  for (const m of old) await dbm.db.run('INSERT INTO agent_messages (run_id, message, ts) VALUES ($1, $2::jsonb, $3)', [id, JSON.stringify(m), Date.now()]);
  assert.deepEqual(await agent.agentTranscript(id), [
    { kind: 'user', text: 'list the files' },
    { kind: 'assistant', text: 'Listing.' },
    { kind: 'tool', id: 'c1', name: 'list_files', args: {}, output: 'TASK.md  12' },
    { kind: 'assistant', text: 'One file.' },
  ]);
});

test('touch with the runner lost mid-turn: the turn stays under way, and is taken up from where its record stands', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const id = await newRun();
  // What pi says in this turn, numbered as the runner numbers it.
  const told: AgentLine[] = [
    { n: 1, t: 'say', text: 'Looking.' },
    { n: 2, t: 'tool', id: 'a', name: 'bash', args: {} },
    { n: 3, t: 'args', id: 'a', args: { command: 'ls' } },
    { n: 4, t: 'result', id: 'a', output: 'TASK.md\n', failed: false },
    { n: 5, t: 'tool', id: 'b', name: 'read', args: { path: 'TASK.md' } },
    { n: 6, t: 'result', id: 'b', output: 'The brief.', failed: false },
    { n: 7, t: 'say', text: 'Read it.', stop: 'stop' },
  ];
  let kept: AgentTurn | undefined;
  const { r } = runner(async (turn, say) => {
    kept = turn;
    for (const l of told.slice(0, 5)) say(l);
    throw new RunnerOffline('the line dropped', 503);
  });
  const events: AgentEvent[] = [];
  assert.equal((await agent.agentTurn(id, r, 'read the brief', (e) => events.push(e))).end, 'detached');
  assert.deepEqual(events.map((e) => e.event), ['item', 'item', 'args', 'result', 'item']);
  // Still under way as far as anyone asking can tell, and pi's calls are still let through.
  assert.equal(await agent.agentBusy(id), true);
  await assert.rejects(agent.agentTurn(id, r, 'meanwhile', () => undefined), /上一条消息/);
  reply = () => ({ text: 'Still here.' });
  assert.equal((await call(kept!, { ...ask, stream: false })).status, 200);
  // Kept so far: what was complete when the line dropped (the second tool had not come back).
  assert.equal((await agent.agentTranscript(id)).length, 3);

  // The runner is back and tells the turn from the start.
  let attached: (() => void) | undefined;
  const back = { ...r, agentAttach: async (_name: string, onLine: (line: string) => void) => { for (const l of told) onLine(JSON.stringify(l)); attached?.(); return { code: 0, signal: null, stderr: '' }; } } as unknown as Runner;
  const done = new Promise<void>((ok) => { attached = ok; });
  await agent.resumeTurns(back);
  await done;
  for (let i = 0; i < 50 && await agent.agentBusy(id); i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(await agent.agentBusy(id), false);
  // Nothing twice, nothing missing.
  assert.deepEqual(await agent.agentTranscript(id), [
    { kind: 'user', text: 'read the brief' },
    { kind: 'assistant', text: 'Looking.' },
    { kind: 'tool', id: 'a', name: 'bash', args: { command: 'ls' }, output: 'TASK.md\n', failed: false },
    { kind: 'tool', id: 'b', name: 'read', args: { path: 'TASK.md' }, output: 'The brief.', failed: false },
    { kind: 'assistant', text: 'Read it.' },
  ]);
  assert.equal((await call(kept!, ask)).status, 401);
});

test('a turn the runner no longer has is closed when the runner is back', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const id = await newRun();
  const { r } = runner(async () => { throw new RunnerOffline('the line dropped', 503); });
  assert.equal((await agent.agentTurn(id, r, 'hi', () => undefined)).end, 'detached');
  assert.equal(await agent.agentBusy(id), true);
  await agent.resumeTurns(r);
  for (let i = 0; i < 50 && await agent.agentBusy(id); i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(await agent.agentBusy(id), false);
});

test('a turn nobody is following can still be let go of', async (t) => {
  if (!reachable) return t.skip('no local PostgreSQL');
  const id = await newRun();
  const { r, stops } = runner(async () => { throw new RunnerOffline('the line dropped', 503); });
  assert.equal((await agent.agentTurn(id, r, 'hi', () => undefined)).end, 'detached');
  assert.equal(await agent.stopAgent(id, r), true);
  assert.deepEqual(stops, [id]);
  assert.equal(await agent.agentBusy(id), false);
  assert.equal(await agent.stopAgent(id, r), false);
});
