/**
 * Where a run's workspace lives and its commands run: a sandbox. The harness and the coding agent
 * reach the workspace only through this, by the run's name and paths from the workspace's root, so
 * the workspace can be on this machine's disk (./sandbox-local) or in a machine of its own (a
 * CubeSandbox microVM, see docs/sandbox.md) without either of them knowing which.
 *
 * What the learner may and may not change (the brief, the customer's documents) is the harness's
 * business, not the sandbox's: the sandbox is only told at `create` what is to be kept read-only
 * from the commands run in it. Everything a provider is asked to do with a path stays inside the
 * workspace; a path that leaves it, a link pointing out of it included, is refused.
 */

export interface FileEntry { path: string; dir: boolean; bytes: number }
/** `mode`: the permission bits (and type), as stat(2) gives them. */
export interface SandboxStat { file: boolean; dir: boolean; bytes: number; mode: number }

export interface ExecOptions {
  /** Where the command starts, from the workspace's root (default: the root). */
  cwd?: string;
  /** What the command prints, as it prints it. */
  onData?: (chunk: Buffer, stream: 'stdout' | 'stderr') => void;
  /** Aborting ends the command and everything it started. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Added to the small environment commands get; nothing of the server's own is passed on. */
  env?: Record<string, string>;
}
export interface ExecResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
}

/** The sandbox cannot run anything for this run (it was never given a user of its own, or the profile cannot be written). */
export class SandboxUnavailable extends Error {}

export interface SandboxProvider {
  /** How far commands are kept from everything outside the workspace. */
  readonly isolation: 'user' | 'sandbox' | 'container' | 'none' | 'vm';
  /** The Python interpreter commands in the sandbox use (the customer's machine has Python 3.9). */
  readonly python: string;
  /** Where the workspace is as commands in the sandbox see it: what the coding agent is told. */
  workspacePath(id: string): string;
  /**
   * Hand a freshly built workspace over to the sandbox. `readOnly`: top-level names in it that
   * commands may read but not change or remove.
   */
  create(id: string, opts: { readOnly: string[] }): Promise<void>;
  /** Run a shell command (a string) or a program with its arguments (an array) in the workspace. */
  exec(id: string, command: string | string[], opts?: ExecOptions): Promise<ExecResult>;
  /** A file's bytes; `maxBytes` reads no more than that many from its start. */
  readFile(id: string, path: string, opts?: { maxBytes?: number }): Promise<Buffer>;
  /** Write a file, making the folders it is in. It belongs to the sandbox's user, as if a command had made it. */
  writeFile(id: string, path: string, data: string | Uint8Array, opts?: { mode?: number }): Promise<void>;
  mkdir(id: string, path: string): Promise<void>;
  /** What is at a path, or null when nothing is. */
  stat(id: string, path: string): Promise<SandboxStat | null>;
  /** Every file and folder in the workspace (links left out), folders before files at each level. */
  list(id: string, opts?: { skip?: ReadonlySet<string>; max?: number }): Promise<FileEntry[]>;
  /** Copy a file or folder to a path that does not exist yet. */
  copy(id: string, from: string, to: string): Promise<void>;
  delete(id: string, path: string): Promise<void>;
  /** Keep the workspace as it is now, to start other sandboxes from; resolves to what to start them from. */
  snapshot?(id: string): Promise<string>;
  /** End everything running in the sandbox and remove the workspace. */
  destroy(id: string): Promise<void>;
}
