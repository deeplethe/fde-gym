/**
 * A stand-in for the model behind the coding agent: an OpenAI-compatible chat-completions endpoint
 * that answers from a script instead of thinking. Each call gets the request and its number and
 * says what the model "replies": words, tool calls, or an error. Replies are streamed when the
 * request asks for a stream, as the real ones are.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Reply {
  text?: string;
  tools?: { name: string; args: Record<string, unknown> }[];
  /** What the call is said to have cost; the site's relay counts it. */
  usage?: { prompt_tokens: number; completion_tokens: number; cost: number };
  /** Answer with this HTTP status and no reply. */
  status?: number;
}
export interface Seen { url: string; authorization?: string; body: Record<string, any> }

export async function fakeModel(script: (seen: Seen, n: number) => Reply): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  let calls = 0;
  const server: Server = createServer((req, res) => {
    // The list of models, as providers publish it: what each can read at once. Not a call to the model.
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'another/model', context_length: 32_000 }, { id: 'site/model', context_length: 200_000 }] }));
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const s: Seen = { url: req.url ?? '', authorization: req.headers.authorization, body: JSON.parse(raw || '{}') };
      seen.push(s);
      const n = ++calls;
      const r = script(s, n);
      if (r.status) { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'scripted failure' } })); return; }
      const usage = r.usage ?? { prompt_tokens: 10, completion_tokens: 5, cost: 0 };
      const calls_ = (r.tools ?? []).map((t, i) => ({ index: i, id: `call_${n}_${i}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } }));
      if (!s.body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `c${n}`, model: s.body.model, choices: [{ index: 0, message: { role: 'assistant', content: r.text ?? null, ...(calls_.length ? { tool_calls: calls_ } : {}) }, finish_reason: calls_.length ? 'tool_calls' : 'stop' }], usage }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: `c${n}`, object: 'chat.completion.chunk', created: 1, model: s.body.model };
      const send = (o: object) => res.write(`data: ${JSON.stringify({ ...base, ...o })}\n\n`);
      // Words in two pieces, so that a reader has something to put together.
      const text = r.text ?? '';
      if (text) {
        const half = Math.ceil(text.length / 2);
        send({ choices: [{ index: 0, delta: { role: 'assistant', content: text.slice(0, half) } }] });
        if (text.length > half) send({ choices: [{ index: 0, delta: { content: text.slice(half) } }] });
      }
      // A tool call's arguments in two pieces too.
      for (const c of calls_) {
        const a = c.function.arguments, half = Math.ceil(a.length / 2);
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: c.index, id: c.id, type: 'function', function: { name: c.function.name, arguments: a.slice(0, half) } }] } }] });
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: c.index, function: { arguments: a.slice(half) } }] } }] });
      }
      send({ choices: [{ index: 0, delta: {}, finish_reason: calls_.length ? 'tool_calls' : 'stop' }] });
      send({ choices: [], usage });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    seen,
    close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}

/** A port nothing is listening on right now. */
export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}
