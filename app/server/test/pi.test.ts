/**
 * The runner's half of the coding agent (../pi): real pi, started the way a turn starts it, against
 * a scripted model. Needs no database and no model key.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { AgentLine, AgentTurn } from '../pi';
import { fakeModel, type Reply, type Seen } from './fake-model';

// Where runs live is read when the modules load, so it is set first and they are loaded after.
const data = realpathSync(mkdtempSync(join(tmpdir(), 'fdegym-pi-test-')));
process.env.FDEGYM_DATA = data;
let pi: typeof import('../pi');
let model: Awaited<ReturnType<typeof fakeModel>>;
let script: (seen: Seen) => Reply = () => ({ text: 'ok' });
/** What the model replies from here on; `n` counts its calls since this was set. */
function play(f: (seen: Seen, n: number) => Reply) { let n = 0; script = (seen) => f(seen, ++n); }

before(async () => {
  pi = await import('../pi');
  model = await fakeModel((s) => script(s));
});
after(async () => {
  await model.close();
  rmSync(data, { recursive: true, force: true });
});

let runs = 0;
/** A run's folder as the harness leaves it, as far as the agent is concerned. */
function newRun(): { name: string; ws: string } {
  const name = `run-${++runs}`;
  const ws = join(data, 'runs', name, 'workspace');
  mkdirSync(join(ws, 'bin'), { recursive: true });
  writeFileSync(join(ws, 'TASK.md'), 'The brief.\n');
  writeFileSync(join(ws, 'bin', 'ask'), '#!/bin/sh\necho "asked the customer"\n', { mode: 0o755 });
  return { name, ws };
}
const turn = (message: string): AgentTurn => ({ message, model: 'test/model', url: model.url, token: 'turn-token', system: 'You work in a test.' });
async function run(name: string, message: string, onLine?: (l: AgentLine) => void) {
  const lines: AgentLine[] = [];
  // Without the numbers the lines travel with; the test of taking a turn up again looks at those.
  const r = await pi.agentTurn(name, turn(message), (raw) => { const { n: _n, ...l } = JSON.parse(raw) as AgentLine & { n?: number }; lines.push(l as AgentLine); onLine?.(l as AgentLine); });
  return { ...r, lines };
}
const kinds = (lines: AgentLine[]) => lines.map((l) => l.t).filter((t, i, a) => t !== a[i - 1]);

test('pi is installed', () => { assert.equal(pi.AGENT_READY, true); });

test('words only: streamed in pieces, then the finished piece', async () => {
  play(() => ({ text: 'Hello there.' }));
  const { name } = newRun();
  const before = model.seen.length;
  const r = await run(name, 'hi');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(kinds(r.lines), ['delta', 'say', 'settled']);
  assert.equal(r.lines.filter((l) => l.t === 'delta').map((l) => (l as { text: string }).text).join(''), 'Hello there.');
  assert.deepEqual(r.lines.find((l) => l.t === 'say'), { t: 'say', text: 'Hello there.', stop: 'stop' });
  // It called where it was pointed, with the turn's token and the model it was given, and nothing of its own.
  const req = model.seen[before];
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.authorization, 'Bearer turn-token');
  assert.equal(req.body.model, 'test/model');
  assert.deepEqual(req.body.tools.map((t: { function: { name: string } }) => t.function.name).sort(), ['bash', 'edit', 'read', 'write']);
  assert.match(JSON.stringify(req.body.messages[0]), /You work in a test\./);
});

test('a tool call: shown as soon as it is named, with paths from the workspace root, and what it said first comes first', async () => {
  const { name, ws } = newRun();
  play((_s, n) => (n === 1 ? { text: 'Reading the brief.', tools: [{ name: 'bash', args: { command: `cd ${ws} && cat ${ws}/TASK.md` } }] } : { text: 'Done.' }));
  const r = await run(name, 'read the brief');
  assert.equal(r.code, 0, r.stderr);
  const order = r.lines.filter((l) => l.t !== 'delta' && l.t !== 'output');
  // The reply ends (its words already passed on) before the tool is run with its whole arguments.
  assert.deepEqual(order.map((l) => l.t), ['say', 'tool', 'args', 'say', 'args', 'result', 'say', 'settled']);
  assert.equal((order[0] as { text: string }).text, 'Reading the brief.');
  assert.deepEqual({ ...order[1], id: '' }, { t: 'tool', id: '', name: 'bash', args: {} });
  // Known early (from the pieces) and again when complete: the command, without the workspace's own path in it.
  for (const l of [order[2], order[4]]) assert.deepEqual((l as { args: unknown }).args, { command: 'cat TASK.md' });
  assert.equal((order[3] as { text: string }).text, '');
  assert.deepEqual({ ...order[5], id: '' }, { t: 'result', id: '', output: 'The brief.\n', failed: false });
  assert.equal((order[6] as { text: string }).text, 'Done.');
});

test('it writes and edits files in the workspace', async () => {
  const { name, ws } = newRun();
  play((_s, n) => (n === 1 ? { tools: [{ name: 'write', args: { path: 'deliverables/note.md', content: 'hello' } }] }
    : n === 2 ? { tools: [{ name: 'edit', args: { path: 'deliverables/note.md', edits: [{ oldText: 'hello', newText: 'hello pi' }] } }] }
      : { text: 'Written.' }));
  const r = await run(name, 'write a note');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(join(ws, 'deliverables', 'note.md'), 'utf8'), 'hello pi');
  assert.deepEqual(r.lines.filter((l) => l.t === 'result').map((l) => (l as { failed: boolean }).failed), [false, false]);
});

test('asking the customer\'s people is refused', async () => {
  const { name } = newRun();
  play((_s, n) => (n === 1 ? { tools: [{ name: 'bash', args: { command: 'bin/ask --help' } }] } : { text: 'It was refused.' }));
  const r = await run(name, 'run bin/ask');
  const result = r.lines.find((l) => l.t === 'result') as { output: string; failed: boolean };
  assert.equal(result.failed, true);
  assert.match(result.output, /^Not run: contacting the customer's people/);
  assert.doesNotMatch(result.output, /asked the customer/);
});

test('the next message carries on the same conversation', async () => {
  const { name } = newRun();
  play(() => ({ text: 'Noted.' }));
  await run(name, 'remember the word marmalade');
  const before = model.seen.length;
  await run(name, 'what was the word?');
  const said = model.seen[before].body.messages.map((m: { role: string; content: unknown }) => `${m.role}: ${JSON.stringify(m.content)}`).join('\n');
  assert.match(said, /user: .*marmalade/);
  assert.match(said, /assistant: .*Noted\./);
  assert.match(said, /user: .*what was the word/);
});

test('stopping a turn ends it at once and takes its command with it', async () => {
  const { name, ws } = newRun();
  play((_s, n) => (n === 1 ? { tools: [{ name: 'bash', args: { command: 'echo started > started.txt; sleep 30; echo finished > finished.txt' } }] } : { text: 'never said' }));
  const t0 = Date.now();
  let stopped = false;
  const r = await run(name, 'sleep', (l) => {
    // The command is under way once its output or its full arguments have been seen; give it a moment to start.
    if (!stopped && l.t === 'args' && String((l.args as { command?: string }).command).includes('sleep 30')) {
      stopped = true;
      setTimeout(() => { assert.equal(pi.agentRunning(name), true); assert.equal(pi.agentStop(name), true); }, 1500);
    }
  });
  assert.ok(Date.now() - t0 < 12_000, `took ${Date.now() - t0} ms`);
  assert.equal(pi.agentRunning(name), false);
  assert.equal(r.lines.some((l) => l.t === 'say' && l.text === 'never said'), false);
  assert.equal(readFileSync(join(ws, 'started.txt'), 'utf8'), 'started\n');
  // Long enough for the command to have finished had it been left running: it was not.
  await new Promise((ok) => setTimeout(ok, 500));
  assert.throws(() => readFileSync(join(ws, 'finished.txt')));
  assert.equal(pi.agentStop(name), false);
});

test('one turn at a time for a run', async () => {
  const { name } = newRun();
  play((_s, n) => (n === 1 ? { tools: [{ name: 'bash', args: { command: 'sleep 2' } }] } : { text: 'ok' }));
  const first = run(name, 'slow');
  await new Promise((ok) => setTimeout(ok, 300));
  assert.throws(() => pi.agentTurn(name, turn('again'), () => undefined), /上一条消息/);
  await first;
});

test('a turn can be taken up again: told from the start while it runs, and after it has ended', async () => {
  const { name } = newRun();
  play((_s, n) => (n === 1 ? { text: 'Waiting a moment.', tools: [{ name: 'bash', args: { command: 'sleep 2; echo woke' } }] } : { text: 'Awake.' }));
  assert.throws(() => pi.agentAttach(name, () => undefined), /已经不在了/);
  const first: AgentLine[] = [];
  const turnEnd = pi.agentTurn(name, turn('wait'), (raw) => first.push(JSON.parse(raw) as AgentLine));
  // Once the command is under way, someone else takes the turn over: the first listener hears no more.
  while (!first.some((l) => l.t === 'args' && String((l.args as { command?: string }).command).includes('sleep'))) await new Promise((ok) => setTimeout(ok, 50));
  const heardByFirst = first.length;
  const second: AgentLine[] = [];
  const end = await pi.agentAttach(name, (raw) => second.push(JSON.parse(raw) as AgentLine));
  assert.equal(end.code, 0);
  assert.deepEqual(await turnEnd, end);
  assert.equal(first.length, heardByFirst);
  // The whole turn, in order, numbered without a gap in what is kept.
  const whole = second.filter((l) => l.t !== 'delta' && l.t !== 'output');
  assert.deepEqual(whole.map((l) => l.t), ['say', 'tool', 'args', 'say', 'args', 'result', 'say', 'settled']);
  assert.ok(whole.every((l, i) => i === 0 || l.n! > whole[i - 1].n!));
  assert.equal((whole[5] as { output: string }).output, 'woke\n');
  // And once more after the end: the same, at once.
  const third: AgentLine[] = [];
  assert.deepEqual(await pi.agentAttach(name, (raw) => third.push(JSON.parse(raw) as AgentLine)), end);
  assert.deepEqual(third.map((l) => l.n), whole.map((l) => l.n));
});
