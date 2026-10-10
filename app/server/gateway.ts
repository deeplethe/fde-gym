/**
 * The way out for a runner that is on a different machine from the site (`pnpm gateway`, in app/).
 *
 * A runner has to reach the site, and when the site is across the internet that used to mean the
 * runner's container had the internet: so did every command a learner ran in it, and the code they
 * delivered. With a gateway the runner's container sits on a network that leads nowhere
 * (docker-compose.runner.yml), and this process, in a container of its own beside it, is the one
 * door: it passes on what a runner asks of its site and nothing else.
 *
 *   FDEGYM_SITE_URL   the site, e.g. https://gym.example.com (the runner is given this gateway's address instead)
 *   PORT, HOST        where to listen (default 0.0.0.0:8787)
 *
 * What is passed on: the runner's connection and its fetching of cases (/api/runner/), the model
 * relay for a run (/api/llm/v1/) and the coding agent's (/api/agent/v1/). Each of those is opened
 * by a token on the site's side; the gateway adds nothing and keeps nothing. Any other path is
 * refused, so a learner's command cannot use the gateway to browse the site, let alone the world.
 */
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const SITE = (process.env.FDEGYM_SITE_URL ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(SITE)) {
  console.error('Set FDEGYM_SITE_URL to the site this gateway leads to.');
  process.exit(1);
}
const site = new URL(SITE);
const secure = site.protocol === 'https:';
const sitePort = Number(site.port) || (secure ? 443 : 80);
const ALLOWED = /^\/api\/(runner|llm\/v1|agent\/v1)\//;
const allowed = (url: string | undefined) => ALLOWED.test((url ?? '').split('?')[0]);
/** What the site is sent: the request's own headers, addressed to the site. */
const headersFor = (req: IncomingMessage) => ({ ...req.headers, host: site.host });

const server = http.createServer((req, res) => {
  if (!allowed(req.url)) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not passed on by this gateway"}'); return; }
  const up = (secure ? https : http).request({ host: site.hostname, port: sitePort, method: req.method, path: req.url, headers: headersFor(req) }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `the site could not be reached: ${e.message}` }));
  });
  // The caller gave up (a turn was stopped, say): so does the call to the site.
  res.on('close', () => { if (!res.writableEnded) up.destroy(); });
  req.pipe(up);
});

// The runner's connection to the site is a WebSocket: passed on as the bytes it is.
server.on('upgrade', (req, socket, head) => {
  if (!allowed(req.url)) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  const up = secure ? tls.connect({ host: site.hostname, port: sitePort, servername: site.hostname }) : net.connect({ host: site.hostname, port: sitePort });
  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  for (const [k, v] of Object.entries(headersFor(req))) for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${one}`);
  up.on(secure ? 'secureConnect' : 'connect', () => {
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => { up.destroy(); socket.destroy(); };
  up.on('error', close);
  socket.on('error', close);
  up.on('close', close);
  socket.on('close', close);
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
server.listen(port, host, () => console.log(`FDE Gym gateway on http://${host}:${port}, leading to ${SITE} and nowhere else`));
