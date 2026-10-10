/**
 * A learner's run, driven through the same harness as the AI agents (harness/run.py), so a person's
 * result means the same thing as an agent's on the same case. The harness runs on the run's runner
 * (./runner-api): this machine, or another that has connected to the site.
 *
 * Rules for people, versus agents:
 *   - the same workspace, brief, stakeholders (with the same hidden cost of asking), trial
 *     environment, LLM gateway allowance and grading replay;
 *   - no time or step limit; a run can span several sittings;
 *   - one submission: "Submit" freezes the workspace and grades it;
 *   - a person works through a coding agent (./agent) that they direct, as people deliver now; talking
 *     to the customer's people and starting a trial day stay with the person.
 *
 * What the stakeholders said is kept here (the harness logs the questions, not the answers), so the
 * page can show each conversation again.
 */
import { randomBytes } from 'node:crypto';
import { agentBusy, agentSpend, agentTranscript, agentTurn, agentTurnLog, stopAgent, type AgentEvent } from './agent';
import { agentAvailable, agentConfig, contextWindow } from './agent-settings';
import { BRIEF, catalog, type Catalog, type CaseRecord } from './catalog';
import { db, json, text } from './db';
import { newRelayToken } from './llm-relay';
import type { Runner } from './runner-api';
import { pickRunner, RunnerOffline, runnerNamed } from './runners';
import { SessionError } from './session-error';

export { SessionError } from './session-error';

/** `abandoned`: the learner ended the run without submitting; it is never graded and counts for nothing. */
export type Status = 'running' | 'grading' | 'graded' | 'failed' | 'abandoned';

interface Row {
  id: string; case_id: string; learner_id: string; learner_name: string;
  started_at: number; finished_at: number | null; status: Status; error: string | null;
  uplift: number | null; uplift_net: number | null; result: Record<string, unknown> | null;
  /** Variant key; null is the original (`base`). Never sent to a learner: they see a version number. */
  variant: string | null;
  /** The version of the case the run was started on. */
  bundle_sha: string;
  /** The machine the run is on. */
  runner: string;
  /** The run is over and its files have been cleared from that machine. */
  workspace_gone?: boolean;
}

/** The run's runner if it is connected, for things that are best effort. */
const online = (name: string): Runner | undefined => { try { return runnerNamed(name); } catch { return undefined; } };

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const KEPT_OUTPUT = 60_000;

/**
 * A run that is not handed over holds its place on a runner (its workspace, and the customer's
 * people, who are a process there) for as long as it stays open. Two things keep that from filling
 * the runners: one learner may have only so many runs open at once (FDEGYM_MAX_OPEN_RUNS, default 3;
 * 0 for no limit), and a run nobody has touched for long enough is ended as if its owner had ended
 * it (FDEGYM_RUN_IDLE_DAYS, default 14; 0 for never). There is still no time limit on working a case:
 * the days are counted from the last time the run was opened or used.
 */
const MAX_OPEN = Number(process.env.FDEGYM_MAX_OPEN_RUNS ?? 3);
const IDLE_DAYS = Number(process.env.FDEGYM_RUN_IDLE_DAYS ?? 14);
/** A run that is over keeps its files on its runner this long, to be looked at; its result is kept for good. 0 for always. */
const KEEP_DAYS = Number(process.env.FDEGYM_KEEP_WORKSPACE_DAYS ?? 30);

/** Start a run on a case the caller has already checked is on offer, on the version the library holds now. */
export async function startSession(opts: { record: CaseRecord; learnerId: string; name: string; variant?: string }): Promise<string> {
  if (MAX_OPEN > 0) {
    const open = (await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE learner_id = $1 AND status = 'running'", [opts.learnerId]))?.n ?? 0;
    if (open >= MAX_OPEN) throw new SessionError(`你已经有 ${open} 次练习还没交付。先交付或终止其中一次，再开始新的`, 409);
  }
  const caseId = opts.record.card.id;
  const id = `${caseId}-${stamp()}-${randomBytes(3).toString('hex')}`;
  const variant = opts.variant && opts.variant !== 'base' ? opts.variant : null;
  const runner = await pickRunner();
  // A run on another machine reaches the model through the site, with a token of its own. The run is
  // on record before its workspace is built, so the token is known by the time it is first used.
  const relay = runner.name === 'local' ? undefined : newRelayToken();
  await db.run('INSERT INTO runs (id, case_id, learner_id, learner_name, started_at, status, variant, bundle_sha, runner, relay_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [id, caseId, opts.learnerId, opts.name.trim().slice(0, 40) || 'learner', Date.now(), 'running', variant, opts.record.bundleSha, runner.name, relay?.hash ?? null]);
  try {
    await runner.createRun({ caseId, sha: opts.record.bundleSha, level: BRIEF, name: id, variant: variant ?? undefined, relay: relay && { token: relay.token, url: '' } });
  } catch (e) {
    await db.run('DELETE FROM runs WHERE id = $1', [id]);
    throw e;
  }
  return id;
}

/** The versions of a scenario this learner has already started, as version numbers. */
export async function versionsDone(cat: Catalog, owners: string[], caseId: string): Promise<number[]> {
  if (!owners.length) return [];
  const rows = await db.query<{ variant: string | null }>("SELECT DISTINCT variant FROM runs WHERE case_id = $1 AND status <> 'abandoned' AND learner_id = ANY($2)", [caseId, owners]);
  return [...new Set(rows.map((r) => cat.versionOf(caseId, r.variant)))].sort((a, b) => a - b);
}

/**
 * Which variant a new run gets. A number picks that version; anything else is "random", which
 * prefers a version the learner has not done yet.
 */
export async function pickVariant(cat: Catalog, caseId: string, version: unknown, owners: string[]): Promise<string> {
  const keys = cat.variantKeys(caseId);
  if (typeof version === 'number' && Number.isInteger(version) && version >= 1 && version <= keys.length) return keys[version - 1];
  const done = new Set(await versionsDone(cat, owners, caseId));
  const fresh = keys.filter((_k, i) => !done.has(i + 1));
  const pool = fresh.length ? fresh : keys;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Load a learner's run; only its owner may act on it. `owners`: the ids the requester owns runs under (see Identity in ./auth). */
export async function openSession(runId: string, owners: string[]): Promise<Session> {
  const row = await db.one<Row>('SELECT * FROM runs WHERE id = $1', [runId]);
  if (!row) throw new SessionError('没有这次练习', 404);
  if (!owners.includes(row.learner_id)) throw new SessionError('这不是你的练习', 403);
  touch(row);
  return new Session(row);
}

/** Note that the run's owner is here; written at most once a minute for a run. */
const touched = new Map<string, number>();
function touch(row: Row) {
  const now = Date.now();
  if (row.status !== 'running' || now - (touched.get(row.id) ?? 0) < 60_000) return;
  touched.set(row.id, now);
  void db.run('UPDATE runs SET last_active = $2 WHERE id = $1', [row.id, now]).catch(() => undefined);
}

/**
 * Clear from their runners the files of runs that have been over for longer than they are kept;
 * called now and then by the server. A runner that is not connected is asked the next time; one the
 * site no longer knows has nothing to be asked. Returns how many runs were cleared.
 */
export async function clearOldWorkspaces(): Promise<number> {
  if (!(KEEP_DAYS > 0)) return 0;
  const rows = await db.query<{ id: string; runner: string }>(
    "SELECT id, runner FROM runs WHERE status IN ('graded', 'abandoned') AND NOT workspace_gone AND COALESCE(finished_at, started_at) < $1 ORDER BY finished_at LIMIT 200",
    [Date.now() - KEEP_DAYS * 86_400_000]);
  if (!rows.length) return 0;
  const known = new Set((await db.query<{ name: string }>('SELECT name FROM runners')).map((r) => r.name));
  let cleared = 0;
  for (const row of rows) {
    const runner = online(row.runner);
    if (runner) {
      try { await runner.deleteRun(row.id); } catch (e) { console.error(`could not clear ${row.id}:`, (e as Error).message); continue; }
    } else if (row.runner === 'local' || known.has(row.runner)) continue;
    await db.run('UPDATE runs SET workspace_gone = TRUE WHERE id = $1', [row.id]);
    cleared++;
  }
  return cleared;
}

/** End the runs that have been left alone for longer than a run may be; called now and then by the server. Returns how many. */
export async function endIdleRuns(): Promise<number> {
  if (!(IDLE_DAYS > 0)) return 0;
  const rows = await db.query<Row>("SELECT * FROM runs WHERE status = 'running' AND COALESCE(last_active, started_at) < $1", [Date.now() - IDLE_DAYS * 86_400_000]);
  for (const row of rows) {
    touched.delete(row.id);
    await new Session(row).abandon().catch((e) => console.error(`could not end idle run ${row.id}:`, (e as Error).message));
  }
  return rows.length;
}

/** `inbox`: a message the customer's people sent unprompted; `who` is its sender as written, `question` its id. */
export interface Message { id: number; kind: 'ask' | 'wait' | 'pilot' | 'inbox'; who?: string; question?: string; answer: string; at?: string; ts: number }
export interface Command { id: number; cwd: string; command: string; output: string; code: number | null; ts: number }

/** What the learner sees of the harness's result: the scores, never the held-out traffic or the facts list. */
export interface ResultView {
  uplift: number; upliftNet: number; contactCost: number;
  kpiName: string; kpi: number; kpiBaseline: number; kpiOracle: number;
  incidents: string[]; summary: string;
  questionsAsked: number; askedByPerson: Record<string, number>; offLimits: string[];
  /** How much of what decides this case the learner found out by asking, 0 to 1; null where a case has no such list. Never which facts. */
  keyFactCoverage: number | null;
}

/**
 * One thing that happened in a run, for looking back over it in order: what was asked of whom and
 * what came back, what the coding agent was told and how much it did, the commands run by hand, and
 * how the run ended. All of it is the learner's own doing, so none of it gives a case away.
 */
export type TimelineEvent = { ts: number } & (
  | { kind: 'start' }
  | { kind: 'ask'; who: string; question: string; answer: string }
  | { kind: 'wait' | 'pilot' | 'inbox'; who?: string; text: string }
  | { kind: 'agent'; text: string; steps: number; failed: number; said: string }
  | { kind: 'command'; command: string; code: number | null }
  | { kind: 'end'; status: Status; score?: number }
);

function resultView(raw: Record<string, unknown> | null): ResultView | undefined {
  if (!raw) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = raw as any;
  const d = r.discovery ?? {};
  return {
    uplift: r.uplift ?? 0, upliftNet: r.uplift_net ?? r.uplift ?? 0, contactCost: d.contact_cost ?? 0,
    kpiName: String(r.kpi_name ?? ''), kpi: r.kpi, kpiBaseline: r.kpi_baseline, kpiOracle: r.kpi_oracle,
    incidents: ((r.incidents ?? []) as unknown[]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))),
    summary: String(r.summary ?? ''),
    questionsAsked: d.questions_asked ?? 0, askedByPerson: d.asked_by_person ?? {}, offLimits: d.off_limits_contacts ?? [],
    keyFactCoverage: typeof d.key_fact_coverage === 'number' ? d.key_fact_coverage : null,
  };
}

export class Session {
  constructor(private row: Row) {}

  get runId() { return this.row.id; }
  get finished() { return this.row.status !== 'running'; }
  /** The machine this run is on; fails when it is not connected. */
  private get runner(): Runner { return runnerNamed(this.row.runner); }

  private requireOpen() {
    if (this.finished) throw new SessionError(this.row.status === 'abandoned' ? '这次练习已经结束' : '这次练习已经提交');
  }

  private async set(change: Partial<Row>) {
    const keys = Object.keys(change) as (keyof Row)[];
    const values = keys.map((k) => (k === 'result' && change.result ? json(change.result) : change[k]));
    await db.run(`UPDATE runs SET ${keys.map((k, i) => `${k} = $${i + 1}${k === 'result' ? '::jsonb' : ''}`).join(', ')} WHERE id = $${keys.length + 1}`, [...values, this.runId]);
    Object.assign(this.row, change);
  }

  // ---- views

  async view() {
    const cat = await catalog();
    const card = cat.card(this.row.case_id);
    // The customer's calendar, where the engagement keeps one. Starting the run's services can fail
    // (a port taken after a reboot); the page still opens and the first question reports it.
    // The directory as it stands now: the customer's calendar, who has left, and unread messages
    // from their people. Looking does not read the inbox.
    let at: string | undefined, inboxNew = 0;
    const gone = new Map<string, string>();
    if (!this.finished) {
      const who = await Promise.resolve().then(() => this.runner.npc<{ at?: string | null; inbox_new?: number; stakeholders: { id: string; gone?: string | null }[] }>(this.runId, '/who')).catch(() => undefined);
      at = who?.at ?? undefined;
      inboxNew = who?.inbox_new ?? 0;
      for (const p of who?.stakeholders ?? []) if (p.gone) gone.set(p.id, p.gone);
    }
    const place = await this.workspace();
    const asked = Object.fromEntries((await db.query<{ who: string; n: number }>("SELECT who, COUNT(*) AS n FROM messages WHERE run_id = $1 AND kind = 'ask' GROUP BY who", [this.runId])).map((r) => [r.who, r.n]));
    const agent = await agentConfig();
    return {
      runId: this.runId, caseId: this.row.case_id, title: card?.title ?? this.row.case_id,
      // Which version this run is on, as a number; what it changed is told only once the run is graded.
      version: cat.versionOf(this.row.case_id, this.row.variant), versions: cat.variantKeys(this.row.case_id).length,
      ...(this.row.status === 'graded' ? { versionChange: cat.variantAngle(this.row.case_id, this.row.variant) ?? null } : {}),
      startedAt: this.row.started_at, finishedAt: this.row.finished_at, status: this.row.status, finished: this.finished,
      gradingError: this.row.error ?? undefined,
      task: place.task,
      people: (card?.people ?? []).map((p) => ({ ...p, asked: asked[p.id] ?? 0, ...(gone.has(p.id) ? { gone: gone.get(p.id) } : {}) })),
      inboxNew,
      features: card?.features ?? { pilot: false, clock: false, llm: false, services: [] },
      at, terminal: place.terminal, commandRunning: place.commandRunning,
      agent: { available: (await agentAvailable()) && place.terminal && !!online(this.row.runner)?.info.agent, busy: await agentBusy(this.runId), spend: await agentSpend(this.runId), maxUsd: agent?.maxUsd ?? null, model: agent?.model ?? null, contextWindow: agent ? await contextWindow(agent, false) : 0 },
      files: place.files,
      result: this.row.status === 'graded' ? resultView(this.row.result) : undefined,
    };
  }

  /** What the learner (and their agent) changed in the workspace since it was built; `known: false` for a run that cannot tell. */
  async changes() {
    if (this.row.workspace_gone) return { known: false as const, changes: [] };
    const list = await this.runner.changes(this.runId);
    return list ? { known: true as const, changes: list } : { known: false as const, changes: [] };
  }
  async diff(path: string) { return this.runner.diff(this.runId, path); }
  /** Make a copy of a file or folder beside it, named as a desktop would (in the reader's language). */
  async duplicate(path: string, lang: 'zh' | 'en') {
    this.requireOpen();
    return { path: await this.runner.duplicate(this.runId, path, lang) };
  }
  /** A SQLite file in the workspace, as its tables and a page of one table's rows. */
  async sqlite(path: string, table: string, offset: number) { return this.runner.sqlite(this.runId, path, table, offset); }
  async revert(path: string) {
    this.requireOpen();
    await this.runner.revertFile(this.runId, path);
    return { ok: true };
  }

  /** The run from start to end, in the order things happened. */
  async timeline(): Promise<TimelineEvent[]> {
    const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…`);
    const [said, turns, commands] = await Promise.all([
      this.messages(),
      agentTurnLog(this.runId),
      db.query<{ command: string; code: number | null; ts: number }>('SELECT command, code, ts FROM commands WHERE run_id = $1 ORDER BY id', [this.runId]),
    ]);
    const events: TimelineEvent[] = [{ ts: this.row.started_at, kind: 'start' }];
    for (const m of said) {
      if (m.kind === 'ask') events.push({ ts: m.ts, kind: 'ask', who: m.who ?? '', question: m.question ?? '', answer: m.answer });
      else events.push({ ts: m.ts, kind: m.kind, who: m.who ?? undefined, text: m.answer });
    }
    for (const t of turns) events.push({ ts: t.ts, kind: 'agent', text: clip(t.text, 2000), steps: t.steps, failed: t.failed, said: clip(t.said, 1200) });
    for (const c of commands) events.push({ ts: c.ts, kind: 'command', command: clip(c.command, 600), code: c.code });
    events.sort((a, b) => a.ts - b.ts);
    if (this.finished) events.push({ ts: this.row.finished_at ?? Date.now(), kind: 'end', status: this.row.status, ...(this.row.status === 'graded' ? { score: this.row.uplift_net ?? this.row.uplift ?? 0 } : {}) });
    return events;
  }

  async messages(): Promise<Message[]> {
    return (await db.query('SELECT id, kind, who, question, answer, clock AS at, ts FROM messages WHERE run_id = $1 ORDER BY id', [this.runId]))
      .map((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== null)) as unknown as Message);
  }

  async commands(): Promise<Command[]> {
    return (await db.query<Command>('SELECT id, cwd, command, output, code, ts FROM commands WHERE run_id = $1 ORDER BY id DESC LIMIT 40', [this.runId])).reverse();
  }

  private async log(kind: Message['kind'], answer: string, at?: string | null, who?: string, question?: string): Promise<Message> {
    const ts = Date.now();
    const row = await db.one<{ id: number }>('INSERT INTO messages (run_id, kind, who, question, answer, clock, ts) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [this.runId, kind, who ?? null, question ? text(question) : null, text(answer), at ?? null, ts]);
    return { id: row!.id, kind, answer, ts, ...(who ? { who } : {}), ...(question ? { question } : {}), ...(at ? { at } : {}) };
  }

  /**
   * What the page needs of the workspace itself. A run that is over can still be looked at when its
   * machine is not connected: its result is on record here, only the files are out of reach.
   */
  private async workspace() {
    if (this.row.workspace_gone) return { task: `> 这次练习的文件已经清理（交付或终止后保留 ${KEEP_DAYS} 天）。成绩和记录仍然在。`, files: [], commandRunning: false, terminal: false };
    try {
      const runner = this.runner;
      const [task, files, commandRunning] = await Promise.all([runner.task(this.runId), runner.listFiles(this.runId), runner.execRunning(this.runId)]);
      return { task, files, commandRunning, terminal: runner.info.execMode !== 'off' };
    } catch (e) {
      if (!(e instanceof RunnerOffline) || !this.finished) throw e;
      return { task: `> ${e.message}`, files: [], commandRunning: false, terminal: false };
    }
  }

  // ---- files

  readFile(path: string) { return this.runner.readFile(this.runId, path); }
  async writeFile(path: string, content: string) { this.requireOpen(); await this.runner.writeFile(this.runId, path, content); return { ok: true }; }
  async deletePath(path: string) { this.requireOpen(); await this.runner.deletePath(this.runId, path); return { ok: true }; }

  // ---- people and the customer's site

  async ask(to: string, question: string): Promise<Message> {
    this.requireOpen();
    question = question.trim();
    if (!question) throw new SessionError('消息不能为空');
    if (question.length > 6000) throw new SessionError('消息太长');
    const r = await this.runner.npc<{ from: string; answer: string; at?: string | null }>(this.runId, '/ask', { to, question });
    return this.log('ask', r.answer, r.at, to, question);
  }

  /**
   * Open the inbox: what the customer's people have sent unprompted. Reading is free, and it is what
   * marks a message as read at the customer, so it happens only when the learner opens it. Messages
   * are kept here too, so they can still be shown after the run is submitted.
   */
  async readInbox(): Promise<Message[]> {
    this.requireOpen();
    const r = await this.runner.npc<{ at?: string | null; messages: { id: string; from: string; text: string }[] }>(this.runId, '/inbox');
    const have = new Set((await db.query<{ question: string }>("SELECT question FROM messages WHERE run_id = $1 AND kind = 'inbox'", [this.runId])).map((x) => x.question));
    const fresh: Message[] = [];
    for (const m of r.messages.filter((x) => !have.has(x.id))) fresh.push(await this.log('inbox', m.text, r.at, m.from, m.id));
    return fresh;
  }

  async wait(hours: number): Promise<Message> {
    this.requireOpen();
    if (!(hours > 0)) throw new SessionError('请填写要等多久');
    const r = await this.runner.npc<{ at: string }>(this.runId, '/wait', { hours });
    return this.log('wait', `${hours}`, r.at);
  }

  /** One trial day at the customer, on whatever is in system/ now. Takes a while. */
  async pilot(): Promise<Message> {
    this.requireOpen();
    const r = await this.runner.npc<{ day: number; feedback: string }>(this.runId, '/pilot', {});
    return this.log('pilot', r.feedback, undefined, undefined, String(r.day));
  }

  // ---- terminal

  async exec(command: string, cwd: string, onData: (text: string) => void) {
    this.requireOpen();
    command = command.trim();
    if (!command) throw new SessionError('命令不能为空');
    // bin/ask and bin/pilot talk to the run's services.
    const runner = this.runner;
    await runner.ensureServing(this.runId).catch(() => undefined);
    let output = '';
    const r = await runner.exec(this.runId, command, cwd, (chunk) => { if (output.length < KEPT_OUTPUT) output += chunk; onData(chunk); });
    await db.run('INSERT INTO commands (run_id, cwd, command, output, code, ts) VALUES ($1, $2, $3, $4, $5, $6)',
      [this.runId, text(cwd), text(command), text(output.slice(0, KEPT_OUTPUT)), r.code, Date.now()]);
    return r;
  }

  async stopCommand() { return { stopped: await this.runner.killExec(this.runId) }; }

  // ---- the coding agent

  /** What has been said so far, and whether a turn is under way (a page that did not start it follows it by asking). */
  async agentState() { return { items: await agentTranscript(this.runId), busy: await agentBusy(this.runId) }; }

  async agentTurn(text: string, emit: (e: AgentEvent) => void) {
    this.requireOpen();
    text = text.trim();
    if (!text) throw new SessionError('消息不能为空');
    if (text.length > 20_000) throw new SessionError('消息太长');
    const runner = this.runner;
    if (runner.info.execMode === 'off') throw new SessionError('本站没有开放助手');
    // The delivered system may call the run's LLM gateway and customer services while the agent tries it out.
    await runner.ensureServing(this.runId).catch(() => undefined);
    return agentTurn(this.runId, runner, text, emit);
  }

  async stopAgent() { return { stopped: await stopAgent(this.runId, online(this.row.runner)) }; }

  // ---- submitting

  /** Freeze the workspace and grade it. */
  async submit() {
    this.requireOpen();
    const runner = this.runner;
    if (await agentBusy(this.runId)) throw new SessionError('助手还在处理上一条消息');
    if (await runner.execRunning(this.runId)) throw new SessionError('上一条命令还在运行');
    await runner.stopServing(this.runId);
    await this.set({ status: 'grading', finished_at: Date.now(), error: null });
    void this.grade();
    return { ok: true };
  }

  /**
   * End the run without submitting: stop whatever is running, shut the customer's side down and
   * freeze the workspace. Nothing is graded, and the case counts as not done.
   */
  async abandon() {
    this.requireOpen();
    // Its machine may be out of reach; the run is ended on record all the same, and that machine
    // is told the next time anything is asked of it for this run.
    const runner = online(this.row.runner);
    await stopAgent(this.runId, runner);
    await runner?.killExec(this.runId).catch(() => undefined);
    await runner?.stopServing(this.runId).catch(() => undefined);
    await this.set({ status: 'abandoned', finished_at: Date.now(), error: null });
    return { ok: true };
  }

  async retryGrading() {
    if (this.row.status !== 'failed') return;
    void this.runner; // fails here, not in the background, when the run's machine is out of reach
    await this.set({ status: 'grading', error: null });
    void this.grade();
  }

  /** Grade in the background (it takes minutes); the page polls the state. */
  private async grade() {
    try {
      const r = await this.runner.grade(this.runId);
      const uplift = Number(r.uplift ?? 0);
      await this.set({ status: 'graded', uplift, uplift_net: Number(r.uplift_net ?? uplift), result: { ...r, detail: undefined } });
    } catch (e) {
      console.error(e);
      await this.set({ status: 'failed', error: '评分没有完成，请重试' }).catch((x) => console.error(x));
    }
  }
}

// ---- lists (my runs, admin pages, standings)

const GRADING = { running: undefined, grading: 'running', graded: 'done', failed: 'failed', abandoned: undefined } as const;

const listed = (cat: Catalog) => (r: Row) => ({
  runId: r.id, caseId: r.case_id, learnerId: r.learner_id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status,
  totalScore: r.status === 'graded' ? r.uplift_net : null, uplift: r.status === 'graded' ? r.uplift : null,
  grading: GRADING[r.status] as 'running' | 'done' | 'failed' | undefined,
  version: cat.versionOf(r.case_id, r.variant), variant: r.variant ?? 'base',
});
/** Everything about a run but its result, which can be large and no list shows. */
const COLUMNS = 'id, case_id, learner_id, learner_name, started_at, finished_at, status, error, uplift, uplift_net, variant, bundle_sha, runner';

/** Every learner run with its owner id, newest first. `totalScore` is the uplift net of contact cost. */
export async function humanRuns() {
  const cat = await catalog();
  return (await db.query<Row>(`SELECT ${COLUMNS} FROM runs ORDER BY started_at DESC`)).map(listed(cat));
}

/** Runs of one learner (all the ids they own runs under), newest first. */
export async function learnerRuns(owners: string[]) {
  if (!owners.length) return [];
  const cat = await catalog();
  // The variant's key stays behind: a learner sees the version number only.
  return (await db.query<Row>(`SELECT ${COLUMNS} FROM runs WHERE learner_id = ANY($1) ORDER BY started_at DESC`, [owners]))
    .map(listed(cat)).map(({ learnerId: _l, variant: _v, ...rest }) => rest);
}
