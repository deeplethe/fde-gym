/**
 * A turn of the coding agent as the page follows it: the turn's events (server/agent.ts, LiveEvent),
 * folded into what the panel shows while it runs. The fold is a plain function of the events, so a
 * page that comes to a turn late, or loses its stream and picks it up again, ends up where one that
 * watched from the start is: it hears the turn from the start, or from the last event it had.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEnd, AgentItem, AgentSpend } from '../../server/agent';

type Tool = Extract<AgentItem, { kind: 'tool' }>;

export interface LiveTurn {
  id: string;
  /** The learner's message the turn carries out. */
  user: string;
  /** What it has done and said so far, as the record will hold it. */
  items: Exclude<AgentItem, { kind: 'user' }>[];
  /** What it is saying right now, not yet a finished piece. */
  saying: string;
  /** What it is thinking right now, and since when (on the page's clock). */
  thinking?: { text: string; since: number };
  /** How much of each tool call still being written has been written. */
  drafting: Record<string, number>;
  /** A model call that failed and is being tried again. */
  retry?: string;
  spend?: AgentSpend;
  /** When it began, on the page's clock. */
  startedAt: number;
  /** How much the model has written in this turn (words, thinking and tool calls), in characters. */
  chars: number;
  /** The last event folded in. */
  seq: number;
}

export type Wire = { at: number; data: any };

export const startTurn = (id: string, user: string, startedAt: number): LiveTurn => ({ id, user, items: [], saying: '', drafting: {}, startedAt, chars: 0, seq: 0 });

const patchTool = (t: LiveTurn, id: string, f: (it: Tool) => Tool): LiveTurn => ({ ...t, items: t.items.map((it) => (it.kind === 'tool' && it.id === id ? f(it) : it)) });

/** One event of the turn folded in. `at` is when it happened, on the page's clock. */
export function fold(t: LiveTurn, event: string, data: any, at: number, seq: number): LiveTurn {
  if (seq && seq <= t.seq) return t;
  const n = { ...t, seq: seq || t.seq };
  switch (event) {
    case 'item': {
      const item = data as AgentItem;
      if (item.kind === 'user') return { ...n, user: item.text, startedAt: at };
      return {
        ...n, items: [...n.items, item],
        // A finished piece replaces the pieces it was told in.
        saying: item.kind === 'assistant' ? '' : n.saying,
        thinking: item.kind === 'thought' ? undefined : n.thinking,
        retry: item.kind === 'tool' ? undefined : n.retry,
      };
    }
    case 'delta': return { ...n, saying: n.saying + data.text, chars: n.chars + data.text.length, retry: undefined };
    case 'think': return { ...n, thinking: { text: (n.thinking?.text ?? '') + data.text, since: n.thinking?.since ?? at }, chars: n.chars + data.text.length, retry: undefined };
    case 'drafting': return { ...n, drafting: { ...n.drafting, [data.id]: data.chars }, chars: n.chars + Math.max(0, data.chars - (n.drafting[data.id] ?? 0)) };
    case 'args': return patchTool(n, data.id, (it) => ({ ...it, args: data.args }));
    case 'output': return patchTool(n, data.id, (it) => ({ ...it, partial: data.output }));
    case 'result': {
      const { [data.id]: _, ...drafting } = n.drafting;
      return { ...patchTool(n, data.id, (it) => ({ ...it, output: data.output, failed: data.failed, ms: data.ms, patch: data.patch, partial: undefined })), drafting };
    }
    case 'retry': return { ...n, retry: data.message || 'retrying' };
    case 'spend': return { ...n, spend: data as AgentSpend };
    default: return n;
  }
}

/** What the turn is doing now, for the line under it. */
export type Activity =
  | { kind: 'thinking' }
  | { kind: 'drafting'; tool: Tool; chars: number }
  | { kind: 'running'; tool: Tool }
  | { kind: 'writing' }
  /** Between steps: the model has what came back and has not begun to say what it makes of it. */
  | { kind: 'waiting'; after?: Tool };

export function activityOf(t: LiveTurn): Activity {
  if (t.thinking) return { kind: 'thinking' };
  const last = t.items.at(-1);
  if (last?.kind === 'tool' && last.output === undefined) {
    const chars = t.drafting[last.id];
    // Still being written (its arguments are not whole until it is run, and only running prints).
    return chars !== undefined && last.partial === undefined ? { kind: 'drafting', tool: last, chars } : { kind: 'running', tool: last };
  }
  if (t.saying.trim()) return { kind: 'writing' };
  return { kind: 'waiting', after: last?.kind === 'tool' ? last : undefined };
}

export type TurnEnd = { end: AgentEnd; spend?: AgentSpend } | { error: string } | { gone: true };

const EVENTS = ['item', 'delta', 'think', 'drafting', 'args', 'output', 'result', 'retry', 'spend'];
/** Events that come close together are folded in together: one render, not one per piece of text. */
const BATCH_MS = 40;
/** A stream that keeps failing without being heard from is given up; the page asks after the turn instead. */
const MAX_FAILS = 6;

/**
 * Follow a turn: `follow(id, user, startedAt)` opens its stream from the start; the turn as it
 * stands is `live`, and `onEnd` is told how it ended (or that the stream was given up: `gone`).
 * `skew` is the site's clock less the page's, so that times from the site read on the page's clock.
 * The browser's EventSource picks up a dropped stream by itself, from the last event it had.
 */
export function useLiveTurn(runId: string, onEnd: (end: TurnEnd, turn: LiveTurn) => void) {
  const [live, setLive] = useState<LiveTurn>();
  const source = useRef<EventSource>(undefined);
  const ending = useRef(onEnd);
  ending.current = onEnd;

  const close = useCallback(() => { source.current?.close(); source.current = undefined; }, []);
  useEffect(() => close, [close]);

  const follow = useCallback((id: string, user: string, startedAt: number, skew = 0) => {
    close();
    let turn = startTurn(id, user, startedAt);
    setLive(turn);
    const es = new EventSource(`/api/sessions/${runId}/agent/events?turn=${encodeURIComponent(id)}`);
    source.current = es;
    let queue: { event: string; w: Wire; seq: number }[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fails = 0;
    const drain = () => {
      timer = undefined;
      for (const q of queue) turn = fold(turn, q.event, q.w.data, q.w.at - skew, q.seq);
      queue = [];
      if (source.current === es) setLive(turn);
    };
    const end = (how: TurnEnd) => {
      if (timer) clearTimeout(timer);
      drain();
      es.close();
      if (source.current !== es) return;
      source.current = undefined;
      ending.current(how, turn);
    };
    for (const name of EVENTS) {
      es.addEventListener(name, (e) => {
        fails = 0;
        const m = e as MessageEvent<string>;
        queue.push({ event: name, w: JSON.parse(m.data) as Wire, seq: Number(m.lastEventId) || 0 });
        timer ??= setTimeout(drain, BATCH_MS);
      });
    }
    es.addEventListener('done', (e) => { const d = (JSON.parse((e as MessageEvent<string>).data) as Wire).data; end({ end: d.end, spend: d.end === 'detached' ? undefined : d.spend }); });
    // A named `error` is the turn's own (the browser's own errors carry no data).
    es.addEventListener('error', (e) => {
      const m = e as MessageEvent<string>;
      if (typeof m.data === 'string' && m.data) { end({ error: (JSON.parse(m.data) as Wire).data.error }); return; }
      if (++fails >= MAX_FAILS || es.readyState === EventSource.CLOSED) end({ gone: true });
    });
    es.addEventListener('gone', () => end({ gone: true }));
  }, [runId, close]);

  const clear = useCallback(() => { close(); setLive(undefined); }, [close]);
  return { live, follow, clear };
}

/** Rough tokens for characters the model wrote: about four to a token. Only for the running figure; the bill counts the real ones. */
export const roughTokens = (chars: number) => Math.round(chars / 4);
