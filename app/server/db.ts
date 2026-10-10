/**
 * The site's database (PostgreSQL): accounts and their sessions, settings, the case library, learner
 * runs, what the stakeholders said, terminal history and the coding agent's conversations.
 *
 * FDEGYM_DATABASE_URL (or DATABASE_URL) says where it is. Without either, the server looks for the
 * database that `docker compose up -d postgres` starts on this machine.
 *
 * Times are milliseconds since the epoch, kept as BIGINT and read back as numbers.
 */
import pg from 'pg';

// BIGINT (times, counts) and NUMERIC come back as strings unless told otherwise; none here outgrow a double.
pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, Number);

/** Local development only: what docker-compose.yml starts. Anything shared sets its own URL. */
const LOCAL = 'postgres://fdegym:fdegym@127.0.0.1:5432/fdegym';
export const DATABASE_URL = process.env.FDEGYM_DATABASE_URL || process.env.DATABASE_URL || LOCAL;

let pool: pg.Pool | undefined;
function conn(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: Number(process.env.FDEGYM_DATABASE_POOL ?? 10) });
    // A connection that drops while idle (the database restarted) is replaced by the pool; it must not take the server down.
    pool.on('error', (e) => console.error('database connection lost:', e.message));
  }
  return pool;
}

type Params = unknown[];
/** Anything that can run a statement: the pool, or one connection inside a transaction. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: Params): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: Params): Promise<T | undefined>;
  /** For statements that return nothing; resolves to the number of rows changed. */
  run(sql: string, params?: Params): Promise<number>;
}

const over = (c: { query: (sql: string, params?: Params) => Promise<pg.QueryResult> }): Db => ({
  query: async <T>(sql: string, params?: Params) => (await c.query(sql, params)).rows as T[],
  one: async <T>(sql: string, params?: Params) => (await c.query(sql, params)).rows[0] as T | undefined,
  run: async (sql: string, params?: Params) => (await c.query(sql, params)).rowCount ?? 0,
});

export const db: Db = {
  query: (sql, params) => over(conn()).query(sql, params),
  one: (sql, params) => over(conn()).one(sql, params),
  run: (sql, params) => over(conn()).run(sql, params),
};

/** Run `fn` in one transaction; whatever it throws rolls everything back. */
export async function tx<T>(fn: (t: Db) => Promise<T>): Promise<T> {
  const client = await conn().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(over(client));
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * PostgreSQL text cannot hold a NUL character and its JSON cannot hold half of a surrogate pair. Both
 * turn up in what a command prints or a model writes, so text from outside goes through these.
 */
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const text = (s: string) => s.replace(UNSTORABLE, (m) => (m === '\u0000' ? '' : '\uFFFD'));
/** A value as JSON for a JSONB column (pass it with a ::jsonb cast). */
export const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'string' ? text(x) : x));

/** A unique index refused the row. */
export const isDuplicate = (e: unknown) => (e as { code?: string })?.code === '23505';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    created_at BIGINT NOT NULL,
    last_login_at BIGINT,
    legacy_ids JSONB NOT NULL DEFAULT '[]'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (lower(email));
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    used BOOLEAN NOT NULL DEFAULT FALSE
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS email_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at BIGINT NOT NULL
  );

  -- The case library. What a visitor may see of a case is in the columns; the case itself (its world,
  -- generators, grader) is one archive in object storage, named by bundle_key and identified by
  -- bundle_sha. variants holds each version's key and what it changes, which never leave the server.
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    ask TEXT NOT NULL,
    sponsor TEXT NOT NULL DEFAULT '',
    org TEXT NOT NULL DEFAULT '',
    sector TEXT NOT NULL DEFAULT 'Other',
    region TEXT NOT NULL DEFAULT '',
    difficulty TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'en',
    people JSONB NOT NULL DEFAULT '[]',
    variants JSONB NOT NULL DEFAULT '[]',
    features JSONB NOT NULL DEFAULT '{}',
    hidden BOOLEAN NOT NULL DEFAULT FALSE,
    bundle_key TEXT NOT NULL,
    bundle_sha TEXT NOT NULL,
    bundle_bytes BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  -- bundle_sha: the version of the case the run was started on, so it is served and graded on that
  -- version even if the case is replaced meanwhile.
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    learner_id TEXT NOT NULL,
    learner_name TEXT NOT NULL,
    started_at BIGINT NOT NULL,
    finished_at BIGINT,
    status TEXT NOT NULL,
    error TEXT,
    uplift DOUBLE PRECISION,
    uplift_net DOUBLE PRECISION,
    result JSONB,
    variant TEXT,
    bundle_sha TEXT NOT NULL DEFAULT ''
  );
  -- runner: the machine the run is on ('local' is the site itself). relay_hash: the hash of the
  -- token the run's model calls carry when they go through the site's relay.
  -- A case used to be offered at several brief levels; it is one case now.
  ALTER TABLE runs DROP COLUMN IF EXISTS level;
  ALTER TABLE cases DROP COLUMN IF EXISTS levels;
  ALTER TABLE runs ADD COLUMN IF NOT EXISTS runner TEXT NOT NULL DEFAULT 'local';
  ALTER TABLE runs ADD COLUMN IF NOT EXISTS relay_hash TEXT;
  -- last_active: when its owner last opened or used the run; a run left alone long enough is ended (see session.ts).
  ALTER TABLE runs ADD COLUMN IF NOT EXISTS last_active BIGINT;
  -- workspace_gone: the run is over and its files have been cleared from its runner; its result stays here.
  ALTER TABLE runs ADD COLUMN IF NOT EXISTS workspace_gone BOOLEAN NOT NULL DEFAULT FALSE;
  CREATE INDEX IF NOT EXISTS runs_relay ON runs(relay_hash);
  CREATE INDEX IF NOT EXISTS runs_runner ON runs(runner);
  CREATE INDEX IF NOT EXISTS runs_learner ON runs(learner_id);
  CREATE INDEX IF NOT EXISTS runs_case ON runs(case_id);
  CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    who TEXT,
    question TEXT,
    answer TEXT NOT NULL,
    clock TEXT,
    ts BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_run ON messages(run_id);
  CREATE TABLE IF NOT EXISTS commands (
    id BIGSERIAL PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    cwd TEXT NOT NULL,
    command TEXT NOT NULL,
    output TEXT NOT NULL,
    code INTEGER,
    ts BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS commands_run ON commands(run_id);
  CREATE TABLE IF NOT EXISTS agent_messages (
    id BIGSERIAL PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    message JSONB NOT NULL,
    ts BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_messages_run ON agent_messages(run_id);
  -- The machines that run cases and have connected to the site (see runners.ts).
  CREATE TABLE IF NOT EXISTS runners (
    name TEXT PRIMARY KEY,
    capacity INTEGER NOT NULL,
    info JSONB NOT NULL DEFAULT '{}',
    version TEXT NOT NULL DEFAULT '',
    first_seen BIGINT NOT NULL,
    last_seen BIGINT NOT NULL,
    draining BOOLEAN NOT NULL DEFAULT FALSE,
    disabled BOOLEAN NOT NULL DEFAULT FALSE
  );
  -- What each run has spent through the model relay (see llm-relay.ts).
  CREATE TABLE IF NOT EXISTS relay_usage (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    calls INTEGER NOT NULL DEFAULT 0,
    prompt_tokens BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    usd DOUBLE PRECISION NOT NULL DEFAULT 0
  );
  -- A turn of the coding agent that is under way (see agent.ts): which runner pi is working on, the
  -- hash of the token its model calls carry, and how far what it has said has been kept.
  CREATE TABLE IF NOT EXISTS agent_turns (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    runner TEXT NOT NULL,
    seq BIGINT NOT NULL DEFAULT 0,
    started_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_turns_token ON agent_turns(token_hash);
  CREATE TABLE IF NOT EXISTS agent_usage (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    prompt_tokens BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    usd DOUBLE PRECISION NOT NULL DEFAULT 0
  );
  ALTER TABLE agent_usage ADD COLUMN IF NOT EXISTS context_tokens BIGINT NOT NULL DEFAULT 0;
`;

/**
 * Bring the schema up to date; called once when the server (or the cases command) starts. Waits for a
 * database that is still coming up, as it is when everything is started together.
 */
export async function migrate() {
  for (let attempt = 1; ; attempt++) {
    try { await db.one('SELECT 1'); break; } catch (e) {
      if (attempt >= 30) throw new Error(`cannot reach the database at ${DATABASE_URL.replace(/\/\/[^@]*@/, '//')}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await tx(async (t) => {
    // Two servers starting at once must not both create the tables.
    await t.run('SELECT pg_advisory_xact_lock(7234501)');
    await t.run(SCHEMA);
  });
}

export async function closeDb() { await pool?.end(); pool = undefined; }
