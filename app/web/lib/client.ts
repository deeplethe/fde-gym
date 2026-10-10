/** Small JSON fetch helper for the workspace: throws the server's error message. */
export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    headers: { ...(init?.headers as Record<string, string> | undefined), ...(init?.json !== undefined ? { 'content-type': 'application/json' } : {}) },
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

/**
 * POST that answers with server-sent events: `onEvent` gets each event's name and JSON data.
 * Errors before the stream starts are thrown like api()'s.
 */
export async function postEvents(url: string, json: unknown, onEvent: (event: string, data: any) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(json), headers: { 'content-type': 'application/json' }, cache: 'no-store', signal });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      let event = 'message';
      let data = '';
      for (const line of buf.slice(0, i).split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trimStart();
      }
      buf = buf.slice(i + 2);
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

/** Count questions in a message the way the personas do (they hear only the first of 3+). */
export const countQuestions = (s: string) => (s.match(/[?？]/g) ?? []).length;
