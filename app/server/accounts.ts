/**
 * Accounts: users with e-mail and password, login sessions, password-reset tokens, and the
 * server settings the admin pages edit (sign-up, the coding agent's model, mail). All of it is in
 * the site's database (./db).
 *
 * Passwords are hashed with scrypt and a per-user salt. Session and reset tokens are random and
 * only their SHA-256 is stored. Secrets in settings (API keys, SMTP password) are encrypted with
 * AES-256-GCM under FDEGYM_SECRET, or a key generated once into DATA_DIR/secret.key.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, isDuplicate, json, tx } from './db';
import { DATA_DIR } from './engine-paths';

export type UserRole = 'user' | 'admin';
export type UserStatus = 'active' | 'banned';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  createdAt: number;
  lastLoginAt: number | null;
  /** Anonymous practice identities claimed at login (their runs belong to this user). */
  legacyIds: string[];
}

const SESSION_DAYS = 30;
const RESET_MINUTES = 60;

// ---- passwords and tokens

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function checkPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = scryptSync(password, Buffer.from(salt, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(want, got);
}

// A fixed hash to compare against when the e-mail is unknown, so timing doesn't reveal which accounts exist.
const DUMMY_HASH = hashPassword(randomBytes(12).toString('hex'));

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

export function passwordProblem(password: string): string | undefined {
  if (password.length < 8) return '密码至少 8 位';
  if (password.length > 200) return '密码太长';
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) return '密码需要同时包含字母和数字';
  return undefined;
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase();
export const emailProblem = (e: string) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200 ? undefined : '邮箱格式不对');

// ---- users

type Row = { id: string; email: string; name: string; password_hash: string; role: string; status: string; created_at: number; last_login_at: number | null; legacy_ids: string[] };
const toUser = (r: Row): User => ({
  id: r.id, email: r.email, name: r.name, role: r.role as UserRole, status: r.status as UserStatus,
  createdAt: r.created_at, lastLoginAt: r.last_login_at, legacyIds: r.legacy_ids,
});

/** E-mails listed in FDEGYM_ADMIN_EMAILS become admins when they register or log in. */
const bootstrapAdmins = () => new Set((process.env.FDEGYM_ADMIN_EMAILS ?? '').split(',').map(normalizeEmail).filter(Boolean));

/**
 * The very first account on a site becomes its admin, so a fresh deployment can be set up without
 * the maintainer token. Counted and inserted under one lock, so two sign-ups can't both be first.
 */
export async function createUser(email: string, name: string, password: string): Promise<User & { firstAdmin: boolean }> {
  const e = normalizeEmail(email);
  const id = `u_${randomBytes(9).toString('base64url')}`;
  const hash = hashPassword(password);
  try {
    const first = await tx(async (t) => {
      await t.run('SELECT pg_advisory_xact_lock(7234502)');
      const none = (await t.one<{ n: number }>('SELECT COUNT(*) AS n FROM users'))!.n === 0;
      const role: UserRole = none || bootstrapAdmins().has(e) ? 'admin' : 'user';
      await t.run('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [id, e, name.trim().slice(0, 40), hash, role, Date.now()]);
      return none;
    });
    return { ...(await getUser(id))!, firstAdmin: first };
  } catch (err) {
    if (isDuplicate(err)) throw new Error('这个邮箱已经注册过了');
    throw err;
  }
}

export async function getUser(id: string): Promise<User | undefined> {
  const r = await db.one<Row>('SELECT * FROM users WHERE id = $1', [id]);
  return r && toUser(r);
}

/** The user for these credentials, or undefined. Doesn't reveal whether the e-mail exists. */
export async function verifyLogin(email: string, password: string): Promise<User | undefined> {
  const r = await db.one<Row>('SELECT * FROM users WHERE lower(email) = $1', [normalizeEmail(email)]);
  const ok = checkPassword(password, r?.password_hash ?? DUMMY_HASH);
  if (!r || !ok) return undefined;
  const role = bootstrapAdmins().has(r.email) ? 'admin' : r.role;
  await db.run('UPDATE users SET last_login_at = $1, role = $2 WHERE id = $3', [Date.now(), role, r.id]);
  return getUser(r.id);
}

export async function userByEmail(email: string): Promise<User | undefined> {
  const r = await db.one<Row>('SELECT * FROM users WHERE lower(email) = $1', [normalizeEmail(email)]);
  return r && toUser(r);
}

export async function listUsers(q = ''): Promise<User[]> {
  const like = `%${q.trim().replace(/[\\%_]/g, '\\$&')}%`;
  return (await db.query<Row>('SELECT * FROM users WHERE email ILIKE $1 OR name ILIKE $1 ORDER BY created_at DESC', [like])).map(toUser);
}

export async function updateUser(id: string, change: { name?: string; role?: UserRole; status?: UserStatus }): Promise<User> {
  const u = await getUser(id);
  if (!u) throw new Error('没有这个用户');
  await db.run('UPDATE users SET name = $1, role = $2, status = $3 WHERE id = $4', [change.name?.trim().slice(0, 40) || u.name, change.role ?? u.role, change.status ?? u.status, id]);
  // A banned user is signed out everywhere.
  if (change.status === 'banned') await db.run('DELETE FROM sessions WHERE user_id = $1', [id]);
  return (await getUser(id))!;
}

export async function setPassword(id: string, password: string, opts: { keepSession?: string } = {}) {
  await db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(password), id]);
  // Changing the password signs out every other session.
  await db.run('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [id, opts.keepSession ? sha256(opts.keepSession) : '']);
}

export async function checkUserPassword(id: string, password: string): Promise<boolean> {
  const r = await db.one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [id]);
  return !!r && checkPassword(password, r.password_hash);
}

/** Attach an anonymous practice identity to a user, unless someone else already claimed it. */
export async function claimLegacy(userId: string, legacyId: string): Promise<boolean> {
  return tx(async (t) => {
    await t.run('SELECT pg_advisory_xact_lock(7234503)');
    if (await t.one('SELECT 1 FROM users WHERE legacy_ids ? $1', [legacyId])) return false;
    return (await t.run("UPDATE users SET legacy_ids = legacy_ids || jsonb_build_array($2::text) WHERE id = $1", [userId, legacyId])) > 0;
  });
}

export const countUsers = async () => (await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM users'))!.n;

export const countAdmins = async () => (await db.one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'"))!.n;

// ---- sessions

export async function createSession(userId: string): Promise<{ token: string; maxAge: number }> {
  const token = newToken();
  const now = Date.now();
  await db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)', [sha256(token), userId, now, now + SESSION_DAYS * 86_400_000]);
  return { token, maxAge: SESSION_DAYS * 86_400 };
}

export async function sessionUser(token: string | undefined): Promise<User | undefined> {
  if (!token) return undefined;
  const r = await db.one<Row & { expires_at: number }>('SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1', [sha256(token)]);
  if (!r) return undefined;
  if (r.expires_at < Date.now()) { await endSession(token); return undefined; }
  return r.status === 'active' ? toUser(r) : undefined;
}

export async function endSession(token: string) {
  await db.run('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

// ---- password reset

export async function createReset(userId: string): Promise<string> {
  const token = newToken();
  await db.run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256(token), userId, Date.now() + RESET_MINUTES * 60_000]);
  return token;
}

/** Consume a reset token: sets the password and ends all sessions. A token is good once, whoever asks twice at once. */
export async function useReset(token: string, password: string): Promise<User> {
  const r = await db.one<{ user_id: string }>('UPDATE password_resets SET used = TRUE WHERE token_hash = $1 AND NOT used AND expires_at >= $2 RETURNING user_id', [sha256(token), Date.now()]);
  if (!r) throw new Error('重置链接无效或已过期，请重新申请');
  await setPassword(r.user_id, password);
  return (await getUser(r.user_id))!;
}

// ---- settings, with encrypted secrets

function secretKey(): Buffer {
  if (process.env.FDEGYM_SECRET) return createHash('sha256').update(process.env.FDEGYM_SECRET).digest();
  const file = join(DATA_DIR, 'secret.key');
  if (!existsSync(file)) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
}

export function decrypt(value: string): string {
  if (!value.startsWith('enc:v1:')) return value;
  const raw = Buffer.from(value.slice(7), 'base64');
  const d = createDecipheriv('aes-256-gcm', secretKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  return (await db.one<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]))?.value;
}

export async function putSetting(key: string, value: unknown) {
  await db.run('INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at', [key, json(value), Date.now()]);
}

// ---- e-mail verification codes (sign-up when the site requires a verified address)

const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;
export const CODE_RESEND_SECONDS = 60;

/** A new 6-digit code for this address (replacing any earlier one). Refuses if the last was sent under a minute ago. */
export async function issueEmailCode(email: string): Promise<string> {
  const e = normalizeEmail(email);
  const last = await db.one<{ sent_at: number }>('SELECT sent_at FROM email_codes WHERE email = $1', [e]);
  if (last && Date.now() - last.sent_at < CODE_RESEND_SECONDS * 1000) {
    throw new Error(`验证码刚发过，请 ${Math.ceil((CODE_RESEND_SECONDS * 1000 - (Date.now() - last.sent_at)) / 1000)} 秒后再试`);
  }
  const code = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');
  await db.run(`INSERT INTO email_codes (email, code_hash, expires_at, attempts, sent_at) VALUES ($1, $2, $3, 0, $4)
    ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = EXCLUDED.sent_at`,
  [e, sha256(`${e}:${code}`), Date.now() + CODE_MINUTES * 60_000, Date.now()]);
  return code;
}

/** Check and use up the code; five wrong tries void it. */
export async function consumeEmailCode(email: string, code: string) {
  const e = normalizeEmail(email);
  const r = await db.one<{ code_hash: string; expires_at: number; attempts: number }>('SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = $1', [e]);
  if (!r || r.expires_at < Date.now() || r.attempts >= CODE_ATTEMPTS) throw new Error('验证码已失效，请重新获取');
  const ok = timingSafeEqual(Buffer.from(r.code_hash), Buffer.from(sha256(`${e}:${code.trim()}`)));
  if (!ok) {
    await db.run('UPDATE email_codes SET attempts = attempts + 1 WHERE email = $1', [e]);
    const left = CODE_ATTEMPTS - r.attempts - 1;
    throw new Error(left > 0 ? `验证码不对，还可以再试 ${left} 次` : '验证码错误次数太多，请重新获取');
  }
  await db.run('DELETE FROM email_codes WHERE email = $1', [e]);
}
