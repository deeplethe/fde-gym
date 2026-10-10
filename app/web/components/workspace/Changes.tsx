/**
 * What has changed in the workspace since the run began: every file the learner or their coding
 * agent added, changed or removed, each opening to its diff, and each able to be put back as it
 * was. The agent does most of the typing, so this is where the learner sees what was actually done
 * in their name, and what will go to production when they hand over (everything under system/).
 */
import { useCallback, useEffect, useState } from 'react';
import type { Change } from '../../../server/harness';
import { api } from '@/lib/client';
import { L, type Lang } from '@/lib/i18n';

export type ChangeList = { known: boolean; changes: Change[] };
export const loadChanges = (runId: string) => api<ChangeList>(`/api/sessions/${runId}/changes`);

/** How much a file changed, as +added −removed. */
export function Counts({ c }: { c: Change }) {
  if (c.added === null || c.removed === null) return <span className="text-label-3">{c.status === 'modified' ? '±' : ''}</span>;
  return (
    <span className="font-mono text-[11px] tabular-nums">
      {c.added > 0 && <span className="text-ok">+{c.added}</span>}
      {c.added > 0 && c.removed > 0 && ' '}
      {c.removed > 0 && <span className="text-bad">−{c.removed}</span>}
    </span>
  );
}

const MARK = { added: ['新', 'A', 'text-ok'], modified: ['改', 'M', 'text-warn-text'], deleted: ['删', 'D', 'text-bad'] } as const;

function Diff({ runId, path, lang }: { runId: string; path: string; lang: Lang }) {
  const [d, setD] = useState<{ diff: string; truncated: boolean; binary: boolean }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api<{ diff: string; truncated: boolean; binary: boolean }>(`/api/sessions/${runId}/diff?path=${encodeURIComponent(path)}`).then(setD).catch((e) => setError((e as Error).message));
  }, [runId, path]);
  if (error) return <p className="px-3 py-2 text-xs text-bad">{error}</p>;
  if (!d) return <p className="px-3 py-2 text-xs text-label-3">{L(lang, '加载中……', 'Loading…')}</p>;
  if (d.binary) return <p className="px-3 py-2 text-xs text-label-3">{L(lang, '不是文本文件，无法对比。', 'Not a text file: nothing to compare line by line.')}</p>;
  // The two header lines name the file, which the row above already does.
  const rows = d.diff.split('\n').slice(2).filter((l, i, a) => l !== '' || i < a.length - 1);
  return (
    <pre className="max-h-96 overflow-auto bg-fill-4 py-1.5 font-mono text-xs leading-[1.55]">
      {rows.map((l, i) => (
        <div key={i} className={`px-3 whitespace-pre-wrap break-all ${l.startsWith('+') ? 'bg-ok/10 text-label-1' : l.startsWith('-') ? 'bg-bad/10 text-label-1' : l.startsWith('@@') ? 'text-label-3' : 'text-label-2'}`}>{l || ' '}</div>
      ))}
      {d.truncated && <div className="px-3 text-label-3">{L(lang, '……改动太长，只显示开头。', '… too long: only the start is shown.')}</div>}
    </pre>
  );
}

export function Changes({ runId, lang, rev, active, readOnly, onChanged, onCount }: { runId: string; lang: Lang; rev: number; active: boolean; readOnly: boolean; onChanged: () => void; onCount: (n: number) => void }) {
  const [list, setList] = useState<ChangeList>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const load = useCallback(() => loadChanges(runId).then((d) => { setList(d); setError(undefined); onCount(d.changes.length); }).catch((e) => setError((e as Error).message)), [runId, onCount]);
  // Read again after anything that may have changed a file, and whenever the tab is turned to (a save in the editor is not announced).
  useEffect(() => { void load(); }, [load, rev, active]);

  async function revert(c: Change) {
    const what = c.status === 'added' ? L(lang, `删除 ${c.path}？它是这次练习里新建的。`, `Remove ${c.path}? It was created in this run.`) : L(lang, `把 ${c.path} 还原成进场时的样子？你和 agent 对它的改动都会丢掉。`, `Put ${c.path} back as it was when the run began? Every change to it, yours and the agent's, is lost.`);
    if (!window.confirm(what)) return;
    setBusy(c.path);
    try { await api(`/api/sessions/${runId}/revert`, { method: 'POST', json: { path: c.path } }); if (open === c.path) setOpen(undefined); onChanged(); await load(); }
    catch (e) { setError((e as Error).message); }
    setBusy(undefined);
  }

  if (error && !list) return <p className="px-4 py-4 text-[13px] text-bad">{error}</p>;
  if (!list) return <p className="px-4 py-4 text-[13px] text-label-3">{L(lang, '加载中……', 'Loading…')}</p>;
  if (!list.known) return <p className="px-4 py-4 text-[13px] leading-relaxed text-label-3">{L(lang, '这次练习开始得早，没有留下进场时的文件，所以看不到改动。新开的练习都有。', 'This run began before a copy of the files as built was kept, so its changes cannot be shown. New runs have one.')}</p>;
  if (!list.changes.length) return <p className="px-4 py-4 text-[13px] leading-relaxed text-label-3">{L(lang, '还没有任何改动：工作区和进场时一样。', 'Nothing has changed yet: the workspace is as it was when the run began.')}</p>;

  const shipped = list.changes.filter((c) => c.path.startsWith('system/')).length;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <p className="px-3 pt-2.5 pb-1.5 text-xs leading-relaxed text-label-3">
        {L(lang, `和进场时相比改了 ${list.changes.length} 个文件，其中 ${shipped} 个在 system/ 下，会随提交上线。`, `${list.changes.length} file${list.changes.length === 1 ? '' : 's'} differ from when the run began; ${shipped} of them under system/, which is what goes to production.`)}
      </p>
      {error && <p className="px-3 pb-1.5 text-xs text-bad">{error}</p>}
      <ul>
        {list.changes.map((c) => {
          const [zh, en, tone] = MARK[c.status];
          const on = open === c.path;
          return (
            <li key={c.path} className="border-t border-divider first:border-t-0">
              <div className="group flex items-center gap-2 px-3 py-1.5 hover:bg-fill-4">
                <button type="button" onClick={() => setOpen(on ? undefined : c.path)} aria-expanded={on} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <span className={`w-4 shrink-0 text-center text-[11px] font-semibold ${tone}`}>{L(lang, zh, en)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={c.path}>{c.path}</span>
                  <Counts c={c} />
                </button>
                {!readOnly && (
                  <button type="button" disabled={busy === c.path} onClick={() => void revert(c)}
                    className="shrink-0 rounded-full px-2 py-0.5 text-[11px] text-label-3 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-fill-2 hover:text-label-1 focus-visible:opacity-100 disabled:opacity-50">
                    {c.status === 'added' ? L(lang, '删除', 'Remove') : L(lang, '还原', 'Put back')}
                  </button>
                )}
              </div>
              {on && <Diff runId={runId} path={c.path} lang={lang} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
