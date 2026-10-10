/**
 * Learner identity: a random id plus a display name, in a signed-free cookie. Enough for local use
 * and a classroom; a public deployment should put real sign-in in front of this.
 */
import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

const COOKIE = 'fdegym_learner';

export interface Learner { id: string; name: string }

export function getLearner(c: Context): Learner | undefined {
  const raw = getCookie(c, COOKIE);
  if (!raw) return undefined;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Learner;
    return typeof v.id === 'string' && typeof v.name === 'string' ? v : undefined;
  } catch { return undefined; }
}

/** Keep the id if the learner already has one; update the display name. */
export function setLearner(c: Context, name: string): Learner {
  const learner = { id: getLearner(c)?.id ?? randomBytes(12).toString('hex'), name: name.trim().slice(0, 40) || '学员' };
  setCookie(c, COOKIE, Buffer.from(JSON.stringify(learner)).toString('base64url'), {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 365,
  });
  return learner;
}
