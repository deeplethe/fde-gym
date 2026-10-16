/**
 * The coding agent is pi (https://pi.dev, the `pi` command of @earendil-works/pi-coding-agent), run
 * on the machine that holds the workspace. One turn is one run of pi without its interface
 * (`--mode json`): it starts in the workspace as the same user a learner's commands run as (or
 * under the same sandbox), works with its own tools (read, bash, edit, write), prints what happens
 * as lines of JSON, and exits. Its session file is kept beside the workspace, so the next turn
 * carries on the same conversation, and pi compacts it when it grows.
 *
 * pi holds no model key. It is pointed at the site's relay for the agent (./agent) with a token
 * that is good for this one turn of this one run; the site adds its own key there and counts what
 * the run spends. Everything else pi could reach out for is off: no update check, no telemetry, no
 * extensions, skills, MCP servers or context files from the workspace or the machine.
 *
 * Two things stay with the learner on purpose, talking to the customer's people and starting a
 * trial day. A small extension written beside the session refuses the two commands that do them.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from './engine-paths';
import { ISOLATED, limited, runDir, runUid, SANDBOX_EXEC, SANDBOXED, sandboxProfile, workspaceDir } from './harness';
import { SessionError } from './session-error';

const PI_CLI = process.env.FDEGYM_PI_CLI || join(ROOT, 'app', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
/** Whether this machine can run the agent at all. */
export const AGENT_READY = existsSync(PI_CLI);

const TURN_TIMEOUT_MS = Number(process.env.FDEGYM_AGENT_TURN_S ?? 1800) * 1000;
const MAX_OUTPUT = 12_000;
const MAX_ARG = 20_000;
const MAX_THOUGHT = 20_000;
const MAX_PATCH = 32_000;
/** How often the page hears how far a long tool call has been written. */
const DRAFT_MS = 1000;

/** How hard the model thinks before it answers, and how the relay's provider is asked for it. */
export const THINKING_LEVELS = ['low', 'medium', 'high'] as const;
export const THINKING_FORMATS = ['openrouter', 'deepseek', 'openai'] as const;
export type Thinking = { level: (typeof THINKING_LEVELS)[number]; format: (typeof THINKING_FORMATS)[number] };

/** What the site hands over for one turn. */
export interface AgentTurn {
  message: string;
  model: string;
  /** The site's relay for the agent (an OpenAI-compatible base URL) and the token for this turn. */
  url: string;
  token: string;
  /** Added to pi's own system prompt: what this workspace is and whose work it is. */
  system: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Absent: the model is not asked to think (what it thinks of its own accord is still passed on). */
  thinking?: Thinking;
}

/**
 * What comes back while a turn runs, one JSON object per line: pi's own events, cut down to what
 * the page shows. On the way each is numbered (`n`, from 1 in a turn), so that a site which lost
 * its connection and takes the turn up again (agentAttach) can tell what it already has, and
 * stamped with the time (`at`, on this machine's clock) so that how long a step took can be said.
 */
export type AgentLine = { n?: number; at?: number } & AgentWhat;
type AgentWhat =
  | { t: 'delta'; text: string }
  | { t: 'say'; text: string; stop?: string; error?: string }
  /** A piece of what the model is thinking, as it comes. */
  | { t: 'think'; text: string }
  /** A stretch of thinking, finished: all of it, and how long it took. Empty when the provider keeps it to itself. */
  | { t: 'thought'; text: string; ms: number }
  /** A tool call has begun to be written: its name is known, its arguments not yet. */
  | { t: 'tool'; id: string; name: string; args: Record<string, unknown> }
  /** How much of a tool call's arguments has been written so far: a long file can take a minute. */
  | { t: 'drafting'; id: string; chars: number }
  /** What is known of its arguments so far (the path or command first, everything once it is complete). */
  | { t: 'args'; id: string; args: Record<string, unknown> }
  /** What a running command has printed so far. */
  | { t: 'output'; id: string; output: string }
  /** `patch`: an edit's change to the file, as a unified diff. */
  | { t: 'result'; id: string; output: string; failed: boolean; patch?: string }
  | { t: 'retry'; message: string }
  | { t: 'settled'; aborted: boolean };
/** Lines that are only for watching live, and are neither kept nor told again. */
const LIVE_ONLY = new Set<AgentWhat['t']>(['delta', 'output', 'think', 'drafting']);

const GUARD = `// Written by FDE Gym for each turn. Asking the customer's people and starting a trial day are the engineer's to do.
export default function (pi) {
  pi.on('tool_call', (event) => {
    if (event.toolName === 'bash' && /\\bbin\\/(ask|pilot)\\b/.test(String(event.input && event.input.command || ''))) {
      return { block: true, reason: "Not run: contacting the customer's people and starting a trial run are the engineer's to do. Tell them what you would ask, and whom." };
    }
  });
}
`;

const agentDir = (name: string) => join(runDir(name), 'agent');
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n * 0.6)}\n[… ${s.length - n} characters left out …]\n${s.slice(-n * 0.4)}`);
/** A diff cut short keeps to whole lines, and says how many more there were. */
const clipLines = (s: string, n: number) => {
  if (s.length <= n) return s;
  const cut = s.lastIndexOf('\n', n);
  const kept = s.slice(0, cut > 0 ? cut : n);
  return `${kept}\n... ${s.slice(kept.length).split('\n').length - 1} more lines`;
};
const textOf = (content: unknown) => (Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => String(c.text ?? '')).join('') : '');
/** The turn's thinking, if it is one this machine knows how to ask for (it comes from the site, over the line). */
const thinkingOf = (turn: AgentTurn): Thinking | undefined => {
  const th = turn.thinking;
  return th && (THINKING_LEVELS as readonly string[]).includes(th.level) && (THINKING_FORMATS as readonly string[]).includes(th.format) ? th : undefined;
};

/** The folder pi keeps its session and settings in, made ready for this turn: where the model is, and the guard. */
function prepare(name: string, turn: AgentTurn): string {
  const dir = agentDir(name);
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const th = thinkingOf(turn);
  writeFileSync(join(dir, 'models.json'), JSON.stringify({
    providers: {
      fdegym: {
        baseUrl: turn.url, api: 'openai-completions', apiKey: turn.token,
        // The relay speaks plain chat completions, whatever is behind it; how thinking is asked for is the provider's way, which the site knows.
        compat: {
          supportsDeveloperRole: false, supportsReasoningEffort: th?.format === 'openai', supportsStore: false, maxTokensField: 'max_tokens',
          ...(th ? { thinkingFormat: th.format } : {}),
          // DeepSeek refuses a conversation whose earlier replies come back without their reasoning_content.
          ...(th?.format === 'deepseek' ? { requiresReasoningContentOnAssistantMessages: true } : {}),
        },
        // Thinking counts against the reply's tokens, so a thinking model is given more room to answer in.
        models: [{ id: turn.model, reasoning: !!th, contextWindow: turn.contextWindow ?? 128_000, maxTokens: turn.maxTokens ?? (th ? 16_000 : 8000) }],
      },
    },
  }), { mode: 0o600 });
  writeFileSync(join(dir, 'guard.js'), GUARD, { mode: 0o600 });
  const uid = runUid(name);
  // pi runs as the run's own user and writes its session here; the rest of the run folder stays closed to it.
  if (uid !== undefined) for (const p of [dir, join(dir, 'sessions'), join(dir, 'models.json'), join(dir, 'guard.js')]) chownSync(p, uid, uid);
  return dir;
}

const running = new Map<string, ChildProcess>();
export const agentRunning = (name: string) => running.has(name);

export type TurnEnd = { code: number | null; signal: string | null; stderr: string };
/**
 * What a run's latest turn has said, kept so that it can be told again. A turn belongs to this
 * machine, not to the connection that asked for it: if the site restarts or its line drops, pi
 * goes on working, and the site reads the turn from the start when it is back. Pieces of text and
 * of a command's output are only for watching live and are not kept.
 */
interface Log { kept: string[]; bytes: number; n: number; to: (line: string) => void; done?: TurnEnd; end: Promise<TurnEnd> }
const logs = new Map<string, Log>();
const LOG_BYTES = 8_000_000;
const LOG_KEPT_MS = 3_600_000;

/** Take up a turn again: everything it has said so far, then the rest as it happens; resolves when pi has exited (at once if it already has). */
export function agentAttach(name: string, onLine: (line: string) => void): Promise<TurnEnd> {
  const log = logs.get(name);
  if (!log) throw new SessionError('这一轮已经不在了', 410);
  for (const line of log.kept) onLine(line);
  log.to = onLine;
  return log.end;
}

/** One message from the learner, carried out by pi. `onLine` gets what happens, as it happens; resolves when pi has exited. */
export function agentTurn(name: string, turn: AgentTurn, onLine: (line: string) => void): Promise<TurnEnd> {
  if (!AGENT_READY) throw new SessionError('这台沙箱机没有装 coding agent');
  if (running.has(name)) throw new SessionError('助手还在处理上一条消息');
  const ws = workspaceDir(name);
  if (!existsSync(ws)) throw new SessionError('这次练习的工作区已经不在了', 410);
  const uid = runUid(name);
  if (ISOLATED && uid === undefined) throw new SessionError('本站没有开放助手');
  const dir = prepare(name, turn);
  const sessions = join(dir, 'sessions');
  const profile = SANDBOXED
    ? sandboxProfile(name, { write: [dir], read: [dirname(dirname(real(PI_CLI))), join(ROOT, 'app', 'node_modules'), dirname(dirname(real(process.execPath)))] })
    : undefined;
  if (SANDBOXED && !profile) throw new SessionError('本站没有开放助手');

  const args = [
    PI_CLI, '--mode', 'json', '--print', '--offline', '--no-approve',
    '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '-e', join(dir, 'guard.js'), '--tools', 'read,bash,edit,write',
    '--session-dir', sessions, ...(readdirSync(sessions).some((f) => f.endsWith('.jsonl')) ? ['--continue'] : []),
    '--provider', 'fdegym', '--model', turn.model, '--thinking', thinkingOf(turn)?.level ?? 'off', '--append-system-prompt', turn.system,
    // A message that begins with @ would be taken for a file to attach.
    '--', turn.message.startsWith('@') ? ` ${turn.message}` : turn.message,
  ];
  const child = spawn(...limited(profile ? SANDBOX_EXEC : process.execPath, [...(profile ? ['-p', profile, process.execPath] : []), ...args]), {
    cwd: ws, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...(uid === undefined ? {} : { uid, gid: uid }),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: ws, TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'en_US.UTF-8', TERM: 'dumb', NO_COLOR: '1',
      PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1',
      PI_CODING_AGENT_DIR: dir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    },
  });
  running.set(name, child);

  let ended!: (r: TurnEnd) => void;
  const log: Log = { kept: [], bytes: 0, n: 0, to: onLine, end: new Promise((ok) => { ended = ok; }) };
  logs.set(name, log);
  const send = (l: AgentWhat) => {
    const line = JSON.stringify({ ...l, n: ++log.n, at: Date.now() });
    if (!LIVE_ONLY.has(l.t) && log.bytes < LOG_BYTES) { log.kept.push(line); log.bytes += line.length; }
    log.to(line);
  };
  // pi is told the workspace's full path and likes to use it; the page shows paths from the workspace's root, as the file tree does.
  const roots = [...new Set([real(ws), ws])];
  const tidy = (s: string) => roots.reduce((t, root) => t.split(`cd ${root} && `).join('').split(`${root}/`).join('').split(root).join('.'), s);
  const tidied = (v: unknown): unknown => (typeof v === 'string' ? tidy(clip(v, MAX_ARG)) : Array.isArray(v) ? v.map(tidied) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tidied(x)])) : v);
  const clipped = (a: unknown) => tidied(a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
  // What it has said in the reply being written, not yet passed on as a finished piece.
  let said = '', passed = '';
  // Tool calls being written, by their place in the reply: the arguments arrive as pieces of JSON.
  const writing = new Map<number, { id: string; json: string; named: boolean; chars: number; told: number }>();
  const begun = new Set<string>();
  const begin = (id: string, name: string) => { if (!begun.has(id)) { begun.add(id); send({ t: 'tool', id, name, args: {} }); } };
  // Stretches of thinking under way, by their place in the reply: when each began, and what has come of it.
  const thinking = new Map<number, { since: number; text: string }>();
  const thought = (index: number, text?: string) => {
    const th = thinking.get(index);
    if (!th) return;
    thinking.delete(index);
    send({ t: 'thought', text: clip(text || th.text, MAX_THOUGHT), ms: Date.now() - th.since });
  };
  // Thinking is over once the model goes on to say something or to reach for a tool, whenever pi says so.
  const thoughtOut = () => { for (const index of [...thinking.keys()]) thought(index); };
  let lastOutput = 0;
  const take = (raw: string) => {
    let e: Record<string, any>;
    try { e = JSON.parse(raw); } catch { return; }
    const u = e.type === 'message_update' ? e.assistantMessageEvent : undefined;
    if (u?.type === 'text_delta') { thoughtOut(); said += String(u.delta ?? ''); send({ t: 'delta', text: String(u.delta ?? '') }); }
    else if (u?.type === 'thinking_start') thinking.set(Number(u.contentIndex), { since: Date.now(), text: '' });
    else if (u?.type === 'thinking_delta') {
      const index = Number(u.contentIndex);
      if (!thinking.has(index)) thinking.set(index, { since: Date.now(), text: '' });
      thinking.get(index)!.text += String(u.delta ?? '');
      send({ t: 'think', text: String(u.delta ?? '') });
    } else if (u?.type === 'thinking_end') thought(Number(u.contentIndex), String(u.content ?? ''));
    else if (u?.type === 'toolcall_start' && u.id && u.toolName) {
      thoughtOut();
      // What it said before reaching for a tool comes before the tool, on the page as in the reply.
      if (said.trim()) { send({ t: 'say', text: said }); passed += said; }
      said = '';
      writing.set(Number(u.contentIndex), { id: String(u.id), json: '', named: false, chars: 0, told: Date.now() });
      begin(String(u.id), String(u.toolName));
    } else if (u?.type === 'toolcall_delta') {
      const w = writing.get(Number(u.contentIndex));
      if (!w) return;
      const piece = String(u.delta ?? '');
      w.chars += piece.length;
      if (Date.now() - w.told >= DRAFT_MS) { w.told = Date.now(); send({ t: 'drafting', id: w.id, chars: w.chars }); }
      if (w.named) return;
      w.json += piece;
      // Which file, or which command, as soon as that much has been written; a long file body can take a minute more.
      const m = /"(path|command)"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(w.json);
      if (m) { w.named = true; w.json = ''; try { send({ t: 'args', id: w.id, args: clipped({ [m[1]]: String(JSON.parse(m[2])) }) }); } catch { /* wait for the whole of it */ } }
    } else if (e.type === 'message_end' && e.message?.role === 'assistant') {
      writing.clear();
      // Thinking the provider never said was over (the reply was cut off, or it does not say) ends with the reply.
      const content: unknown[] = Array.isArray(e.message.content) ? e.message.content : [];
      for (const index of [...thinking.keys()]) {
        const block = content[index] as { type?: string; thinking?: string } | undefined;
        thought(index, block?.type === 'thinking' ? String(block.thinking ?? '') : undefined);
      }
      const whole = textOf(e.message.content);
      send({ t: 'say', text: whole.startsWith(passed) ? whole.slice(passed.length) : passed ? '' : whole, stop: e.message.stopReason, error: e.message.errorMessage });
      said = ''; passed = '';
    } else if (e.type === 'tool_execution_start') {
      begin(String(e.toolCallId), String(e.toolName));
      send({ t: 'args', id: String(e.toolCallId), args: clipped(e.args) });
    } else if (e.type === 'tool_execution_update') {
      const now = Date.now();
      if (now - lastOutput < 300) return;
      lastOutput = now;
      const text = textOf(e.partialResult?.content);
      if (text) send({ t: 'output', id: String(e.toolCallId), output: tidy(text.slice(-4000)) });
    } else if (e.type === 'tool_execution_end') {
      const patch = typeof e.result?.details?.patch === 'string' && e.result.details.patch ? tidy(clipLines(e.result.details.patch, MAX_PATCH)) : undefined;
      send({ t: 'result', id: String(e.toolCallId), output: tidy(clip(textOf(e.result?.content), MAX_OUTPUT)), failed: !!e.isError, ...(patch ? { patch } : {}) });
    }
    else if (e.type === 'auto_retry_start') send({ t: 'retry', message: String(e.errorMessage ?? '') });
    else if (e.type === 'agent_settled') send({ t: 'settled', aborted: !!e.aborted });
  };
  // Records are separated by a line feed and nothing else (a JSON string may hold other separators).
  let buf = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) take(line); }
  });
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', (d: string) => { stderr = (stderr + d).slice(-2000); });

  const timer = setTimeout(() => agentStop(name), TURN_TIMEOUT_MS);
  const end = (code: number | null, signal: string | null) => {
    if (log.done) return;
    clearTimeout(timer);
    running.delete(name);
    log.done = { code, signal, stderr };
    ended(log.done);
    // Kept a while for a site that was away when it ended; the run's next turn replaces it sooner.
    setTimeout(() => { if (logs.get(name) === log) logs.delete(name); }, LOG_KEPT_MS).unref();
  };
  child.once('error', (e) => { stderr += String(e); end(127, null); });
  child.once('close', end);
  return log.end;
}

/** Stop the turn and everything it started: asked first, then made to. */
export function agentStop(name: string): boolean {
  const child = running.get(name);
  if (!child?.pid) return false;
  const pid = child.pid;
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { if (running.get(name) === child) try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }, 1500).unref();
  return true;
}
