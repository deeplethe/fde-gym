/**
 * What the site asks of a machine that runs cases (a "runner"): build a run's workspace, serve the
 * customer's people for it, let the learner read and change files and run commands there, and grade
 * what they hand over. A run stays on the runner it was started on: its workspace is on that
 * machine's disk, and what the customer's people have been asked is in a process's memory there.
 *
 * Two kinds answer to this interface. The local one is this very process driving the harness beside
 * it (./harness); a remote one is another machine that has connected to the site and is asked the
 * same things over that connection (./runners on the site, ./runner on the machine).
 */
import { hostname } from 'node:os';
import * as harness from './harness';
import * as pi from './pi';
import { SessionError } from './session-error';

/** The run's runner is not connected right now, or the connection went while it was being asked something. */
export class RunnerOffline extends SessionError {}

export interface RunnerInfo {
  /** `local` means commands can be run on it; `off` that it offers no terminal. */
  execMode: 'local' | 'off';
  /** How far commands are kept from everything outside the workspace. */
  isolation: 'user' | 'sandbox' | 'none';
  host: string;
  /** Whether the coding agent (pi) is installed on it. */
  agent?: boolean;
}

export interface NewRun { caseId: string; sha: string; level: string; name: string; variant?: string; relay?: harness.Relay }
export type ExecResult = { code: number | null; signal: string | null; truncated: boolean };
export type NpcPath = '/who' | '/now' | '/ask' | '/wait' | '/pilot' | '/inbox';

export interface Runner {
  /** `local`, or the name a remote runner connected under. Recorded on each run. */
  readonly name: string;
  readonly info: RunnerInfo;
  createRun(run: NewRun): Promise<void>;
  ensureServing(name: string): Promise<void>;
  stopServing(name: string): Promise<void>;
  npc<T>(name: string, path: NpcPath, payload?: unknown): Promise<T>;
  grade(name: string): Promise<Record<string, unknown>>;
  /** The run's brief; fails with 410 when the workspace is gone. */
  task(name: string): Promise<string>;
  listFiles(name: string): Promise<harness.FileEntry[]>;
  readFile(name: string, path: string): Promise<{ content: string; bytes: number; truncated: boolean; binary: boolean }>;
  writeFile(name: string, path: string, content: string): Promise<void>;
  deletePath(name: string, path: string): Promise<void>;
  /** A copy of a file or folder beside the original, named after it; resolves to the copy's path. */
  duplicate(name: string, path: string, lang: 'zh' | 'en'): Promise<string>;
  /** What differs in the workspace from how it was built; undefined for a run that kept no copy of that. */
  changes(name: string): Promise<harness.Change[] | undefined>;
  diff(name: string, path: string): Promise<{ diff: string; truncated: boolean; binary: boolean }>;
  /** Put one file back as it was when the workspace was built. */
  revertFile(name: string, path: string): Promise<void>;
  /** The tables of a SQLite file in the workspace, and one page of rows from one of them. */
  sqlite(name: string, path: string, table?: string, offset?: number): Promise<harness.SqliteView>;
  /** Run a shell command in the workspace; `onData` gets what it prints as it prints it. */
  exec(name: string, command: string, cwd: string, onData: (text: string) => void, timeoutMs?: number): Promise<ExecResult>;
  killExec(name: string): Promise<boolean>;
  execRunning(name: string): Promise<boolean>;
  /** One message for the coding agent, carried out in the workspace (see ./pi); `onLine` gets what happens as lines of JSON. */
  agentTurn(name: string, turn: pi.AgentTurn, onLine: (line: string) => void): Promise<pi.TurnEnd>;
  /** Take up the run's latest turn again after losing touch with it: what it has said from the start, then the rest. Fails with 410 when the runner no longer has it. */
  agentAttach(name: string, onLine: (line: string) => void): Promise<pi.TurnEnd>;
  agentStop(name: string): Promise<boolean>;
  /** Remove what this machine holds of a run that is over: its workspace and everything beside it. */
  deleteRun(name: string): Promise<void>;
}

/** What this machine is like as a place to run commands. */
export const localInfo = (): RunnerInfo => ({ execMode: harness.EXEC_MODE, isolation: harness.EXEC_ISOLATION, host: hostname(), agent: pi.AGENT_READY });

/** This process, driving the harness beside it. */
export const localRunner: Runner = {
  name: 'local',
  get info() { return localInfo(); },
  createRun: (r) => harness.createRun(r.caseId, r.sha, r.level, r.name, r.variant, r.relay),
  ensureServing: (name) => harness.ensureServing(name),
  stopServing: async (name) => harness.stopServing(name),
  npc: (name, path, payload) => harness.npc(name, path, payload),
  grade: (name) => harness.grade(name),
  task: async (name) => harness.taskOf(name),
  listFiles: async (name) => harness.listFiles(name),
  readFile: async (name, path) => harness.readFile(name, path),
  writeFile: async (name, path, content) => harness.writeFile(name, path, content),
  deletePath: async (name, path) => harness.deletePath(name, path),
  duplicate: async (name, path, lang) => harness.duplicate(name, path, lang),
  changes: (name) => harness.changes(name),
  diff: (name, path) => harness.diffOf(name, path),
  revertFile: async (name, path) => harness.revertFile(name, path),
  sqlite: (name, path, table, offset) => harness.sqliteView(name, path, table, offset),
  exec: (name, command, cwd, onData, timeoutMs) => harness.execIn(name, command, cwd, onData, timeoutMs),
  killExec: async (name) => harness.killExec(name),
  execRunning: async (name) => harness.execRunning(name),
  agentTurn: (name, turn, onLine) => pi.agentTurn(name, turn, onLine),
  agentAttach: async (name, onLine) => pi.agentAttach(name, onLine),
  agentStop: async (name) => pi.agentStop(name),
  deleteRun: async (name) => { pi.agentStop(name); harness.deleteRun(name); },
};

/** The calls a remote runner answers, by name, as they travel over its connection. */
export const RUNNER_METHODS = ['createRun', 'ensureServing', 'stopServing', 'npc', 'grade', 'task', 'listFiles', 'readFile', 'writeFile', 'deletePath', 'exec', 'killExec', 'execRunning', 'agentTurn', 'agentAttach', 'agentStop', 'deleteRun', 'changes', 'diff', 'revertFile', 'sqlite', 'duplicate'] as const;
export type RunnerMethod = (typeof RUNNER_METHODS)[number];

/**
 * The messages on a runner's connection. The runner opens it and says who it is (`hello`); from then
 * on the site calls and the runner answers. `out` carries a command's output while it runs.
 */
export type ToRunner = { t: 'call'; id: number; method: RunnerMethod; args: unknown[] } | { t: 'ping' };
export type FromRunner =
  | { t: 'hello'; name: string; capacity: number; info: RunnerInfo; version: string }
  | { t: 'ok'; id: number; value: unknown }
  | { t: 'err'; id: number; message: string; status: number }
  | { t: 'out'; id: number; text: string }
  | { t: 'pong' };
