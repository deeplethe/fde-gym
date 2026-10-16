/**
 * The coding agent a learner directs. People deliver through a coding agent now, so this is how a
 * learner works in the workspace: they say what they want, the agent reads files, runs commands and
 * edits the customer's system, and the learner keeps the judgement: what the sponsor really needs,
 * whom to ask, when to stop.
 *
 * The agent is pi. It runs on the run's runner, in the workspace, as the user a learner's commands
 * run as (see ./pi); this module is the site's half. It starts a turn and passes on what happens,
 * keeps what the page shows of the conversation, and is where pi's model calls come to: pi holds no
 * key, so it calls POST /api/agent/v1/chat/completions here with a token good for the one turn, and
 * the site sends the call on to the endpoint set in the admin pages (./agent-settings), with its own
 * key, and counts what the run spends. Two things stay with the learner on purpose: talking to the
 * customer's people and starting a trial day. Both cost the engagement something, and knowing when
 * they are worth it is part of what is practised.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { fetch as proxiedFetch, ProxyAgent } from 'undici';
import { agentConfig, contextWindow } from './agent-settings';
import { db, json } from './db';
import type { AgentLine } from './pi';
import { RunnerOffline, type Runner } from './runner-api';
import { SessionError } from './session-error';

/** What the page shows of the conversation. */
export type AgentItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  /** What the model thought before it went on, and for how long (ms). Empty when the provider keeps it to itself. */
  | { kind: 'thought'; text: string; ms?: number }
  | {
    kind: 'tool'; id: string; name: string; args: Record<string, unknown>; output?: string; failed?: boolean;
    /** What a command still running has printed so far. */ partial?: string;
    /** How long it took, from being called to coming back (ms). */ ms?: number;
    /** An edit's change to the file, as a unified diff. */ patch?: string;
  };
type Tool = Extract<AgentItem, { kind: 'tool' }>;

/** Added to pi's own system prompt for every turn. */
const SYSTEM = `You are working for a forward deployed engineer inside a customer's workspace, which is the current directory. \
The engineer tells you what they want; you do it and report back briefly.

Whose work this is:
- The engagement is the engineer's, not yours. You act on their latest message and on nothing else. Never start on \
the brief, or carry on with it, because it is there: wait to be told what to do.
- A greeting, small talk, or a question you can answer from what has already been said gets a short answer in words \
and no tool calls. If it is not clear what they want done, ask.
- Do what was asked and stop there. Do not go on to the next step you can see; say in a line what you would do next \
and let the engineer decide.

The workspace:
- TASK.md is the brief the customer gave the engineer. It is background for you, not a list of things to do. Read it \
before your first change to system/ if you have not.
- system/ is the customer's live system. Whatever is in it when the engineer submits goes to production unchanged, \
and production calls only the entry points listed in system/README.md.
- docs/ and data/ are the customer's documents and historical data. deliverables/ is for what the engineer hands over.
- The customer's machine has the Python 3.9 standard library and SQLite only: no pip installs, no network, except the \
company LLM gateway reached through system/llm_client.py, which is metered and capped.

How to work:
- Look before you change: read the files and data the request touches, and run what is there. Only those.
- Make the changes the engineer asked for and verify them by running them. Keep changes small and say what you did.
- Paths are relative to the workspace root; stay inside it. Use python3, not python.
- You cannot contact the customer's people or start a trial run; bin/ask and bin/pilot are the engineer's to use. \
If something can only be settled by asking a person, say exactly what you would ask and whom, and let the engineer decide.
- Do not guess at business rules the workspace does not state. Say what is unknown.
- Reply in the language the engineer writes in. Be brief: what you found, what you changed, what is left open.`;

// ---- what has been said, as the page shows it (kept in the site's database; pi keeps its own session beside the workspace)

/** Rows written before the agent was pi hold the chat messages of the site's own tool-calling loop; they are still shown. */
type OldMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };
type Stored = { v: 2; item: AgentItem } | OldMessage;

const parseArgs = (raw: string): Record<string, unknown> => { try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const remember = (runId: string, item: AgentItem) =>
  db.run('INSERT INTO agent_messages (run_id, message, ts) VALUES ($1, $2::jsonb, $3)', [runId, json({ v: 2, item } satisfies Stored), Date.now()]);

export async function agentTranscript(runId: string): Promise<AgentItem[]> {
  const items: AgentItem[] = [];
  const tools = new Map<string, Tool>();
  for (const { message: m } of await db.query<{ message: Stored }>('SELECT message FROM agent_messages WHERE run_id = $1 ORDER BY id', [runId])) {
    if ('v' in m) items.push(m.item);
    else if (m.role === 'user') items.push({ kind: 'user', text: m.content });
    else if (m.role === 'assistant') {
      if (m.content?.trim()) items.push({ kind: 'assistant', text: m.content });
      for (const c of m.tool_calls ?? []) {
        const item: Tool = { kind: 'tool', id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) };
        tools.set(c.id, item);
        items.push(item);
      }
    } else if (m.role === 'tool') { const t = tools.get(m.tool_call_id); if (t) t.output = m.content; }
  }
  return items;
}

/**
 * The conversation as turns, with when each began: what the learner asked for, how much work came
 * of it, and how it ended. For looking back over a run (see Session.timeline); the page's own view
 * of the conversation is agentTranscript.
 */
export interface AgentTurnLog { ts: number; text: string; steps: number; failed: number; said: string }
export async function agentTurnLog(runId: string): Promise<AgentTurnLog[]> {
  const turns: AgentTurnLog[] = [];
  const failedOutput = (o: string | undefined) => !!o && (/^error:|^Not run:/.test(o) || /\[exit (?!0\])[^\]]+\]\s*$/.test(o));
  for (const { message: m, ts } of await db.query<{ message: Stored; ts: number }>('SELECT message, ts FROM agent_messages WHERE run_id = $1 ORDER BY id', [runId])) {
    // Either the page's item (since the agent is pi) or a chat message of the earlier loop.
    const item: AgentItem | undefined = 'v' in m ? m.item : m.role === 'user' ? { kind: 'user', text: m.content } : undefined;
    if (item?.kind === 'user') { turns.push({ ts, text: item.text, steps: 0, failed: 0, said: '' }); continue; }
    const turn = turns.at(-1);
    if (!turn) continue;
    if (item?.kind === 'tool') { turn.steps++; if (item.failed ?? failedOutput(item.output)) turn.failed++; }
    else if (item?.kind === 'assistant') turn.said = item.text;
    else if (!('v' in m) && m.role === 'assistant') { turn.steps += m.tool_calls?.length ?? 0; if (m.content?.trim()) turn.said = m.content; }
    else if (!('v' in m) && m.role === 'tool' && failedOutput(m.content)) turn.failed++;
  }
  return turns;
}

/** What the agent has used in a run: the bill so far, and how much of the model's window the conversation takes now. */
export type AgentSpend = { usd: number; tokens: number; prompt: number; completion: number; context: number };
export async function agentSpend(runId: string): Promise<AgentSpend> {
  const r = await db.one<{ prompt_tokens: number; completion_tokens: number; usd: number; context_tokens: number }>('SELECT prompt_tokens, completion_tokens, usd, context_tokens FROM agent_usage WHERE run_id = $1', [runId]);
  const prompt = Number(r?.prompt_tokens ?? 0), completion = Number(r?.completion_tokens ?? 0);
  return { usd: r?.usd ?? 0, tokens: prompt + completion, prompt, completion, context: Number(r?.context_tokens ?? 0) };
}
/** One model call: added to the bill. What it read and wrote is what the conversation holds after it. */
async function charge(runId: string, prompt: number, completion: number, usd: number) {
  await db.run(`INSERT INTO agent_usage (run_id, prompt_tokens, completion_tokens, usd, context_tokens) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (run_id) DO UPDATE SET prompt_tokens = agent_usage.prompt_tokens + EXCLUDED.prompt_tokens, completion_tokens = agent_usage.completion_tokens + EXCLUDED.completion_tokens, usd = agent_usage.usd + EXCLUDED.usd, context_tokens = EXCLUDED.context_tokens`,
  [runId, prompt, completion, usd, prompt + completion]);
}

// ---- one turn

export type AgentEnd = 'answered' | 'stopped' | 'steps' | 'budget' | 'detached';
export type Outcome = { end: AgentEnd; spend: AgentSpend };

/** Turns this process is following right now. */
const running = new Map<string, AbortController>();
/** The token pi was given for a turn under way, to the run it belongs to (a cache of agent_turns). */
const turns = new Map<string, string>();
/** Runs whose turn was refused a model call because the run's allowance for the agent is used up. */
const spentOut = new Set<string>();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** No turn lasts longer than the runner lets it; a record older than this is of a turn that was lost. */
const TURN_MS = 40 * 60_000;

/**
 * A turn under way is on record (agent_turns), not only in this process, because it belongs to the
 * runner where pi is working: if the site restarts, or loses touch with the runner, pi goes on, and
 * the site takes the turn up again when they are back in touch (resumeTurns). The record holds the
 * hash of the turn's token, so pi's model calls are still let through, and how far the turn's
 * lines have been kept, so none is kept twice.
 */
const closeTurn = async (runId: string) => {
  for (const [token, id] of turns) if (id === runId) turns.delete(token);
  await db.run('DELETE FROM agent_turns WHERE run_id = $1', [runId]);
};

export async function agentBusy(runId: string): Promise<boolean> {
  if (running.has(runId)) return true;
  const row = await db.one<{ started_at: number }>('SELECT started_at FROM agent_turns WHERE run_id = $1', [runId]);
  if (!row) return false;
  if (Date.now() - row.started_at < TURN_MS) return true;
  await closeTurn(runId);
  return false;
}

/** Where pi on this very machine reaches the relay below; a runner elsewhere uses the site's address as it knows it. */
const SELF = `http://127.0.0.1:${Number(process.env.API_PORT ?? process.env.PORT ?? 8787)}/api/agent/v1`;

export async function stopAgent(runId: string, runner?: Runner): Promise<boolean> {
  const c = running.get(runId);
  if (c) {
    c.abort();
    void runner?.agentStop(runId).catch(() => undefined);
    return true;
  }
  // Nobody here is following it (the site restarted and has not heard from the runner since): let go of it.
  const had = await db.run('DELETE FROM agent_turns WHERE run_id = $1', [runId]);
  if (had) void runner?.agentStop(runId).catch(() => undefined);
  return had > 0;
}

/** What the page is told of a turn as it happens. */
export type AgentEvent =
  | { event: 'item'; data: AgentItem }
  | { event: 'delta'; data: { text: string } }
  /** A piece of what the model is thinking; the whole of it follows as a `thought` item. */
  | { event: 'think'; data: { text: string } }
  /** How much of a tool call's arguments the model has written so far. */
  | { event: 'drafting'; data: { id: string; chars: number } }
  | { event: 'args'; data: { id: string; args: Record<string, unknown> } }
  | { event: 'output'; data: { id: string; output: string } }
  | { event: 'result'; data: { id: string; output: string; failed: boolean; ms?: number; patch?: string } }
  /** A model call failed and pi is trying it again. */
  | { event: 'retry'; data: { message: string } }
  /** What the run has spent, after each model call. */
  | { event: 'spend'; data: AgentSpend }
  | { event: 'done'; data: Outcome }
  | { event: 'error'; data: { error: string } };

// ---- a turn as it happens, for every page watching it

/**
 * A turn under way, as the pages watching it are told it: every event in order, numbered from 1
 * (`seq`) and stamped with the site's time. A page that opens later, reloads, or loses its stream
 * says how far it got and hears the rest; one that comes to a turn already under way hears it from
 * the start. Pieces of text and of thinking that come close together are told as one. A turn taken
 * up again after touch with the runner was lost (resumeTurns) is told afresh, as a new one.
 */
export type LiveEvent = AgentEvent & { seq: number; at: number };
interface Live {
  id: string; startedAt: number; events: LiveEvent[]; over: boolean;
  watchers: Set<(e: LiveEvent) => void>; pending?: { event: 'delta' | 'think'; text: string }; timer?: ReturnType<typeof setTimeout>;
}
const lives = new Map<string, Live>();
/** How long pieces of text wait for the next before they are told, together. */
const MERGE_MS = 60;
/** How long an ended turn can still be heard, by a page that was away when it ended. */
const LIVE_KEPT_MS = 10 * 60_000;

function openLive(runId: string, user: string): Live {
  const old = lives.get(runId);
  if (old && !old.over) closeLive(runId, old, { event: 'done', data: { end: 'detached', spend: { usd: 0, tokens: 0, prompt: 0, completion: 0, context: 0 } } });
  const live: Live = { id: randomBytes(6).toString('base64url'), startedAt: Date.now(), events: [], over: false, watchers: new Set() };
  lives.set(runId, live);
  tell(live, { event: 'item', data: { kind: 'user', text: user } });
  return live;
}
function told(live: Live, e: AgentEvent) {
  const one = { ...e, seq: live.events.length + 1, at: Date.now() } as LiveEvent;
  live.events.push(one);
  for (const w of live.watchers) w(one);
}
function flush(live: Live) {
  if (live.timer) { clearTimeout(live.timer); live.timer = undefined; }
  const p = live.pending;
  live.pending = undefined;
  if (p) told(live, { event: p.event, data: { text: p.text } });
}
function tell(live: Live, e: AgentEvent) {
  if (live.over) return;
  if (e.event === 'delta' || e.event === 'think') {
    if (live.pending && live.pending.event !== e.event) flush(live);
    if (live.pending) live.pending.text += e.data.text;
    else live.pending = { event: e.event, text: e.data.text };
    live.timer ??= setTimeout(() => flush(live), MERGE_MS);
    return;
  }
  flush(live);
  told(live, e);
}
function closeLive(runId: string, live: Live, last: AgentEvent) {
  tell(live, last);
  live.over = true;
  live.watchers.clear();
  setTimeout(() => { if (lives.get(runId) === live) lives.delete(runId); }, LIVE_KEPT_MS).unref();
}
const tellRun = (runId: string, e: AgentEvent) => { const live = lives.get(runId); if (live) tell(live, e); };

/** The turn under way in a run, if this site is following one: its id, and when it began. */
export function liveTurn(runId: string): { turn: string; startedAt: number } | undefined {
  const live = lives.get(runId);
  return live && !live.over ? { turn: live.id, startedAt: live.startedAt } : undefined;
}

/**
 * Hear a turn from after `after`: what it has told so far at once, then the rest as it happens.
 * Undefined when the run has no such turn (it is not `turn`, or the site no longer has it): the
 * page then reads the conversation afresh. `stop` lets go; an ended turn lets go by itself.
 */
export function followTurn(runId: string, turn: string | undefined, after: number, on: (e: LiveEvent) => void): { over: boolean; startedAt: number; stop: () => void } | undefined {
  const live = lives.get(runId);
  if (!live || (turn && turn !== live.id)) return undefined;
  for (const e of live.events) if (e.seq > after) on(e);
  if (live.over) return { over: true, startedAt: live.startedAt, stop: () => undefined };
  live.watchers.add(on);
  return { over: false, startedAt: live.startedAt, stop: () => live.watchers.delete(on) };
}

/**
 * What the learner is told when the model provider failed the turn: the kind of failure, by the
 * provider's status (pi reports a failed call as "402: {...}"), so that one that will not mend by
 * trying again says whom to tell. The provider's own words stay in the site's log.
 */
export function failureText(failure: string | undefined): string {
  const status = Number(/^\s*(\d{3})\b/.exec(failure ?? '')?.[1]);
  if (status === 402) return '助手的模型服务余额不足，请联系管理员充值或更换「助手」设置里的接口';
  if (status === 401 || status === 403) return '助手的模型服务不接受本站的密钥，请联系管理员检查「助手」设置';
  if (status === 429) return '助手的模型服务现在请求太多，请稍后再试';
  return '助手的模型服务调用失败，请稍后再试；一直失败请联系管理员检查「助手」设置';
}

/**
 * Reads a turn's lines as the runner sends them: passes each on (`emit`) and keeps what the page
 * shows of it. `have` is how far the lines were already kept, when a turn is taken up again: the
 * runner then tells it from the start, and the earlier lines rebuild where the turn stands, for
 * the pages watching it, without being kept twice.
 */
function reader(runId: string, maxSteps: number, runner: Runner, control: AbortController, emit: (e: AgentEvent) => void, have = 0) {
  const turn: { end: AgentEnd; failure?: string; steps: number; last: number } = { end: 'answered', steps: 0, last: have };
  // Written one after another, in the order things happened, each with how far that brings the record.
  let saved: Promise<unknown> = Promise.resolve();
  const save = (item: AgentItem, n: number) => {
    if (n <= have) return;
    saved = saved.then(() => db.run(`WITH kept AS (INSERT INTO agent_messages (run_id, message, ts) VALUES ($1, $2::jsonb, $3))
      UPDATE agent_turns SET seq = $4 WHERE run_id = $1`, [runId, json({ v: 2, item } satisfies Stored), Date.now(), n])).catch((e) => console.error(e));
  };
  // Tools called and not yet back, with when each was called (on the runner's clock, as their results are).
  const open = new Map<string, { item: Tool; at?: number }>();
  const finish = (id: string, output: string, failed: boolean, n: number, at?: number, patch?: string) => {
    const o = open.get(id);
    if (!o) return;
    open.delete(id);
    const ms = at !== undefined && o.at !== undefined ? Math.max(0, at - o.at) : undefined;
    const done = { output, failed, ...(ms !== undefined ? { ms } : {}), ...(patch ? { patch } : {}) };
    save({ ...o.item, ...done }, n);
    emit({ event: 'result', data: { id, ...done } });
  };
  const onLine = (line: string) => {
    let l: AgentLine;
    try { l = JSON.parse(line) as AgentLine; } catch { return; }
    const n = l.n ?? turn.last + 1;
    turn.last = Math.max(turn.last, n);
    if (l.t === 'delta') emit({ event: 'delta', data: { text: l.text } });
    else if (l.t === 'think') emit({ event: 'think', data: { text: l.text } });
    else if (l.t === 'thought') {
      const item: AgentItem = { kind: 'thought', text: l.text, ms: l.ms };
      save(item, n);
      emit({ event: 'item', data: item });
    } else if (l.t === 'say') {
      if (l.text.trim()) { const item: AgentItem = { kind: 'assistant', text: l.text }; save(item, n); emit({ event: 'item', data: item }); }
      // A failed reply may be tried again; only the last one counts.
      turn.failure = l.stop === 'error' ? (l.error || 'the model call failed') : undefined;
    } else if (l.t === 'tool') {
      const item: Tool = { kind: 'tool', id: l.id, name: l.name, args: l.args };
      open.set(l.id, { item, at: l.at });
      emit({ event: 'item', data: item });
      if (++turn.steps > maxSteps && !control.signal.aborted) { turn.end = 'steps'; control.abort(); void runner.agentStop(runId).catch(() => undefined); }
    } else if (l.t === 'drafting') emit({ event: 'drafting', data: { id: l.id, chars: l.chars } });
    else if (l.t === 'args') {
      const o = open.get(l.id);
      // The call is made once its arguments are whole; how long it took is counted from there.
      if (o) { o.item.args = l.args; if (l.at !== undefined) o.at = l.at; emit({ event: 'args', data: { id: l.id, args: l.args } }); }
    } else if (l.t === 'output') emit({ event: 'output', data: { id: l.id, output: l.output } });
    else if (l.t === 'result') finish(l.id, l.output, l.failed, n, l.at, l.patch);
    else if (l.t === 'retry') emit({ event: 'retry', data: { message: l.message } });
  };
  return {
    onLine,
    /** Touch with the runner was lost: what was read is kept, and the turn stays on record to be taken up again. */
    settle: () => saved,
    /** pi has exited: close what was left open and the record, and say why the turn ended. */
    async end(r: { code: number | null; signal: string | null; stderr: string }): Promise<Outcome> {
      // Whatever was still running when the turn was stopped did not finish.
      for (const id of [...open.keys()]) finish(id, 'Stopped before this finished.', true, turn.last + 1);
      await saved;
      await closeTurn(runId);
      if (turn.end !== 'steps') {
        if (control.signal.aborted) turn.end = 'stopped';
        else if (spentOut.has(runId)) turn.end = 'budget';
        else if (turn.failure || r.code !== 0) {
          console.error('agent turn failed:', turn.failure ?? (r.stderr.trim() || `pi exited with ${r.signal ?? r.code}`));
          throw new SessionError(failureText(turn.failure), 502);
        }
      }
      return { end: turn.end, spend: await agentSpend(runId) };
    },
  };
}

/**
 * Begin carrying out one message from the learner: pi works on the runner until it answers in
 * words, the step limit is reached, or the learner stops it. Refused at once (thrown) when it cannot
 * begin; otherwise the turn is under way and can be followed (followTurn) by its id. `outcome`
 * resolves to why it ended; `detached` when touch with the runner was lost while pi was still at
 * work (the turn goes on there and is taken up again, see resumeTurns). `emit` also gets each
 * piece as it happens, for a caller that wants them first-hand.
 */
export async function startAgentTurn(runId: string, runner: Runner, text: string, emit: (e: AgentEvent) => void = () => undefined): Promise<{ turn: string; outcome: Promise<Outcome> }> {
  const cfg = await agentConfig();
  if (!cfg) throw new SessionError('本站没有开放助手');
  if (!runner.info.agent) throw new SessionError('这次练习所在的沙箱机没有装 coding agent，请联系管理员');
  if (await agentBusy(runId)) throw new SessionError('助手还在处理上一条消息');
  if ((await agentSpend(runId)).usd >= cfg.maxUsd) throw new SessionError('这次练习的助手用量已达上限');
  const control = new AbortController();
  running.set(runId, control);
  const token = `fdegym-turn-${randomBytes(32).toString('base64url')}`;
  turns.set(token, runId);
  spentOut.delete(runId);
  try {
    await remember(runId, { kind: 'user', text });
    await db.run(`INSERT INTO agent_turns (run_id, token_hash, runner, seq, started_at) VALUES ($1, $2, $3, 0, $4)
      ON CONFLICT (run_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, runner = EXCLUDED.runner, seq = 0, started_at = EXCLUDED.started_at`,
    [runId, sha256(token), runner.name, Date.now()]);
  } catch (e) {
    running.delete(runId);
    turns.delete(token);
    throw e;
  }
  // Opened once the learner's message is in the record: a page that reads the conversation while the turn is under way leaves out what the turn tells.
  const live = openLive(runId, text);
  const out = (e: AgentEvent) => { tell(live, e); emit(e); };
  const outcome = (async (): Promise<Outcome> => {
    try {
      const read = reader(runId, cfg.maxSteps, runner, control, out);
      let r: Awaited<ReturnType<Runner['agentTurn']>>;
      try {
        r = await runner.agentTurn(runId, { message: text, model: cfg.model, url: SELF, token, system: SYSTEM, contextWindow: await contextWindow(cfg), thinking: cfg.thinking }, read.onLine);
      } catch (e) {
        await read.settle();
        if (e instanceof RunnerOffline && !control.signal.aborted) return { end: 'detached', spend: await agentSpend(runId) };
        await closeTurn(runId);
        throw e;
      }
      return await read.end(r);
    } finally {
      running.delete(runId);
    }
  })();
  outcome.then((o) => closeLive(runId, live, { event: 'done', data: o }), (e) => closeLive(runId, live, { event: 'error', data: { error: e instanceof Error ? e.message : String(e) } }));
  return { turn: live.id, outcome };
}

/** One message from the learner, carried out to its end (see startAgentTurn). */
export async function agentTurn(runId: string, runner: Runner, text: string, emit: (e: AgentEvent) => void): Promise<Outcome> {
  return (await startAgentTurn(runId, runner, text, emit)).outcome;
}

/**
 * A runner is in touch (again): take up the turns that were under way on it when touch was lost,
 * because the site restarted or the line dropped. The runner tells each from the start, and pages
 * watching hear it afresh, as a new turn; what was kept before is not kept twice. A turn the runner
 * no longer has (it restarted too) is closed.
 */
export async function resumeTurns(runner: Runner): Promise<void> {
  const cfg = await agentConfig();
  for (const row of await db.query<{ run_id: string; seq: number }>('SELECT run_id, seq FROM agent_turns WHERE runner = $1', [runner.name])) {
    if (running.has(row.run_id)) continue;
    const control = new AbortController();
    running.set(row.run_id, control);
    const asked = await db.one<{ message: Stored }>("SELECT message FROM agent_messages WHERE run_id = $1 AND (message->'item'->>'kind' = 'user' OR message->>'role' = 'user') ORDER BY id DESC LIMIT 1", [row.run_id]);
    const live = openLive(row.run_id, asked ? ('v' in asked.message ? (asked.message.item as { text?: string }).text ?? '' : String((asked.message as { content?: unknown }).content ?? '')) : '');
    const read = reader(row.run_id, cfg?.maxSteps ?? 40, runner, control, (e) => tell(live, e), row.seq);
    void runner.agentAttach(row.run_id, read.onLine)
      .then(async (r) => { closeLive(row.run_id, live, { event: 'done', data: await read.end(r) }); }, async (e) => {
        await read.settle();
        // Out of touch again: it stays on record for the next time. Anything else: the runner does not have it.
        if (!(e instanceof RunnerOffline)) await closeTurn(row.run_id);
        closeLive(row.run_id, live, { event: 'done', data: { end: 'detached', spend: await agentSpend(row.run_id) } });
      })
      .catch((e) => closeLive(row.run_id, live, { event: 'error', data: { error: e instanceof Error ? e.message : String(e) } }))
      .finally(() => { if (running.get(row.run_id) === control) running.delete(row.run_id); });
  }
}

/** The site itself ran these turns and has restarted: pi went down with it. */
export const forgetLocalTurns = () => db.run("DELETE FROM agent_turns WHERE runner = 'local'");

// ---- where pi's model calls come to

const refuse = (status: number, message: string) => new Response(JSON.stringify({ error: { message, code: status } }), { status, headers: { 'content-type': 'application/json' } });
type Usage = { prompt_tokens?: number; completion_tokens?: number; cost?: number };
/** A model call's cost, on the bill; the pages watching the turn are told the new figure. */
const count = (runId: string, u: Usage | undefined) =>
  (u ? charge(runId, Math.round(u.prompt_tokens ?? 0), Math.round(u.completion_tokens ?? 0), Number(u.cost) || 0)
    .then(async () => { if (liveTurn(runId)) tellRun(runId, { event: 'spend', data: await agentSpend(runId) }); })
    .catch((e) => console.error(e)) : Promise.resolve());

export function agentRoutes(app: Hono) {
  app.post('/api/agent/v1/chat/completions', async (c) => {
    const token = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1];
    // A turn that began before the site last started is known from its record.
    const runId = token ? turns.get(token) ?? (await db.one<{ run_id: string }>('SELECT run_id FROM agent_turns WHERE token_hash = $1', [sha256(token)]))?.run_id : undefined;
    if (!runId || !token) return refuse(401, 'no turn is under way for this token');
    turns.set(token, runId);
    const cfg = await agentConfig();
    if (!cfg) return refuse(503, 'the agent is not offered on this site');
    if ((await agentSpend(runId)).usd >= cfg.maxUsd) { spentOut.add(runId); return refuse(402, 'this run has used up its allowance for the agent'); }
    const body = await c.req.json().catch(() => undefined) as { messages?: unknown; stream?: unknown; stream_options?: object } | undefined;
    if (!body || !Array.isArray(body.messages)) return refuse(400, 'not a chat-completions request');

    // The model is the site's choice, whatever was asked for; and the reply has to say what it cost.
    const sent = {
      ...body, model: cfg.model,
      ...(body.stream ? { stream_options: { ...body.stream_options, include_usage: true } } : {}),
      ...(cfg.baseUrl.includes('openrouter.ai') ? { usage: { include: true } } : {}),
    };
    let res: Awaited<ReturnType<typeof proxiedFetch>>;
    try {
      res = await proxiedFetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST', body: JSON.stringify(sent),
        headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json', 'x-title': 'fdegym' },
        // Given up with the turn: pi closes the call when it is stopped.
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(600_000)]),
        ...(cfg.proxy ? { dispatcher: new ProxyAgent(cfg.proxy) } : {}),
      });
    } catch (e) {
      if (!c.req.raw.signal.aborted) console.error('agent relay:', (e as Error).message);
      return refuse(502, 'the model provider could not be reached');
    }
    const type = res.headers.get('content-type') ?? 'application/json';
    if (!res.body || !type.includes('text/event-stream')) {
      const text = await res.text();
      if (res.ok) { try { await count(runId, (JSON.parse(text) as { usage?: Usage }).usage); } catch { /* not JSON: passed on as it is */ } }
      return new Response(text, { status: res.status, headers: { 'content-type': type } });
    }
    // A stream is passed on as it comes; the chunk that carries the usage is read on the way.
    let usage: Usage | undefined;
    let buf = '';
    const decoder = new TextDecoder();
    const watch = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        out.enqueue(chunk);
        buf += decoder.decode(chunk, { stream: true });
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:') || !line.includes('"usage"')) continue;
          try { usage = (JSON.parse(line.slice(5)) as { usage?: Usage }).usage ?? usage; } catch { /* not ours to mend */ }
        }
      },
      flush() { void count(runId, usage); },
    });
    return new Response((res.body as unknown as ReadableStream<Uint8Array>).pipeThrough(watch), { status: res.status, headers: { 'content-type': type, 'cache-control': 'no-cache' } });
  });
}
