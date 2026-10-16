# Sandboxes

Where a run's workspace lives and where the commands run in it: today a folder on the runner's own
disk, kept apart by a Unix user per run; next, a microVM per run on
[CubeSandbox](https://github.com/TencentCloud/CubeSandbox). This note describes the seam between
the two (`SandboxProvider`), how the coding agent works through it, and the design of the
CubeSandbox backend. Nothing in the CubeSandbox part is built yet.

## What runs where

| Part | Where it runs | Holds |
|---|---|---|
| The site (`server/index.ts`) | its own container | the database, the model key, the settings key |
| The runner (`server/runner.ts`, or the site itself as the local runner) | the runner container, as root | the cases on its disk, the run's relay token, pi's session and settings |
| pi, the coding agent (`server/pi.ts`) | the runner, one process per turn, **outside** the sandbox | the turn's relay token |
| The harness's services for a run (`run.py serve`: the customer's people, the LLM gateway, the customer's services) | the runner, outside the sandbox | the case's NPC scripts and facts, held-out data |
| Grading (`run.py grade`) | the runner, outside the sandbox (today it imports the delivered code into its own process tree, as the run's user) | the held-out traffic, the graders |
| **The sandbox** | today: the runner container, as the run's own user; next: a microVM | the workspace, and whatever the learner's and the agent's commands start |

The rule is that nothing secret goes into the sandbox: not the site's model key, not the relay
token pi calls the model with, not the cases, not the held-out data. What the sandbox needs from
outside (the customer's people, the LLM gateway, the customer's services) it reaches over the
network, with a token good for that one run.

## The interface

`app/server/sandbox.ts`:

```ts
interface SandboxProvider {
  readonly isolation: 'user' | 'sandbox' | 'none' | 'vm';
  create(id, { readOnly }): Promise<void>;          // hand a freshly built workspace over
  exec(id, command | argv, { cwd, onData(chunk, stream), signal, timeoutMs, env }): Promise<{ code, signal, timedOut, aborted }>;
  readFile(id, path, { maxBytes }): Promise<Buffer>;
  writeFile(id, path, data, { mode }): Promise<void>; // makes the folders on the way
  mkdir(id, path): Promise<void>;
  stat(id, path): Promise<{ file, dir, bytes, mode } | null>;
  list(id, { skip, max }): Promise<FileEntry[]>;     // the whole tree, links left out
  copy(id, from, to): Promise<void>;
  delete(id, path): Promise<void>;
  snapshot?(id): Promise<string>;
  destroy(id): Promise<void>;
}
```

Paths are always from the workspace's root, and a provider refuses any path that leaves the
workspace, a link that points out of it included. `readOnly` names the top-level entries a command
may read but not change (`TASK.md`, `bin/`, `docs/`, `data/`); the provider's own writes refuse
them too, by their own name or through a link. Everything else that is policy (what the file API
may do, the 2 MB write limit, one terminal command at a time, output caps) stays in
`server/harness.ts`, above the provider.

`exec` takes a shell line (run with `/bin/sh -c`) or an argument vector. Output is streamed per
chunk with the stream it came from; aborting the signal or running past `timeoutMs` ends the command
and everything it started (`SIGKILL` to its process group).

Who calls what:

| Caller | Uses |
|---|---|
| `harness.createRun` / `deleteRun` | `create`, `destroy` |
| The file tree and editor (`listFiles`, `readFile`, `writeFile`, `deletePath`, `duplicate`, `revertFile`, `taskOf`) | `list`, `stat`, `readFile`, `writeFile`, `copy`, `delete` |
| The terminal (`execIn`, `killExec`) | `stat`, `exec` with an `AbortSignal` |
| The SQLite viewer | `exec` with an argument vector (Python reading the file read-only, as the run's user) |
| pi's tools, through `server/pi.ts` | `stat`, `readFile`, `writeFile`, `mkdir`, `exec` |

Two things still read the workspace from the runner's disk directly and need porting before a
remote provider can serve a whole run: the Changes tab (`changes`, `diffOf`, which compare against
the copy of the workspace as built, kept beside it), and the harness itself (`run.py serve` for a
trial day, `run.py grade`). Both are covered in the CubeSandbox design below.

## The local provider (today)

`app/server/sandbox-local.ts`, behaviour unchanged from before the interface:

- **In the runner container** (`FDEGYM_EXEC_UID_BASE`, server as root): each run gets a Unix user
  of its own. `create` gives the workspace to it, makes the read-only entries root's and readable by
  the run's group, and makes the workspace root's, group-writable and sticky. Commands run as that
  user under `prlimit` (processes per user, file size, no core dumps), in a process group of their
  own, with a bare environment (`PATH`, `HOME` = the workspace, `TMPDIR`, `LANG`, `TERM=dumb`).
- **On macOS outside a container**: commands run under `sandbox-exec` with a profile that denies the
  home folder, the repository and the data folder except the run's workspace, and denies writing the
  read-only entries.
- **Anywhere else**: nothing (`isolation: 'none'`); the runner says so at start-up.

The server's own reads and writes (the file API, pi's file tools) run as root, so the provider
resolves every path, refuses one that leaves the workspace (a dangling link counts as leaving it:
following it would create whatever it names), refuses writes into the read-only entries through a
link, and hands what it writes to the run's user.

What the local provider does **not** give:

- **Memory and CPU limits per run.** Only the container's. One run can starve the others.
- **Network separation between runs.** Every run's commands share the container's network namespace:
  a run can connect to another run's NPC server, LLM gateway or customer services on `127.0.0.1`
  (the ports are random, not secret), and see other runs' command lines in `ps`.
- **Isolation of grading.** A trial day and grading start the delivered code as the run's user, but
  from the harness's process tree, on the same disk as the cases.
- **Atomicity against a racing learner.** A path is checked, then used; a learner's command that
  swaps a folder for a link in between can redirect one server-side write. (The provider never
  follows a link out of the workspace that is there when it checks.)

These are what the microVM backend is for.

## The coding agent and the sandbox

pi (`@earendil-works/pi-coding-agent` 1.1.0) runs outside the sandbox, as the runner, with its
working directory in the run's `agent/` folder (root's, mode 0700): that is where its `models.json`
with the turn's relay token lives, with its sessions and the extension it is started with. Its
working directory is deliberately not the workspace, because pi reads project settings from a
`.pi/` folder where it starts.

The extension (`tools.js`, written for each turn by `prepare()` in `server/pi.ts`) replaces pi's
four built-in tools with pi's own implementations (`createReadToolDefinition`,
`createWriteToolDefinition`, `createEditToolDefinition`, `createBashToolDefinition`) given other
`operations`, the mechanism pi's `examples/extensions/ssh.ts` uses:

- Each operation turns its absolute path into a path from the workspace's root (refusing anything
  outside it) and sends a request to the runner over the Node IPC channel pi was spawned with
  (`stdio: [..., 'ipc']`, `serialization: 'advanced'`, so file contents travel as bytes). The
  runner answers by calling the run's `SandboxProvider`, applying the same rule as the file API: the
  customer's material is read-only.
- `bash` becomes `exec` on the provider: output streams back as IPC messages, pi's abort becomes an
  `abort` message, its `timeout` becomes `timeoutMs`. When pi exits (its turn is over, stopped, or
  timed out), every command it still has running is aborted.
- The tools are told the workspace is their working directory, and a `before_agent_start` hook
  replaces pi's own folder with the workspace in the system prompt, so the model sees no difference.
- The same extension refuses `bin/ask` and `bin/pilot` from `bash`, as the old `guard.js` did.

Why IPC: it needs no listening socket and no credential. A local socket or HTTP bridge would need a
token, and it would have to be kept from the run's user; the IPC channel is a socket pair only the
two processes hold. It also works unchanged for a remote provider: pi never touches the workspace
itself, so it does not matter where the workspace is.

What pi still does on the runner's own disk: its session files, and the file the `bash` tool writes
when a command's output is too long to return whole (`/tmp/pi-bash-*.log`). The model is told that
path, but cannot read it with `read` (outside the workspace); it can rerun the command with less
output. Sessions started before this change recorded the workspace as their working directory, and
pi keeps using a session's recorded directory; such a session still works (pi does not trust the
workspace's `.pi/` folder, `--no-approve`), and new sessions start in `agent/`.

## A CubeSandbox backend

Not built. This is the design to build it against. The API facts come from TencentCloud/CubeSandbox
upstream (after v0.7.3) and from the working client in apex-research-respawn
(`agent/pi/src/cube.ts`, which ran against v0.7.1-rc2).

**Pin a version first.** The fork `WaylandYang/CubeSandbox` is at about v0.2.2. It has no volumes,
no rollback, no live network update and no L7 egress (CubeEgress), and its `POST /sandboxes` drops
`envVars`. Everything below needs v0.7.x: rebase the fork, or deploy upstream at a tagged release.

### Host

CubeSandbox runs KVM microVMs, so the runner that drives it needs a Linux host it can reach:

- **CPU and virtualisation:** x86_64 (aarch64 only on bare metal), with `/dev/kvm`. On an ordinary
  cloud VM, either run the PVM host kernel (x86_64 only), or enable nested virtualisation, which
  gives `/dev/kvm` without `.metal` or PVM (AWS m7i/c7i class with `NestedVirtualization=enabled`).
- **Root and Docker.** The control plane's MySQL and Redis run in compose.
- **Disk:** `/data/cubelet` on **XFS with reflink**, because snapshots are copy-on-write. At least
  50 GB free, 200 GB+ recommended. Ubuntu and Debian default to ext4, so mount an XFS volume.
- **Memory:** at least 8 GB of RAM and 4 cores for the control plane and a few sandboxes. About
  1 GB of that is the control plane, and each sandbox reserves its template's memory.
- **OS:** OpenCloudOS 9 / TencentOS 4 recommended, Ubuntu 20.04–24.04 tested, glibc ≥ 2.31.

The development machine for this project is Windows 11 Home, with no nested KVM, so there is no
local proof of concept. The first one needs a Linux VM with KVM. Until then the local provider is
the only one, and `pnpm test` runs against it.

Defaults to tighten before strangers use it:

- The guest kernel command line has `mitigations=off`.
- Guests get the full capability set and fully mapped uid/gid ranges.
- With no `timeout` on create, the server never reclaims a sandbox (`default_timeout_insec: -1`).

### Shape

```
 site ── runner (root; holds cases, relay tokens) ─────────────── CubeAPI :3000 (REST, E2B-compatible)
          │  pi (one per turn) ─IPC─┐                               │
          │  CubeProvider ◄─────────┘── envd :49983 via CubeProxy ──┼── sandbox (microVM): /home/learner/workspace
          │  run gateway (NPC, LLM gateway, services) ◄── egress allowlist, per-run token ──┘
          └─ grading: the harness drives a fresh clone through envd
```

`CubeProvider` implements `SandboxProvider` with two clients: CubeAPI for lifecycle, and envd for
everything in the guest. The runner keeps a few things per run beside the run's folder, root's as
now:

- the `sandboxID`;
- the `trafficAccessToken` CubeAPI returns at create (it is returned only then);
- the current snapshot ID;
- the run's gateway token.

How each method maps:

| `SandboxProvider` | CubeSandbox |
|---|---|
| `create(id, { readOnly })` | `POST /sandboxes` with `templateID` = the case version's template (see below) and an explicit `timeout`. Network: `{ allowPublicTraffic: false, allow_internet_access: false, allowOut: [run gateway], rules: [...] }`. Metadata: `{ run: id }`. `readOnly` is already baked into the template's file ownership. |
| `exec(id, cmd, opts)` | envd `process.Process/Start`, see the exec details below the table. |
| `readFile` | `GET /files?path=…&username=learner` (404 means missing). `maxBytes` uses a `Range` header if envd honours it, else `head -c` through exec. |
| `writeFile` | `POST /files?path=…&username=learner` as `application/octet-stream`, retried as multipart on 4xx/5xx as the upstream SDK does. It writes as `learner`, so the guest's own permissions keep `TASK.md`, `bin/`, `docs/` and `data/` read-only. `mode` is applied with `chmod` through exec. |
| `mkdir` / `stat` / `delete` | `filesystem.Filesystem/MakeDir` / `Stat` / `Remove` (unary Connect JSON). |
| `list` | One exec of a small Python script that walks the tree and prints JSON, as apex does. `ListDir`'s depth parameter is unconfirmed, and one round trip beats one per folder. |
| `copy` | exec `cp -a -- from to`. There is no copy RPC. |
| `snapshot` | `POST /sandboxes/:id/snapshots` returns a `snapshotID`. It holds memory and file system and takes about 50 ms, plus about 40 ms per 100 MB dirtied. |
| `destroy` | `DELETE /sandboxes/:id` (404 counts as done), and `DELETE /templates/<snapshotID>` for each of the run's snapshots. |

`exec` in detail:

- **Request:** a Connect server stream (`application/connect+json`, 5-byte envelopes), with
  `Authorization: Basic base64("learner:")`. The command is `cmd: "/usr/bin/setsid"` with args
  `["/bin/sh", "-c", cmd]` (or the argument vector), plus `cwd` and `envs`.
- **Events:** `start.pid` comes first. `data.stdout` and `data.stderr` (base64) go to `onData`. The
  exit code is `end.exitCode`; failing that, parse `status` (`exit status N` gives N, `signal N`
  gives 128+N).
- **Timeout:** `timeoutMs` becomes `Connect-Timeout-Ms`, sent only when it is above 0 (0 hangs),
  plus a client-side timer.
- **Abort or timeout:** send `process.Process/SendSignal` with
  `{process: {pid}, signal: "SIGNAL_SIGKILL"}`. Then run `kill -KILL -- -<pid>` through a second
  exec to end the whole process group, because it is not documented whether cancelling the stream
  kills the process.

Paths stay workspace-relative at the interface. The provider joins them onto the guest's workspace
and refuses `..`, as the local one does. A link out of the workspace is no longer a danger to the
host, since the VM is the boundary and the provider's writes run as `learner`. Such links are still
refused, so that both providers behave alike.

It needs two small additions to the interface:

- The workspace's path as the model should be told it. That is `/home/learner/workspace` here,
  where `server/pi.ts` now passes the local folder.
- `exec` with a writable stdin, for grading (see below).

### One template per case version, one clone per run

`run.py new` builds a workspace from the case. It copies the files, renders the brief for the level
and variant, and writes `bin/ask` and the clients for the case's LLM gateway and services. That is
slow, and the result is the same for every run of a (case, version, level, variant) except for one
thing: it bakes in the run's random ports. So:

1. **Wire by name, not port.** `run.py new` gets a mode (`--wire gateway`) in which `bin/ask`,
   `bin/pilot`, the LLM client and the service clients call `http://gw.fdegym.internal/<what>`
   instead of `127.0.0.1:<port>`. `gw.fdegym.internal` is in the guest's `/etc/hosts`, pointing at
   the run gateway. This is a harness change (`ask_client.py`, `pilot_client.py`, `wire_llm`,
   `wire_services`) and needs a harness version bump.
2. **Build the template once**, on first use of that (case, sha, level, variant), next to where the
   case cache is filled today:
   1. Run `run.py new --wire gateway` into a staging folder on the runner.
   2. Start a sandbox from the base template. The base is Python 3.9 with SQLite (the customer's
      machine) plus envd from `cubesandbox-base`, with 2 vCPU, 2 GB and a few GB of writable layer
      by default. A case may ask for more in its config.
   3. Upload the workspace as a tarball and unpack it as `learner` in `/home/learner/workspace`.
   4. Make the read-only entries root's and the workspace sticky, as `sandbox-local` does now.
   5. Keep a copy as built in `/opt/fdegym/baseline` (root's, readable).
   6. Call `POST /sandboxes/:id/snapshots` and kill the builder. The snapshot ID is the template;
      record it with the case cache entry. (`cubemastercli tpl commit` does the same from the CLI.)

   Templates have to be present on every node that creates sandboxes.
3. **Per run**, `create` is `POST /sandboxes {templateID: <snapshot>}`, which takes 60–85 ms from a
   snapshot on local XFS. `meta.json`, the ledger, the logs and the relay token stay in the run's
   folder on the runner, as now. Only the workspace is in the guest.

CubeSandbox has no per-sandbox override for CPU and memory: they come from the template. So they
are set per case, which is the right granularity anyway, and one run can no longer take the
machine from the others.

### What the sandbox can reach

The sandbox is created with `allow_internet_access: false` and `allowPublicTraffic: false` (envd
then answers only requests that carry the run's `trafficAccessToken`), and with one `allowOut`
entry: the run gateway's address. It cannot reach anything else: not the internet, not the site,
not other sandboxes, not CubeAPI.

The **run gateway** is a small HTTP service on the runner, outside every sandbox:

- It sends each request on to that run's own NPC server, LLM gateway or customer service
  (`/npc/…`, `/llm/…`, `/svc/<name>/…`), by a token good for that run only.
- It refuses everything else.
- The harness's services keep listening on the runner's `127.0.0.1`, which guests can reach only
  through the gateway.

The token reaches the gateway in one of two ways:

- **Injected on the way out** (preferred; needs CubeEgress, v0.4+): an L7 rule on the sandbox
  matching `host: gw.fdegym.internal` with `inject: Authorization: Bearer <run token>`. The guest
  never sees the token. The rules are set at create and can be changed with
  `PUT /sandboxes/:id/network`, which replaces the whole policy, so always send all of it.
- **A file in the guest** (`/etc/fdegym/token`, readable by `learner`): simpler, and harmless,
  since it only opens that run's own customer, whom the learner may talk to anyway.

This also closes what the local provider leaves open: runs on one machine can no longer reach each
other's ports or see each other's processes.

pi's model calls do not go through the sandbox at all, because pi is on the runner (see above). So
the site's relay is not on the allowlist.

### Idle runs

A run lasts days, and a sandbox should not:

- **While the run is used**, the provider keeps its sandbox alive. Each exec or file call resets
  CubeSandbox's idle clock, and a long command gets a `/timeout` refresh every few minutes.
- **Before it goes idle**, the provider takes a snapshot and kills the sandbox. Sandboxes are
  created with a `timeout` of about 30 minutes, and the snapshot is taken before that runs out. The
  snapshot is recorded as the run's own template.
- **On the next call for that run**, the provider creates a sandbox from that snapshot (tens of
  milliseconds), then deletes the older one.

This frees memory between sessions without using CubeSandbox's pause, since paused sandboxes keep
their scheduler quota by default. A snapshot holds memory too, so whatever the learner left running
in the background survives; outbound connections do not.

### Trial days and grading in a fresh clone

Today the harness starts the delivered system from its own process tree, as the run's user, on the
disk that holds the cases. With CubeSandbox:

- **Hand-over:** take a `snapshot` of the run's sandbox. That is the delivery, frozen, and
  regrading uses it again.
- **Grading:** a new sandbox from that snapshot, with no network at all and no `learner` session on
  it. The harness stays on the runner with the held-out traffic and the graders. It starts the
  delivered code in the clone through `exec`: the clone does `isolate.py`'s job, starting
  `system/`'s entry point as `learner`, feeding it a request on stdin and reading its answer.
  - The held-out inputs enter only that clone, which nobody else can reach and which is destroyed
    when grading ends.
  - The graders, the references and the results never enter a guest.
  - This needs `exec` with stdin, and graders that call delivered code through a launcher hook
    instead of importing it. Most graders already do: they hand the delivered code its input
    through temporary files.
- **Trial day** (`bin/pilot`): the same, on a clone of the run's current state. Afterwards the
  provider writes the trial's log back into the run's `data/`.

### The Changes tab and the SQLite viewer

The copy as built lives in the template at `/opt/fdegym/baseline`. So `changes` and `diffOf` become
one exec in the guest, of a script that compares the two trees (and `diff -U` for one file),
instead of reading the runner's disk. The SQLite viewer already runs through `exec` with an
argument vector, and works unchanged.

### Order of work

1. Deploy CubeSandbox v0.7.x on a Linux KVM host and build the base template. Measure, for a real
   case: create from snapshot, snapshot with a dirty workspace, and the exec round trip.
2. Write `CubeProvider` for `create`, `exec`, files and `destroy`, behind `FDEGYM_SANDBOX=cube`, with
   the local provider staying the default. Run the existing sandbox and pi tests against it, with a
   template made from a fixture workspace.
3. In the harness: `--wire gateway`, the run gateway and the egress policy.
4. Templates per case version; idle snapshot and resume.
5. The Changes tab in the guest; grading and trial days in clones.

### Open questions

- Does cancelling an envd `Start` stream kill the process?
- Does `POST /files` make missing folders, and does it honour `Range`?
- What does a capacity error look like on v0.7.x? apex matches the text `no more resource`.
- What are the real snapshot sizes and times for a Python case template?
