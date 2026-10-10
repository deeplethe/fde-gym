# Hosting FDE Gym yourself

The site is in `app/`: a Vite + React front end (`app/web/`) and a Hono server run with tsx
(`app/server/`). The server never changes the harness; it drives `harness/run.py` as a subprocess
(`new`, `serve`, `grade`), so a person in the browser gets the same workspace, the same customer's
people and the same grading as anyone at the command line.

## What it is made of

| | What it does, what is kept there |
|---|---|
| **The site** | Pages, accounts, the library, scheduling, and the model key. It decides which runner a new run goes to and passes everything about that run on to it |
| **Runners** | The machines that run cases. A run's workspace, its terminal, the processes that play the customer's people and its grading are all on its runner. The site itself can be one; with `docker compose` a container beside it is |
| **PostgreSQL** | Accounts and their sessions, settings, the case library's listings, every run and its result, what the customer's people said, terminal history, the coding agent's conversations |
| **Object storage** (S3 protocol) | The cases' files: one archive per version of a case, `cases/<id>/<sha256>.tar.gz` |

The harness executes a case's own Python (its generators, its grader, its simulated services), so a
case has to be on a runner's disk while a run on it is built, served or graded. The runner fetches
the archive of the version the run is on and unpacks it once; a run stays on the version it started
on even if the case is replaced meanwhile.

A run stays on the runner it started on, from Begin to its result: the workspace is on that
machine's disk, and what the customer's people have been asked is in a process's memory there.

## Start it with Docker

```bash
mkdir -p ~/.fdegym && echo "sk-or-..." > ~/.fdegym/openrouter_key
python3 scripts/fetch_cases.py
docker compose up --build             # http://127.0.0.1:8787
```

`docker-compose.yml` starts the site, one runner, PostgreSQL and an S3-compatible object store
(RustFS), listening on this machine only. The site runs no case itself here: the runner does, in a
container of its own, on a network where it can reach the site and nothing else. Case folders in
`cases/` are brought into the library when the site starts. Settings go in `.env` beside it
(`cp .env.example .env`):

| Variable | What it does |
|---|---|
| `FDEGYM_KEY_DIR`, `FDEGYM_KEY_NAME` | The folder that holds your OpenRouter key and the file's name in it (default `~/.fdegym`, `openrouter_key`). The folder is mounted read-only, into the site only |
| `FDEGYM_PORT`, `FDEGYM_PG_PORT`, `FDEGYM_S3_PORT` | Ports on this machine (default 8787, 5432, 9000) |
| `FDEGYM_PROXY` | HTTP proxy for model calls, if one is needed. From a container the host is `http://host.docker.internal:<port>` |
| `FDEGYM_RUNNER_CAPACITY` | How many runs the bundled runner takes at once (default 20) |
| `FDEGYM_ADMIN_EMAILS`, `FDEGYM_PUBLIC_URL`, `FDEGYM_SECRET` | As in Settings below |
| `FDEGYM_RUNNER_TOKEN`, `FDEGYM_PG_PASSWORD`, `FDEGYM_S3_ACCESS_KEY_ID`, `FDEGYM_S3_SECRET_ACCESS_KEY` | The runners' join token, and the passwords of the bundled database and store. Set your own before anyone else can reach the machine |

Data is in the volumes `fdegym_postgres-data`, `fdegym_storage-data`, `fdegym_gym-data` and
`fdegym_runner-data` (the runs' workspaces). Rebuild the image after changing the site or the harness.

## More machines to run cases on

A runner connects to the site, not the other way round. It needs no open port and no address the
site can reach, so it can sit on another network, behind a firewall or a NAT, in another cloud. On
each machine, with the repository checked out:

```bash
FDEGYM_SITE_URL=https://gym.example.com FDEGYM_RUNNER_TOKEN=... \
  docker compose -f docker-compose.runner.yml up --build -d
```

`FDEGYM_RUNNER_TOKEN` is the site's join token: the same value on the site and on every runner.
That starts two containers: the runner, on a network that leads nowhere, and a gateway beside it
that is its one way out and leads only to the site. Without Docker, `pnpm runner` in `app/` is a
runner with the same variables, with nothing between it and the network.

- **What a runner holds.** Workspaces, and the cases it has fetched. No database, no object storage,
  no model key: it fetches cases from the site, and the harness's model calls go to the site's
  relay with a token that is good for one run and has a spending ceiling (`FDEGYM_RELAY_RUN_USD`).
- **Where a new run goes.** To the connected runner with the most room, as a share of what it says
  it can take (`FDEGYM_RUNNER_CAPACITY`). The site itself is used only when no runner has room, and
  not at all with `FDEGYM_LOCAL_RUNNER=0`, which is how `docker compose` sets it.
- **Taking one down.** In the admin console, under Runners: *Drain* stops new runs going to it while
  the ones under way finish; *Disable* shuts it out. A runner keeps its name with its data volume, so
  after a restart it is the same runner and its runs carry on.
- **When one is out of reach.** Its runs cannot be worked until it is back, and say so. Runs that
  were already graded still show their result. A run that was being graded when the connection
  dropped is marked as failed and can be graded again.
- **Trust.** The site believes what a runner reports (a run's result comes from there), and a runner
  can fetch any case's archive, answers included. Keep the join token as carefully as an admin's
  password, and use `https` for the site so that it is not sent in the clear.

## A managed database and a cloud object store

Point the site at them and leave the bundled ones out (`docker compose up gym runner`, with these in
the site's environment, or run the image on its own):

```bash
FDEGYM_DATABASE_URL=postgres://user:password@host:5432/fdegym

# Alibaba Cloud OSS, through its S3-compatible interface
FDEGYM_S3_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
FDEGYM_S3_REGION=oss-cn-hangzhou
FDEGYM_S3_BUCKET=my-fdegym
FDEGYM_S3_ACCESS_KEY_ID=...
FDEGYM_S3_SECRET_ACCESS_KEY=...
FDEGYM_S3_FORCE_PATH_STYLE=0          # OSS addresses a bucket as bucket.host
```

The tables are created when the site starts. Create the bucket beforehand in the provider's console
and keep it private: the archives hold the cases' answers. The same settings, with the provider's
endpoint and region, work for Tencent COS, Cloudflare R2 and AWS S3 (for AWS leave the endpoint out).

## Adding cases

A case is authored as a folder. The library keeps its listing in the database and its files, as one
archive, in object storage. There are three ways in:

- **The import folder.** When the site starts it imports the case folders it finds in
  `FDEGYM_IMPORT_DIR`: new ones, and ones whose files changed. With `docker compose` that is `cases/`
  in the repository, which is where `scripts/fetch_cases.py` puts the open cases.
- **The admin console**, under Cases: upload a `.tar.gz` of a case's folder
  (`tar -czf my_case.tar.gz my_case`). The same id again replaces that case's files.
- **The command line**, in `app/` (in the container: `docker compose run --rm gym npm run cases -- list`):

  ```bash
  pnpm cases import /path/to/cases     # a case folder, or a folder of case folders
  pnpm cases list
  pnpm cases hide <id>                 # off offer; runs under way can finish
  pnpm cases show <id>
  pnpm cases remove <id>               # out of the library; its runs are kept
  ```

  For the full set, mount your copy and import it. Data that a few cases read from `data/` beside
  the cases folder comes along:

  ```bash
  docker compose run --rm -v /path/to/FDE-Gym:/root/import/full:ro gym npm run cases -- import /root/import/full/cases
  ```

Importing the same files again changes nothing. Importing changed files adds a new archive and
points the listing at it; older archives stay in the bucket, so runs under way are still served and
graded on the version they started on.

What a visitor sees of a case is only what you would know before going in: the sponsor's ask from
the brief, and each person's name, role and introduction. How a case is filed (organisation,
sector, region, difficulty) is set when it is first imported, from `app/catalog.json` where the
case has an entry there, and can be changed in the admin console afterwards.

On the site a case is one case: it is worked from what the sponsor said, in their own words, and
nothing more (`briefs/L3.md` in its folder). A folder may hold other briefs that give more away;
the harness can build a run from any of them at the command line, the site does not offer them.

A folder is a **scenario**. A scenario with a `variants.json` holds several cases that share a brief
and differ in the truth behind it; each is worked and scored on its own, and only a number (#1, #2)
is ever sent to the browser. After a run is graded, its page says how that case differs from #1.

## Working on the site

Start what the site depends on, and run it from `app/`:

```bash
docker compose up -d postgres storage
python3 scripts/fetch_cases.py
cd app && pnpm install && pnpm dev    # http://localhost:5173
```

`pnpm dev` starts Vite (5173) and the API (8787); Vite forwards `/api` to the API. With no settings,
the server uses the database and the store that `docker compose` started, imports from `cases/`,
and runs cases itself. To try it with a runner as well, give both a token: `FDEGYM_RUNNER_TOKEN=dev
pnpm dev`, and in another terminal `FDEGYM_SITE_URL=http://127.0.0.1:8787 FDEGYM_RUNNER_TOKEN=dev
FDEGYM_DATA=~/.fdegym-runner pnpm runner`.
You need Node 22, pnpm and Python 3.9 or later. Asking the customer's people and grading call the
model the harness is set up with, so its key file has to be in place (`~/.fdegym/openrouter_key`, or
`FDEGYM_OPENROUTER_KEY_FILE`).

`pnpm build` then `PORT=8787 pnpm start` runs it as one process that serves the pages and the API;
`./deploy-local.sh` does both and keeps it running.

`python3 scripts/smoke_cases.py --site http://localhost:8787 --email <an admin>` runs every case in
a site's library from start to grade, on the site as it is deployed, and checks that grading really
ran the delivered system (an untouched one must load, and score exactly the baseline). Run it after
changing how delivered code is started, after building a new runner image, and after adding a case:
when a grader and the isolation do not suit each other, the grade quietly becomes the baseline's.

`pnpm test` runs the tests of the coding agent's two halves: pi itself on the runner's side, started
as a turn starts it against a scripted model (no key needed), and the site's side (a turn from start
to end, and the relay pi's model calls come through), which works in a database of its own in the
local PostgreSQL and is skipped when there is none. `pnpm typecheck` checks the types.

## Settings

| Variable | What it does |
|---|---|
| `FDEGYM_DATABASE_URL` | The PostgreSQL database (`DATABASE_URL` is read too). Default: the one `docker compose` starts on this machine |
| `FDEGYM_S3_ENDPOINT`, `FDEGYM_S3_REGION`, `FDEGYM_S3_BUCKET` | The object store. Default: the one `docker compose` starts on this machine, bucket `fdegym` |
| `FDEGYM_S3_ACCESS_KEY_ID`, `FDEGYM_S3_SECRET_ACCESS_KEY` | Its key pair |
| `FDEGYM_S3_FORCE_PATH_STYLE` | `1`: `host/bucket/key` (a store of your own); `0`: `bucket.host/key` (the cloud services). Default `1` when an endpoint is set |
| `FDEGYM_S3_PREFIX` | A folder inside the bucket to keep everything under |
| `FDEGYM_IMPORT_DIR` | A folder of case folders to import when the site starts (default `cases/` in the repository, when it is there). Empty turns it off |
| `FDEGYM_RUNNER_TOKEN` | The join token. Set on the site, it lets runners that present it connect; without it none can |
| `FDEGYM_LOCAL_RUNNER` | `0`: the site runs no case itself (it then needs runners). Default: it does, when no runner has room |
| `FDEGYM_RELAY_RUN_USD`, `FDEGYM_RELAY_MODELS` | What one run on a runner may spend through the site's model relay (default 5), and, if set, the only models relayed (comma-separated) |
| `FDEGYM_DATA` | Workspaces of runs and the cases fetched to run them, where the site runs cases itself; `secret.key`. Default `~/.fdegym-app`, outside the repository |
| `FDEGYM_PYTHON` | Interpreter for the harness and for the commands people run (default `python3`) |
| `FDEGYM_EXEC` | `off` removes the terminal (default `local`: commands run on this machine) |
| `FDEGYM_EXEC_TIMEOUT_S` | Time limit for one command (default 1800 seconds) |
| `FDEGYM_EXEC_NPROC`, `FDEGYM_EXEC_FSIZE_MB` | In the container: how many processes one run may have at once (default 512) and the largest file it may write (default 2048 MB) |
| `FDEGYM_AGENT_TURN_S` | Time limit for one message to the coding agent (default 1800 seconds) |
| `FDEGYM_AGENT_CONTEXT` | The context window of the coding agent's model, in tokens. Unset, the site asks the model's provider (its `/models` list, as OpenRouter publishes) and uses 128000 where that does not say. The agent summarises its conversation as it nears the window; the workbench shows how full it is |
| `FDEGYM_MAX_OPEN_RUNS` | How many runs one learner may have open (not handed over) at once (default 3; `0` for no limit) |
| `FDEGYM_RUN_IDLE_DAYS` | A run nobody has opened or used for this many days is ended, which frees its place on the runner (default 14; `0` for never) |
| `FDEGYM_KEEP_WORKSPACE_DAYS` | A run that is over keeps its files on its runner this many days, to be looked at; then they are cleared, and its result and record stay (default 30; `0` for always) |
| `FDEGYM_EXEC_SANDBOX` | `0` turns off the macOS sandbox around commands |
| `FDEGYM_EXEC_UID_BASE` | Run each run's commands as a system user of its own (ids counted from this number). The server must run as root; the image sets it, see Security |
| `FDEGYM_ALLOW_REMOTE` | Must be `1` to listen on anything but this machine, see Security |
| `FDEGYM_ADMIN_EMAILS` | Comma-separated addresses that become admins when they sign up or sign in. Without it, **the first account to sign up becomes the admin** |
| `FDEGYM_ADMIN_TOKEN` | A maintainer token (`Authorization: Bearer <token>`), for scripts and first set-up |
| `FDEGYM_SECRET` | Master key for the SMTP password and the agent's API key saved in the admin console. Generated into `secret.key` in the data folder when not set |
| `FDEGYM_PUBLIC_URL` | The site's public address; password-reset mail links to it |
| `FDEGYM_TRUST_PROXY` | `1` behind a reverse proxy |
| `PORT` / `HOST` | Where to listen (default 127.0.0.1:8787). `API_PORT` wins over `PORT` |

What the harness reads applies as well: `FDEGYM_OPENROUTER_KEY_FILE`, `FDEGYM_PROXY`,
`FDEGYM_MODEL` (see [harness/README.md](../harness/README.md)). The database's and the store's
settings are not passed on to the harness or to anything it starts.

On a runner (`pnpm runner`, or the image with `npm run runner`):

| Variable | What it does |
|---|---|
| `FDEGYM_SITE_URL` | The site it runs cases for |
| `FDEGYM_RUNNER_TOKEN` | The site's join token |
| `FDEGYM_RUNNER_NAME` | What the site calls it (default: its host name, with a few letters added so that two machines are never one runner). Kept with the data folder |
| `FDEGYM_RUNNER_CAPACITY` | How many runs it takes at once (default 20) |
| `FDEGYM_DATA`, `FDEGYM_PYTHON`, `FDEGYM_EXEC*` | As above |

## Security

The code people write is executed where their run is: in the terminal, and again when the run is
graded (grading is executing the delivered system). Three things keep that contained.

**The site and the runner are different processes.** With `docker compose` the site executes
nothing people wrote. The runner does, and it holds none of the site's secrets: not the database's
address or password, not the object store's keys, not the model key. It is on a network of its own
with the site, and that network leads nowhere else: from a workspace the database and the store
cannot even be found, and neither can the internet. (The cases say the customer's machine has no
network; here that is so.) A runner on another machine (`docker-compose.runner.yml`) is closed in
the same way: it sits on a network that leads nowhere, beside a gateway that passes on what a
runner asks of its site (its connection, the cases, the model relays) and refuses everything else.

**On the runner, each run has a system user of its own** (the image sets `FDEGYM_EXEC_UID_BASE`):
the workspace belongs to it, terminal commands run as it, and everything else (the cases, the
harness, other people's workspaces, that run's own logs and its relay token) is closed to it.
Commands are started with a bare environment, and under limits of their own: so many processes at
once, counted for that user, and no file past a set size (`FDEGYM_EXEC_NPROC`,
`FDEGYM_EXEC_FSIZE_MB`), so that one run cannot take the machine from the others. The container as
a whole has a ceiling on processes too (`FDEGYM_RUNNER_PIDS`); memory and CPU are yours to set.

**What the customer handed over is to be read, not changed**: the brief (`TASK.md`), their
documents (`docs/`) and data (`data/`), and the harness's tools for asking them (`bin/`). In the
container they are root's, readable by the run's user and nothing more, and the workspace itself is
sticky, so they cannot be overwritten, removed or renamed from the terminal or by the coding agent;
under the macOS sandbox writing them is denied; and the file API refuses them. `system/` and
`deliverables/` are the learner's, with anything else they make in the workspace. In the file tree
the first are Resources, under one lock, and the rest Deliverables. (A trial day leaves its log
under `data/`: the harness writes that, with its own rights.)

**What a learner delivered is run as that same user** when the harness tries it on a trial day and
when it grades it (grading replays on a copy of the workspace, which is handed to that user). So
delivered code cannot read the cases on the runner's disk, with the held-out traffic and the
reference answers in them, nor the harness, nor the run's relay token, nor the runner's join token.
The result records how the code was started (`gates.isolation`). A grader hands the delivered code
its input through temporary files; while it is at work those belong to the run's user too.

**Run directly on a machine** (`pnpm dev`, `pnpm start`, `pnpm runner`), the start-up line says how
commands are kept in:

- `sandboxed to the workspace` (macOS): commands from the terminal and from the coding agent run in
  the system sandbox. They cannot read or write the home folder, the repository or the data folder,
  except that run's own workspace.
- `NOT ISOLATED` (other systems, or a process that is itself inside another sandbox): nothing keeps
  them in. For your own use only.

The file API only accepts paths inside the workspace and does not follow links that lead out of it.
The site refuses to listen beyond this machine unless `FDEGYM_ALLOW_REMOTE=1`.

What none of this covers:

- **Outside the container** (`pnpm start`, `pnpm runner` on a machine) a trial day and grading run
  the delivered system with the server's own privileges, where it can read the cases on that
  machine's disk and the run's relay token. The harness has a sandbox for grading
  (`FDEGYM_SANDBOX=1`, macOS only) that is passed on to grading started from the site; it is
  optional and has not been checked on every case, so it is off by default. Use the image.
- A grader that runs delivered code inside its own process, instead of starting it as the harness
  tells graders to, runs it as the harness. The three open example cases do not.
- People on the same runner can connect to the ports of each other's runs (the ports are random),
  and can see the command lines of each other's processes.
- From a workspace the site itself can be reached, as it can from anywhere: what it lets a visitor
  do, it lets a learner's command do.
- A runner is trusted by the site: see Trust above.

Before opening a site to strangers, set your own join token and passwords, put a reverse proxy
with TLS and rate limits in front, and give the runner's container a memory and CPU limit that
suits the machine.

## Accounts

How people sign up is chosen in the admin console: open, by e-mail confirmation (needs the mail
settings there), or closed, in which case admins create members. Practising without an account can
be allowed too; those runs belong to the browser and move to the account on sign-in.

## The coding agent

The workbench has a coding agent: you say what you want, it reads files, runs commands, changes code
and reports back. The terminal is still there, in a tab beside it.

The agent is [pi](https://pi.dev) (`@earendil-works/pi-coding-agent`, installed with the app). Each
message is one run of pi without its interface, on the runner that holds the workspace: it starts in
the workspace as the user a learner's commands run as, works with its own tools (read, bash, edit,
write), and keeps its session beside the workspace, so the conversation carries on from one message
to the next.

- The site pays for the model. Set it in the admin console, under Agent: an OpenAI-compatible
  endpoint with tool calling and streaming, the model, the key, a proxy, the steps allowed per
  message and the spending cap per run.
- The key stays on the site. pi is given a token good for one message of one run and calls the site
  at `/api/agent/v1/chat/completions`; the site sends the call on with its own key and counts what
  the run spends. A runner on another machine therefore needs nothing more than its way to the site.
- Until the admin page is filled in, the agent uses the harness's key file and default model: cheap,
  and not reliable at writing code. Set a proper one for real use.
- pi is confined like a learner's commands: to the workspace, and in the container to that run's own
  user. It starts with nothing from outside: no extensions, skills, MCP servers or context files, no
  update check, no telemetry.
- The agent cannot contact the customer's people or start a trial day. Both have a cost, and both
  are left to the person.
- A turn belongs to the runner pi is working on, not to the connection that asked for it. If the
  site restarts, or loses touch with the runner, pi goes on working; when they are back in touch
  the site reads the turn from the start, keeps what it had not kept, and the page, which has been
  asking in the meantime, shows the rest. So the site can be restarted (an upgrade, say) while
  people are working. A turn is lost only when its runner restarts, or when the site ran it itself.
- The agent does most of the typing, so the workbench shows what was done in the learner's name: a
  Changes tab lists every file that differs from when the run began (a copy of the workspace as
  built is kept beside it, closed to the run's user), each opening to its diff and able to be put
  back; the hand-over dialog lists what under `system/` is about to go to production; and the
  agent's panel shows what it has cost the run against the run's ceiling.
- A runner started outside the container needs Node 22.19 or newer, which pi requires.

## A run, start to finish

1. **Begin.** The site picks a runner and records the run. The runner fetches the version of the
   case the library holds, if it does not have it yet, and `run.py new` builds the workspace.
2. **Work.** `run.py serve` is started on the runner when needed, as a process of its own, so
   restarting the site or the runner does not restart it (what the customer's people have been asked is in its memory, and is lost
   when the machine restarts). Questions from the page and `bin/ask` in the terminal both go to it.
3. **Hand over.** `serve` is stopped, `run.py grade` runs in the background, and the page waits for
   the result. A run is handed over once.

The result page gives the score, the customer's metric, incidents, and who was contacted.

## Solved, acceptance and the leaderboard

The score of a run is what the delivered system gained on the customer's own metric: 0 for changing
nothing, 1 for the reference solution, less what the work cost the customer's people; a run with an
incident scores no higher than 0. The site shows it out of 100, as a whole number (cut, not rounded:
`app/web/lib/score.ts`); the harness and the database keep the fraction. A case is **solved** by a
run that scores 80 or more (`SOLVED_AT`, 0.8, in `app/server/standings.ts`).

- **Acceptance** on the case list is the share of graded runs, by anyone, that solved the case.
- **Difficulty** has three levels. For the twenty cases published with FDE-Gym they follow how the models on the FDE-Gym
  leaderboard did at the brief the site uses (the sponsor's own words): a case that some of the
  models solved is easy, one that none solved but on which they made real headway is medium, and
  one where they got nowhere, or made things worse, is hard. It is what `app/catalog.json` files a
  case under when it is first imported, and an admin can refile a case in the console.
- **Submissions** lists the latest runs handed over and how each was judged: accepted, not accepted,
  or an incident. Members appear under the name on their account, anyone else as anonymous.
- **The leaderboard** ranks members by cases solved, then by the sum of their best score on each
  case, then by who got there first. Only accounts are ranked, under the name on
  the account; people practising without one are counted in acceptance but not listed.
