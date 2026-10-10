import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentItem } from '../../../server/agent';
import { api, postEvents } from '@/lib/client';
import { L, type Lang } from '@/lib/i18n';
import { Markdown } from '../Markdown';

import type { View } from './types';

type Tool = Extract<AgentItem, { kind: 'tool' }>;
/** What the agent does on the way to an answer: the tools it uses, and what it says between them. */
type Step = Exclude<AgentItem, { kind: 'user' }>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');
/** A tool call that came back with an error, was refused, or ran a command that exited non-zero. (Conversations from before the agent was pi carry no flag; their output says it.) */
const stepFailed = (item: Tool) => item.failed ?? (!!item.output && (/^error:|^Not run:/.test(item.output) || /\[exit (?!0\])[^\]]+\]\s*$/.test(item.output)));

/** One line for what a tool call does; the full output opens underneath. */
function ToolStep({ item, lang, running }: { item: Tool; lang: Lang; running: boolean }) {
  const [open, setOpen] = useState(false);
  const a = item.args;
  // pi's tools (bash, read, write, edit); the longer names are the earlier agent's, in older conversations.
  const kind = ({ bash: 'run', run_command: 'run', read: 'read', read_file: 'read', write: 'write', write_file: 'write', edit: 'edit', edit_file: 'edit', list_files: 'list' } as Record<string, string>)[item.name];
  const [verb, what] =
    kind === 'run' ? ['$', s(a.command)]
    : kind === 'read' ? [L(lang, '读', 'read'), s(a.path) + (a.offset ? `:${a.offset}` : '')]
    : kind === 'write' ? [L(lang, '写', 'write'), s(a.path)]
    : kind === 'edit' ? [L(lang, '改', 'edit'), s(a.path)]
    : kind === 'list' ? [L(lang, '列出文件', 'list files'), '']
    : [item.name, ''];
  const failed = stepFailed(item);
  // An edit is one replacement or several: what goes out, then what comes in.
  const edits = Array.isArray(a.edits) ? a.edits as Record<string, unknown>[] : [{ oldText: a.old_text ?? a.oldText, newText: a.new_text ?? a.newText }];
  const detail = kind === 'edit' ? `${edits.map((e) => `- ${s(e.oldText)}\n+ ${s(e.newText)}`).join('\n\n')}\n\n${item.output ?? ''}`
    : kind === 'write' ? `${s(a.content)}\n\n${item.output ?? ''}` : item.output ?? item.partial ?? '';
  return (
    <div className="font-mono text-xs">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left hover:bg-fill-4">
        {/* A word (读, write) is set in the page's own face; only the prompt sign and what follows are code. */}
        <span className={`shrink-0 ${verb === '$' ? '' : 'font-sans'} ${failed ? 'text-bad' : 'text-label-3'}`}>{verb}</span>
        <span className={`min-w-0 flex-1 ${open ? 'break-all whitespace-pre-wrap' : 'truncate'} text-label-2`}>{what}</span>
        {running && item.output === undefined
          ? <span className="size-3 shrink-0 animate-spin rounded-full border border-fill-1 border-t-label-3" />
          : <Chevron open={open} />}
      </button>
      {open && detail && <pre className="mx-2 mt-1 mb-2 max-h-72 overflow-auto rounded-md bg-fill-4 px-3 py-2 break-all whitespace-pre-wrap text-label-2">{detail}</pre>}
    </div>
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 12 12" aria-hidden className={`mt-0.5 size-3 shrink-0 text-label-4 transition-transform ${open ? 'rotate-90' : ''}`}><path d="M4.5 3 7.5 6 4.5 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

const one = (it: Step, lang: Lang, running: boolean, key: string | number) => (
  it.kind === 'tool' ? <ToolStep key={key} item={it} lang={lang} running={running} />
  // What it says on the way is part of the work, so it is set quieter than an answer.
  : <p key={key} className="px-2 py-1 text-xs leading-relaxed whitespace-pre-wrap text-label-2">{it.text}</p>
);

/**
 * The work of one turn, folded. A turn can take a dozen steps, and the learner wants the answer,
 * not the scroll: so the steps are one line that says how many there were (and whether any went
 * wrong), which opens to all of them. While the turn is still going, the step it is on now stays
 * in view under that line.
 */
function Work({ steps, live, lang }: { steps: Step[]; live: boolean; lang: Lang }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  // The step being done now is shown whatever happens; the ones before it are what folds.
  const now = live ? steps[steps.length - 1] : undefined;
  const past = live ? steps.slice(0, -1) : steps;
  const failed = past.filter((x) => x.kind === 'tool' && stepFailed(x)).length;
  const n = past.filter((x) => x.kind === 'tool').length;
  return (
    <div>
      {past.length > 0 && n > 0 && (
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-label-3 hover:bg-fill-4 hover:text-label-2">
          <Chevron open={open} />
          <span>{live ? L(lang, `已做 ${n} 步`, `${n} step${n === 1 ? '' : 's'} so far`) : L(lang, `${n} 步操作`, `${n} step${n === 1 ? '' : 's'}`)}</span>
          {failed > 0 && <span className="text-bad">{L(lang, `· ${failed} 步出错`, `· ${failed} failed`)}</span>}
        </button>
      )}
      {/* With no tool among them there is nothing to fold: what was said is simply shown. */}
      {(open || n === 0) && past.length > 0 && <div className={n > 0 ? 'mt-0.5 ml-2 border-l border-divider pl-1.5' : ''}>{past.map((it, i) => one(it, lang, false, i))}</div>}
      {now && one(now, lang, true, 'now')}
    </div>
  );
}

/**
 * What was said since the last message from the learner, split into the work and the answer. The
 * answer is what the agent says after its last tool.
 */
function turns(items: AgentItem[], busy: boolean) {
  const out: { user?: string; steps: Step[]; answer: string[]; live: boolean }[] = [];
  for (const it of items) {
    if (it.kind === 'user' || !out.length) out.push({ steps: [], answer: [], live: false });
    const t = out[out.length - 1];
    if (it.kind === 'user') t.user = it.text; else t.steps.push(it);
  }
  out.forEach((t, i) => {
    t.live = busy && i === out.length - 1;
    // In a turn still going, what it said last may yet turn out to be a remark on the way; it is shown as the answer until then.
    while (t.steps.length && t.steps[t.steps.length - 1].kind === 'assistant') t.answer.unshift((t.steps.pop() as { text: string }).text);
  });
  return out;
}

const count = (n: number) => (n < 1000 ? String(n) : n < 999_500 ? `${(n / 1000).toFixed(n < 99_950 ? 1 : 0).replace(/\.0$/, '')}k` : `${(n / 1e6).toFixed(n < 99_950_000 ? 1 : 0).replace(/\.0$/, '')}M`);
const usd = (n: number) => (n > 0 && n < 0.001 ? '<$0.001' : `$${n === 0 ? '0' : n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`);
const tone = (part: number) => (part >= 0.95 ? 'text-bad' : part >= 0.8 ? 'text-warn' : 'text-brand');

/**
 * A small ring in the corner under the box: how full the model's window is with this conversation.
 * It opens to the figures behind it and to the other thing that runs out, what the run may spend.
 */
function Usage({ spend, maxUsd, window: size, model, lang }: { spend: View['agent']['spend']; maxUsd: number; window: number; model: string | null; lang: Lang }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', away, true);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', away, true); window.removeEventListener('keydown', esc); };
  }, [open]);

  const held = Math.min(1, spend.context / size);
  const spent = Math.min(1, spend.usd / maxUsd);
  // The ring is the window; it takes the colour of whichever of the two is nearer its end.
  const R = 6.5, AROUND = 2 * Math.PI * R;
  const row = (label: string, figure: string, part: number, under: string) => (
    <div className="px-2 py-2">
      <p className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-label-1">{label}</span>
        <span className="font-mono text-xs text-label-2 tabular-nums">{figure} <span className="text-label-3">({Math.round(part * 100)}%)</span></span>
      </p>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-fill-2"><div className={`h-full rounded-full bg-current ${tone(part)}`} style={{ width: `${part * 100}%` }} /></div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-label-3">{under}</p>
    </div>
  );
  return (
    <div ref={box} className="relative shrink-0">
      <button type="button" onClick={() => setOpen((x) => !x)} aria-expanded={open}
        title={open ? undefined : L(lang, `上下文 ${Math.round(held * 100)}% · 用量 ${usd(spend.usd)} / $${maxUsd}`, `Context ${Math.round(held * 100)}% · spent ${usd(spend.usd)} of $${maxUsd}`)}
        aria-label={L(lang, 'agent 的用量', 'What the agent has used')}
        className={`grid size-6 place-items-center rounded-md transition-colors hover:bg-fill-3 ${open ? 'bg-fill-3' : ''}`}>
        <svg viewBox="0 0 16 16" aria-hidden className={`size-4 -rotate-90 ${tone(Math.max(held, spent))}`} fill="none" strokeWidth="2">
          <circle cx="8" cy="8" r={R} className="stroke-fill-1" />
          {held > 0 && <circle cx="8" cy="8" r={R} stroke="currentColor" strokeLinecap="round" strokeDasharray={`${Math.max(held * AROUND, 1)} ${AROUND}`} />}
        </svg>
      </button>
      {open && (
        <div role="dialog" className="menu absolute right-0 bottom-full z-30 mb-2 w-72 cursor-default">
          {row(L(lang, '上下文窗口', 'Context window'), `${count(spend.context)} / ${count(size)}`, held,
            L(lang, '这段对话现在占了模型一次能读的多少。快满时 agent 会自己把前面的对话压缩成摘要。', 'How much of what the model can read at once this conversation takes now. Near the end, the agent summarises the earlier part by itself.'))}
          <div className="mx-2 h-px bg-divider" />
          {row(L(lang, '这次练习的用量', 'This run’s allowance'), `${usd(spend.usd)} / $${maxUsd}`, spent,
            L(lang, 'agent 调用模型的费用，由本站承担。用完后它不再接新的消息。', 'What the agent’s model calls have cost; the site pays. Once it is used up, the agent takes no more messages.'))}
          <div className="mx-2 h-px bg-divider" />
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-2 py-2 text-xs">
            <dt className="text-label-3">{L(lang, '累计 token', 'Tokens so far')}</dt>
            <dd className="text-right font-mono text-label-2 tabular-nums">{L(lang, `读 ${count(spend.prompt)} · 写 ${count(spend.completion)}`, `${count(spend.prompt)} in · ${count(spend.completion)} out`)}</dd>
            {model && <>
              <dt className="text-label-3">{L(lang, '模型', 'Model')}</dt>
              <dd className="min-w-0 truncate text-right font-mono text-label-2" title={model}>{model}</dd>
            </>}
          </dl>
        </div>
      )}
    </div>
  );
}

/**
 * The coding agent: the learner says what they want, the agent works in the workspace and reports
 * back. What it did on the way is folded into one line per turn (see Work); each tool it used is one
 * line in there that opens to its output.
 */
export function Agent({ runId, view, lang, onChanged }: { runId: string; view: View; lang: Lang; onChanged: () => void }) {
  const [items, setItems] = useState<AgentItem[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(view.agent.busy);
  const [stopping, setStopping] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  // What the agent is saying right now, as it comes; replaced by the finished piece when that arrives.
  const [saying, setSaying] = useState('');
  // What the agent has cost this run so far; a turn's end brings the new figure.
  const [spend, setSpend] = useState(view.agent.spend);
  useEffect(() => { setSpend(view.agent.spend); }, [view.agent.spend.usd, view.agent.spend.context]); // eslint-disable-line react-hooks/exhaustive-deps
  const end = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // The turn this page started and is listening to, if there is one.
  const stream = useRef<AbortController>(undefined);

  /** Take the conversation, and whether a turn is under way, from the server. Not while this page is listening to one. */
  const sync = useCallback(async () => {
    const d = await api<{ items: AgentItem[]; busy: boolean }>(`/api/sessions/${runId}/agent`);
    if (stream.current) return true;
    setItems(d.items); setBusy(d.busy); setSaying('');
    return d.busy;
  }, [runId]);
  useEffect(() => { void sync().catch(() => undefined); }, [sync]);
  // A turn this page is not listening to (the page was reloaded, the turn was started in another
  // tab, or the line to the site dropped while it was going) is followed by asking, or the panel
  // would say "working" for ever. Asking goes on while the site cannot be reached: it may be restarting.
  const [lost, setLost] = useState(0);
  useEffect(() => {
    if (!busy || stream.current) return;
    const t = setInterval(() => { void sync().then((still) => { if (!still) onChanged(); }).catch(() => undefined); }, 1500);
    return () => clearInterval(t);
  }, [busy, sync, onChanged, lost]);
  useEffect(() => { if (!busy) setStopping(false); }, [busy]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [items, busy, saying]);

  async function send() {
    const message = draft.trim();
    if (!message || busy) return;
    const mine = stream.current = new AbortController();
    setDraft(''); setBusy(true); setError(undefined); setNote(undefined);
    setItems((x) => [...x, { kind: 'user', text: message }]);
    // Whether the turn was heard to its end. If the line drops first, pi may well still be at work.
    let heard = false;
    try {
      await postEvents(`/api/sessions/${runId}/agent`, { message }, (event, data) => {
        if (event === 'item') { setSaying(''); setItems((x) => [...x, data as AgentItem]); }
        else if (event === 'delta') setSaying((x) => x + data.text);
        else if (event === 'args') setItems((x) => x.map((it) => (it.kind === 'tool' && it.id === data.id ? { ...it, args: data.args } : it)));
        else if (event === 'output') setItems((x) => x.map((it) => (it.kind === 'tool' && it.id === data.id ? { ...it, partial: data.output } : it)));
        else if (event === 'result') {
          setItems((x) => x.map((it) => (it.kind === 'tool' && it.id === data.id ? { ...it, output: data.output, failed: data.failed } : it)));
          onChanged(); // a tool may have changed files
        } else if (event === 'done') {
          heard = data.end !== 'detached';
          if (data.spend) setSpend(data.spend);
          setNote(({
            stopped: L(lang, '已停止。', 'Stopped.'),
            steps: L(lang, '这一轮的步数用完了。说“继续”可以接着做。', 'Out of steps for this turn. Say “continue” to carry on.'),
            budget: L(lang, '这次练习的助手用量已达上限。', 'This run has used up its allowance for the agent.'),
          } as Record<string, string>)[data.end]);
        } else if (event === 'error') { heard = true; setError(data.error); }
      }, mine.signal);
    } catch (e) {
      // Refused outright (the server answered with an error) or let go of here: that is the end of it. A line that broke is not.
      if (mine.signal.aborted) heard = true;
      else if (!(e instanceof TypeError)) { heard = true; setError((e as Error).message); }
    }
    if (stream.current === mine) stream.current = undefined;
    setSaying('');
    onChanged();
    if (!heard && !mine.signal.aborted) {
      // Still "working" as far as this page knows; from here the turn is followed by asking (see above).
      setLost((n) => n + 1);
      return;
    }
    setBusy(false);
    field.current?.focus();
  }

  async function stop() {
    setStopping(true);
    const r = await api<{ stopped: boolean }>(`/api/sessions/${runId}/agent/stop`, { method: 'POST' }).catch(() => undefined);
    // Listening to a turn the server no longer has (it was restarted under us): let go of it.
    if (r && !r.stopped) { stream.current?.abort(); stream.current = undefined; }
    if (!stream.current) {
      await sync().catch(() => undefined);
      if (r?.stopped) setNote(L(lang, '已停止。', 'Stopped.'));
      onChanged();
    }
    // Otherwise the turn says so itself when it has ended (see the effect on busy).
    if (!r) setStopping(false);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The conversation keeps to a column a line of text is comfortable in, however wide the panel is. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
       <div className="mx-auto w-full max-w-[720px] space-y-2 px-3 py-3">
        {!items.length && (
          <div className="mx-auto max-w-xl px-2 py-4 text-[13px] leading-relaxed text-label-3">
            <p>{L(lang, '这是你的 coding agent。告诉它要做什么，它会在工作区里读文件、跑命令、改代码，然后向你汇报。', 'This is your coding agent. Tell it what to do; it reads files, runs commands and edits code in the workspace, then reports back.')}</p>
            <p className="mt-2">{L(lang, '它不能替你去问客户方的人，也不能启动试运行：这两件事在右边，由你决定。', 'It cannot contact the customer’s people or start a trial run for you: those are on the right, and they are your call.')}</p>
            <p className="mt-3 flex flex-wrap gap-1.5">
              {[L(lang, '读一下任务书和 system/README.md，告诉我现在的系统在做什么', 'Read the brief and system/README.md and tell me what the system does today'),
                L(lang, '看看 data/ 里有哪些表，各有多少行', 'Show me the tables in data/ and how many rows each has')].map((t) => (
                <button key={t} type="button" onClick={() => { setDraft(t); field.current?.focus(); }} className="chip rounded-full px-3 py-1 text-left text-xs text-label-2 hover:text-label-1">{t}</button>
              ))}
            </p>
          </div>
        )}
        {turns(items, busy).map((t, i) => (
          <div key={i} className="space-y-2">
            {t.user !== undefined && <p className="ml-auto w-fit max-w-[85%] rounded-2xl bg-fill-3 px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">{t.user}</p>}
            <Work steps={t.steps} live={t.live} lang={lang} />
            {t.answer.map((text, k) => <div key={k} className="px-2 text-[13px]"><Markdown>{text}</Markdown></div>)}
          </div>
        ))}
        {busy && saying.trim() && <div className="px-2 text-[13px]"><Markdown>{saying}</Markdown></div>}
        {busy && <p className="flex items-center gap-2 px-2 text-xs text-label-3"><span className="size-3 animate-spin rounded-full border border-fill-1 border-t-label-3" />{L(lang, '在做……', 'Working…')}</p>}
        {note && <p className="px-2 text-xs text-label-3">{note}</p>}
        {error && <p className="rounded-md bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>}
        {/* Room under the last thing said, so that it stands clear of the box instead of sitting on it. */}
        <div ref={end} aria-hidden className="h-28" />
       </div>
      </div>
      <div className="shrink-0 px-2.5 pb-2.5">
       <div className="mx-auto w-full max-w-[720px]">
        {/* The box and, in its corner, the one thing to do with it: send (an arrow up), or stop while a turn is going. */}
        <div className="relative">
          <textarea ref={field} value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} disabled={busy}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            placeholder={L(lang, '告诉 agent 要做什么……', 'Tell the agent what to do…')} className="field block resize-none pr-12 text-[13px]" />
          {busy ? (
            <button type="button" disabled={stopping} onClick={() => void stop()} title={stopping ? L(lang, '正在停止……', 'Stopping…') : L(lang, '停止', 'Stop')} aria-label={L(lang, '停止', 'Stop')}
              className="btn btn-secondary absolute right-2 bottom-2 grid size-8 place-items-center disabled:opacity-50">
              <span className={`size-2.5 rounded-[2px] bg-current ${stopping ? 'animate-pulse' : ''}`} />
            </button>
          ) : (
            <button type="button" disabled={!draft.trim()} onClick={() => void send()} title={L(lang, '发送（Enter）', 'Send (Enter)')} aria-label={L(lang, '发送', 'Send')}
              className="btn btn-primary absolute right-2 bottom-2 grid size-8 place-items-center disabled:cursor-not-allowed disabled:opacity-40">
              <svg viewBox="0 0 16 16" aria-hidden className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3.500M4 7.500l4-4 4 4" /></svg>
            </button>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 pr-0.5 pl-1 text-[11px] text-label-3">
          <span className="min-w-0 truncate">{L(lang, 'Enter 发送，Shift+Enter 换行', 'Enter to send, Shift+Enter for a new line')}</span>
          {view.agent.maxUsd !== null && <Usage spend={spend} maxUsd={view.agent.maxUsd} window={view.agent.contextWindow} model={view.agent.model} lang={lang} />}
        </div>
       </div>
      </div>
    </div>
  );
}
