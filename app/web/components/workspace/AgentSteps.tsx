/**
 * The agent's work on the way to an answer, as the panel shows it: a line per tool it used (what it
 * did, how long it took, whether it worked), a line per stretch of thinking, all folded per turn;
 * and, while a turn runs, one line under it that says what it is doing now.
 */
import { useEffect, useState } from 'react';
import type { AgentItem } from '../../../server/agent';
import { activityOf, roughTokens, type LiveTurn } from '@/lib/agent-stream';
import { L, type Lang } from '@/lib/i18n';

type Tool = Extract<AgentItem, { kind: 'tool' }>;
/** What the agent does on the way to an answer: the tools it uses, what it thinks, and what it says between them. */
export type Step = Exclude<AgentItem, { kind: 'user' }>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

// pi's tools (bash, read, write, edit); the longer names are the earlier agent's, in older conversations.
type Kind = 'run' | 'read' | 'write' | 'edit' | 'list';
const KIND: Record<string, Kind> = { bash: 'run', run_command: 'run', read: 'read', read_file: 'read', write: 'write', write_file: 'write', edit: 'edit', edit_file: 'edit', list_files: 'list' };
const kindOf = (item: Tool): Kind | undefined => KIND[item.name];

/** The exit code a command's output ends by saying it had, as pi's bash tool says it. */
const exitOf = (output?: string) => { const m = output && /Command exited with code (\d+)\s*$/.exec(output); return m ? Number(m[1]) : undefined; };
/** A tool call that came back with an error, was refused, or ran a command that exited non-zero. (Conversations from before the agent was pi carry no flag; their output says it.) */
export const stepFailed = (item: Tool) => item.failed ?? (!!item.output && (/^error:|^Not run:/.test(item.output) || /\[exit (?!0\])[^\]]+\]\s*$/.test(item.output)));

export const duration = (ms: number) => (ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` :ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const chars = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

/** Lines added and removed in a unified diff. */
function diffCounts(patch: string) {
  let added = 0, removed = 0;
  for (const l of patch.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) added++; else if (l.startsWith('-')) removed++;
  }
  return { added, removed };
}
/** An edit's change as a diff: from the tool's own patch, or, for conversations from before there was one, from what went out and came in. */
function editDiff(item: Tool): string {
  if (item.patch) return item.patch;
  const a = item.args;
  const edits = Array.isArray(a.edits) ? a.edits as Record<string, unknown>[] : [{ oldText: a.old_text ?? a.oldText, newText: a.new_text ?? a.newText }];
  return edits.map((e) => [...s(e.oldText).split('\n').map((l) => `-${l}`), ...s(e.newText).split('\n').map((l) => `+${l}`)].join('\n')).join('\n@@\n');
}

export const Counts = ({ added, removed }: { added: number; removed: number }) => (
  <span className="font-mono text-[11px] tabular-nums">
    {added > 0 && <span className="text-ok">+{added}</span>}
    {added > 0 && removed > 0 && ' '}
    {removed > 0 && <span className="text-bad">−{removed}</span>}
  </span>
);

export function DiffView({ patch }: { patch: string }) {
  // The header lines name the file, which the row above already does.
  const rows = patch.split('\n').filter((l) => !l.startsWith('+++') && !l.startsWith('---') && !l.startsWith('Index:') && !/^=+$/.test(l));
  return (
    <pre className="mx-2 mt-1 mb-2 max-h-80 overflow-auto rounded-md bg-fill-4 py-1.5 font-mono text-xs leading-[1.55]">
      {rows.map((l, i) => (
        <div key={i} className={`px-3 break-all whitespace-pre-wrap ${l.startsWith('+') ? 'bg-ok/10 text-label-1' : l.startsWith('-') ? 'bg-bad/10 text-label-1' : l.startsWith('@@') ? 'text-label-3' : 'text-label-2'}`}>{l || ' '}</div>
      ))}
    </pre>
  );
}

export const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 12 12" aria-hidden className={`mt-0.5 size-3 shrink-0 text-label-4 transition-transform ${open ? 'rotate-90' : ''}`}><path d="M4.5 3 7.5 6 4.5 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const Spinner = () => <span aria-hidden className="mt-0.5 size-3 shrink-0 animate-spin rounded-full border border-fill-1 border-t-label-3" />;

/** One line for what a tool call does, with how long it took and how it went; the detail opens underneath. */
export function ToolStep({ item, lang, running, drafting }: { item: Tool; lang: Lang; running: boolean; drafting?: number }) {
  const [open, setOpen] = useState(false);
  const a = item.args;
  const kind = kindOf(item);
  const [verb, what] =
    kind === 'run' ? ['$', s(a.command)]
    : kind === 'read' ? [L(lang, '读', 'read'), s(a.path) + (a.offset ? `:${a.offset}` : '')]
    : kind === 'write' ? [L(lang, '写', 'write'), s(a.path)]
    : kind === 'edit' ? [L(lang, '改', 'edit'), s(a.path)]
    : kind === 'list' ? [L(lang, '列出文件', 'list files'), '']
    : [item.name, Object.values(a).find((v) => typeof v === 'string') as string ?? ''];
  const done = item.output !== undefined;
  const failed = done && stepFailed(item);
  const exit = kind === 'run' ? exitOf(item.output) : undefined;
  const diff = kind === 'edit' ? editDiff(item) : undefined;
  const counts = diff ? diffCounts(diff) : kind === 'write' && a.content ? { added: s(a.content).split('\n').length, removed: 0 } : undefined;
  // What opens: the change for an edit, the file for a write, what came back for the rest (all of it, or what has come so far).
  const detail = kind === 'write' ? s(a.content) : item.output ?? item.partial ?? '';
  const shown = kind === 'edit' ? !!diff : !!detail;
  return (
    <div className="font-mono text-xs">
      <button type="button" onClick={() => setOpen(!open)} disabled={!shown} aria-expanded={open}
        className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left hover:bg-fill-4 disabled:cursor-default disabled:hover:bg-transparent">
        {/* A word (读, write) is set in the page's own face; only the prompt sign and what follows are code. */}
        <span className={`shrink-0 ${verb === '$' ? '' : 'font-sans'} ${failed ? 'text-bad' : 'text-label-3'}`}>{verb}</span>
        <span className={`min-w-0 flex-1 ${open ? 'break-all whitespace-pre-wrap' : 'truncate'} text-label-2`}>{what || (running && drafting !== undefined ? '…' : '')}</span>
        {counts && (counts.added > 0 || counts.removed > 0) && <Counts {...counts} />}
        {exit !== undefined && exit !== 0 && <span className="shrink-0 rounded bg-bad/10 px-1 text-[10px] text-bad">exit {exit}</span>}
        {!done && running && drafting !== undefined && <span className="shrink-0 font-sans text-[11px] text-label-4 tabular-nums">{L(lang, `${chars(drafting)} 字符`, `${chars(drafting)} chars`)}</span>}
        {done && item.ms !== undefined && <span className="shrink-0 font-sans text-[11px] text-label-4 tabular-nums">{duration(item.ms)}</span>}
        {!done && running ? <Spinner /> : shown ? <Chevron open={open} /> : <span className="size-3 shrink-0" />}
      </button>
      {open && (kind === 'edit' && diff
        ? <>{<DiffView patch={diff} />}{item.output && failed && <pre className="mx-2 mb-2 rounded-md bg-bad/10 px-3 py-2 break-all whitespace-pre-wrap text-bad">{item.output}</pre>}</>
        : detail && <pre className="mx-2 mt-1 mb-2 max-h-72 overflow-auto rounded-md bg-fill-4 px-3 py-2 break-all whitespace-pre-wrap text-label-2">{detail}</pre>)}
    </div>
  );
}

/** A stretch of the model's thinking: one quiet line that opens to what it thought. */
export function ThoughtStep({ text, ms, lang, since }: { text: string; ms?: number; lang: Lang; /** Still thinking, since then (page clock). */ since?: number }) {
  const [open, setOpen] = useState(false);
  const live = since !== undefined;
  const took = ms;
  // While it thinks, the line under the turn says so; this line is for reading along.
  const label = live
    ? L(lang, '思考过程', 'What it is thinking')
    : took !== undefined && took >= 1000 ? L(lang, `思考了 ${duration(took)}`, `Thought for ${duration(took)}`) : L(lang, '思考了一下', 'Thought briefly');
  return (
    <div className="text-xs">
      <button type="button" onClick={() => setOpen(!open)} disabled={!text} aria-expanded={open}
        className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-label-3 hover:bg-fill-4 hover:text-label-2 disabled:cursor-default disabled:hover:bg-transparent">
        <svg viewBox="0 0 16 16" aria-hidden className="mt-0.5 size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M5.5 13.5h5M6 11.5h4M8 2a4.5 4.5 0 0 0-2.5 8.2V11h5v-.8A4.5 4.5 0 0 0 8 2Z" /></svg>
        <span className="min-w-0 flex-1">{label}</span>
        {text && <Chevron open={open} />}
      </button>
      {open && text && (
        <p className="mx-2 mt-1 mb-2 max-h-72 overflow-auto border-l-2 border-divider py-0.5 pr-2 pl-3 leading-relaxed whitespace-pre-wrap text-label-3">{live ? text.slice(-6000) : text}</p>
      )}
    </div>
  );
}

const one = (it: Step, lang: Lang, running: boolean, key: string | number, drafting?: number) => (
  it.kind === 'tool' ? <ToolStep key={key} item={it} lang={lang} running={running} drafting={drafting} />
  : it.kind === 'thought' ? <ThoughtStep key={key} text={it.text} ms={it.ms} lang={lang} />
  // What it says on the way is part of the work, so it is set quieter than an answer.
  : <p key={key} className="px-2 py-1 text-xs leading-relaxed whitespace-pre-wrap text-label-2">{it.text}</p>
);

/** What a turn's work came to, in a line: commands run, files read and changed, and how many went wrong. */
function summary(steps: Step[], lang: Lang, live: boolean) {
  const tools = steps.filter((x): x is Tool => x.kind === 'tool');
  const n = (k: Kind) => tools.filter((t) => kindOf(t) === k).length;
  const runs = n('run'), reads = n('read') + n('list'), changes = n('write') + n('edit');
  const other = tools.length - runs - reads - changes;
  const parts = [
    runs && L(lang, `运行了 ${runs} 条命令`, `ran ${runs} command${runs === 1 ? '' : 's'}`),
    reads && L(lang, `读了 ${reads} 个文件`, `read ${reads} file${reads === 1 ? '' : 's'}`),
    changes && L(lang, `改了 ${changes} 处`, `made ${changes} change${changes === 1 ? '' : 's'}`),
    other && L(lang, `${other} 步其他操作`, `${other} other step${other === 1 ? '' : 's'}`),
  ].filter(Boolean) as string[];
  const text = parts.join(L(lang, '，', ', '));
  return live ? L(lang, `已${text}`, `So far: ${text}`) : lang === 'en' ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * The work of one turn, folded. A turn can take a dozen steps, and the learner wants the answer,
 * not the scroll: so the steps are one line that says what they came to (and whether any went
 * wrong), which opens to all of them. While the turn is still going, the step it is on now stays
 * in view under that line.
 */
export function Work({ steps, live, lang, drafting }: { steps: Step[]; live: boolean; lang: Lang; drafting?: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  // The step being done now is shown whatever happens; the ones before it are what folds.
  const now = live ? steps[steps.length - 1] : undefined;
  const past = live ? steps.slice(0, -1) : steps;
  const tools = past.filter((x): x is Tool => x.kind === 'tool');
  const failed = tools.filter(stepFailed).length;
  const took = tools.reduce((t, x) => t + (x.ms ?? 0), 0);
  return (
    <div>
      {past.length > 0 && tools.length > 0 && (
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-label-3 hover:bg-fill-4 hover:text-label-2">
          <Chevron open={open} />
          <span className="min-w-0 flex-1 truncate">
            {summary(past, lang, live)}
            {failed > 0 && <span className="text-bad">{L(lang, ` · ${failed} 步出错`, ` · ${failed} failed`)}</span>}
          </span>
          {!live && took >= 1000 && <span className="shrink-0 text-[11px] text-label-4 tabular-nums">{duration(took)}</span>}
        </button>
      )}
      {/* With no tool among them there is nothing to fold: what was said and thought is simply shown. */}
      {(open || tools.length === 0) && past.length > 0 && <div className={tools.length > 0 ? 'mt-0.5 ml-2 border-l border-divider pl-1.5' : ''}>{past.map((it, i) => one(it, lang, false, i))}</div>}
      {now && one(now, lang, true, 'now', now.kind === 'tool' ? drafting?.[now.id] : undefined)}
    </div>
  );
}

/** The time now, a second at a time, while `on`. */
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** In a few words, what a tool is doing (or was, `done`), for the line under the turn. */
function doing(tool: Extract<AgentItem, { kind: 'tool' }>, lang: Lang, done = false) {
  const a = tool.args;
  const kind = kindOf(tool);
  const path = s(a.path);
  const cmd = s(a.command).split('\n')[0];
  if (kind === 'run') return done ? L(lang, `跑完了 ${cmd}`, `Ran ${cmd}`) : L(lang, `正在运行 ${cmd}`, `Running ${cmd}`);
  if (kind === 'read') return done ? L(lang, `读完了 ${path}`, `Read ${path}`) : L(lang, `正在读 ${path}`, `Reading ${path}`);
  if (kind === 'write') return done ? L(lang, `写好了 ${path}`, `Wrote ${path}`) : L(lang, `正在写 ${path}`, `Writing ${path}`);
  if (kind === 'edit') return done ? L(lang, `改好了 ${path}`, `Edited ${path}`) : L(lang, `正在改 ${path}`, `Editing ${path}`);
  return done ? L(lang, `用完了 ${tool.name}`, `Used ${tool.name}`) : L(lang, `正在用 ${tool.name}`, `Using ${tool.name}`);
}

/**
 * The one line under a turn that is still going: a mark that moves differently for each thing the
 * agent can be doing, what it is doing in words, how long the turn has taken, and about how much
 * the model has written. A model call being tried again is said here too.
 */
export function TurnStatus({ live, lang }: { live: LiveTurn; lang: Lang }) {
  const now = useNow(true);
  const act = activityOf(live);
  const label =
    act.kind === 'thinking' ? L(lang, '思考中', 'Thinking')
    : act.kind === 'drafting' ? `${doing(act.tool, lang)}${L(lang, ` · 已写 ${chars(act.chars)} 字符`, ` · ${chars(act.chars)} chars so far`)}`
    : act.kind === 'running' ? doing(act.tool, lang)
    : act.kind === 'writing' ? L(lang, '正在回复', 'Replying')
    // Waiting for the model after a step: what was just done, not a guess at what it is doing.
    : act.after ? `${doing(act.after, lang, true)}${L(lang, '，正在看结果', '; looking at what came back')}`
    : L(lang, '正在想怎么做', 'Working out what to do');
  const glyph = act.kind === 'drafting' ? 'writing' : act.kind;
  const elapsed = Math.max(0, now - live.startedAt);
  const tokens = roughTokens(live.chars);
  return (
    <div className="px-2" aria-live="polite">
      <p className="flex items-center gap-2 text-xs text-label-3">
        <span className="status-glyph shrink-0" data-activity={glyph} aria-hidden><i /><i /><i /></span>
        <span className="status-shimmer min-w-0 truncate">{label}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-label-4 tabular-nums">
          {elapsed >= 1000 && <span>{duration(elapsed)}</span>}
          {tokens > 0 && <span title={L(lang, '模型这一轮写了大约多少 token（估算）', 'About how many tokens the model has written this turn (an estimate)')}>↓ {tokens < 1000 ? tokens : `${(tokens / 1000).toFixed(1)}k`}</span>}
        </span>
      </p>
      {live.retry && <p className="mt-1 pl-6 text-[11px] text-warn-text">{L(lang, `模型调用失败，正在重试：${live.retry}`, `The model call failed; trying again: ${live.retry}`)}</p>}
    </div>
  );
}
