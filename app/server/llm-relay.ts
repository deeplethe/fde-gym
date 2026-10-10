/**
 * The site's model relay, for runs on machines that hold no model key.
 *
 * The harness on a runner makes the same chat-completions call it would make to the provider, but
 * to POST /api/llm/v1/chat/completions here, carrying a token that was made for one run and is good
 * for nothing else. The site checks the token, adds its own key and passes the call on. So the key
 * never leaves the site, and what a run may spend through it has a ceiling
 * (FDEGYM_RELAY_RUN_USD, default 5; FDEGYM_RELAY_MODELS may also name the only models allowed).
 *
 * The calls are the routing and grading model's: matching a question to what a stakeholder knows,
 * judging where a case needs it, and the gateway the delivered system may call. The coding agent in
 * the workbench has a relay of its own (./agent), with its own allowance.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { fetch as proxiedFetch, ProxyAgent } from 'undici';
import { harnessKey } from './agent-settings';
import { db } from './db';

const UPSTREAM = process.env.FDEGYM_RELAY_UPSTREAM || 'https://openrouter.ai/api/v1/chat/completions';
const RUN_USD = Number(process.env.FDEGYM_RELAY_RUN_USD) || 5;
const MODELS = (process.env.FDEGYM_RELAY_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const PROXY = process.env.FDEGYM_PROXY || undefined;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A token for one run: the run's record keeps only its hash. */
export function newRelayToken(): { token: string; hash: string } {
  const token = `fdegym-run-${randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

const refuse = (status: number, message: string) => new Response(JSON.stringify({ error: { message, code: status } }), { status, headers: { 'content-type': 'application/json' } });

export function relayRoutes(app: Hono) {
  app.post('/api/llm/v1/chat/completions', async (c) => {
    const token = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1];
    if (!token) return refuse(401, 'no run token');
    const run = await db.one<{ id: string; status: string }>('SELECT id, status FROM runs WHERE relay_hash = $1', [sha256(token)]);
    if (!run) return refuse(401, 'unknown run token');
    // A run calls the model while it is worked and while it is graded, and not after.
    if (run.status !== 'running' && run.status !== 'grading') return refuse(403, 'this run is over');
    const spent = (await db.one<{ usd: number }>('SELECT usd FROM relay_usage WHERE run_id = $1', [run.id]))?.usd ?? 0;
    if (spent >= RUN_USD) return refuse(402, `this run has used its model allowance (USD ${RUN_USD})`);

    const body = await c.req.json().catch(() => undefined) as { model?: unknown; stream?: unknown } | undefined;
    if (!body || typeof body.model !== 'string') return refuse(400, 'not a chat-completions request');
    if (body.stream) return refuse(400, 'streaming is not relayed');
    if (MODELS.length && !MODELS.includes(body.model)) return refuse(403, `model ${body.model} is not relayed by this site`);
    const key = harnessKey();
    if (!key) return refuse(503, 'the site has no model key');

    let res: Awaited<ReturnType<typeof proxiedFetch>>;
    try {
      res = await proxiedFetch(UPSTREAM, {
        method: 'POST', body: JSON.stringify(body),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-title': 'fdegym' },
        signal: AbortSignal.timeout(600_000), ...(PROXY ? { dispatcher: new ProxyAgent(PROXY) } : {}),
      });
    } catch (e) {
      console.error('relay:', (e as Error).message);
      return refuse(502, 'the model provider could not be reached');
    }
    const text = await res.text();
    if (res.ok) {
      // What it cost, as the provider reports it; a reply without the figure counts for nothing.
      try {
        const u = (JSON.parse(text) as { usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } }).usage ?? {};
        await db.run(`INSERT INTO relay_usage (run_id, calls, prompt_tokens, completion_tokens, usd) VALUES ($1, 1, $2, $3, $4)
          ON CONFLICT (run_id) DO UPDATE SET calls = relay_usage.calls + 1, prompt_tokens = relay_usage.prompt_tokens + EXCLUDED.prompt_tokens,
            completion_tokens = relay_usage.completion_tokens + EXCLUDED.completion_tokens, usd = relay_usage.usd + EXCLUDED.usd`,
        [run.id, Math.round(u.prompt_tokens ?? 0), Math.round(u.completion_tokens ?? 0), Number(u.cost) || 0]);
      } catch { /* not JSON: passed on as it is */ }
    }
    return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
  });
}
