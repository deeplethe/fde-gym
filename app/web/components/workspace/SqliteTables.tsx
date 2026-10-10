/**
 * A SQLite file in the workspace, shown as what it holds: its tables on the left, the rows of the
 * one chosen on the right, a page at a time. For looking, as one looks at a CSV; anything more
 * (a join, a count by month) is a query in the terminal or a word to the agent.
 */
import { useEffect, useState } from 'react';
import type { SqliteView } from '../../../server/harness';
import { api } from '@/lib/client';
import { L, type Lang } from '@/lib/i18n';

const PAGE = 200;

export function SqliteTables({ runId, path, lang, rev }: { runId: string; path: string; lang: Lang; rev: number }) {
  const [view, setView] = useState<SqliteView>();
  const [table, setTable] = useState('');
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  // Read again when the table or the page changes, and after anything that may have written to the file.
  useEffect(() => {
    let stale = false;
    setLoading(true);
    api<SqliteView>(`/api/sessions/${runId}/sqlite?path=${encodeURIComponent(path)}&table=${encodeURIComponent(table)}&offset=${offset}`)
      .then((d) => { if (!stale) { setView(d); setError(undefined); } })
      .catch((e) => { if (!stale) setError((e as Error).message); })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [runId, path, table, offset, rev]);

  if (error && !view) return <p className="p-6 text-sm leading-relaxed text-label-2">{error}</p>;
  if (!view) return <p className="p-6 text-sm text-label-3">{L(lang, '加载中……', 'Loading…')}</p>;
  if (!view.tables.length) return <p className="p-6 text-sm text-label-3">{L(lang, '这个数据库里没有表。', 'There are no tables in this database.')}</p>;

  const total = view.total;
  const last = view.offset + view.rows.length;
  const pick = (name: string) => { setTable(name); setOffset(0); };
  const pager = 'rounded-full px-2.5 py-1 text-label-2 hover:bg-fill-3 hover:text-label-1 disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div className="flex h-full min-h-0">
      <ul className="w-44 shrink-0 overflow-y-auto border-r border-divider py-1.5">
        {view.tables.map((t) => {
          const on = t.name === view.table;
          return (
            <li key={t.name}>
              <button type="button" onClick={() => pick(t.name)} title={t.name}
                className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${on ? 'bg-fill-3 font-medium text-label-1' : 'text-label-2 hover:bg-fill-4 hover:text-label-1'}`}>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{t.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-label-3 tabular-nums">{t.kind === 'view' ? L(lang, '视图', 'view') : t.rows ?? ''}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className={`min-h-0 flex-1 overflow-auto ${loading ? 'opacity-60' : ''}`}>
          <table className="w-full text-[13px] tabular-nums">
            <thead className="sticky top-0 z-10 bg-layer-1 shadow-[0_1px_0_var(--color-divider)]">
              <tr>{view.columns.map((c) => <th key={c} className="px-3 py-2.5 text-left font-mono text-xs font-medium whitespace-nowrap text-label-3">{c}</th>)}</tr>
            </thead>
            <tbody>
              {view.rows.map((r, i) => (
                <tr key={view.offset + i} className={`transition-colors hover:bg-fill-3 ${i % 2 ? 'bg-fill-4' : ''}`}>
                  {r.map((c, j) => (
                    <td key={j} className={`max-w-[28rem] truncate px-3 py-1.5 whitespace-nowrap ${c === null ? 'text-label-4' : typeof c === 'number' ? 'text-right font-mono text-xs' : ''}`} title={typeof c === 'string' && c.length > 40 ? c : undefined}>
                      {c === null ? 'NULL' : String(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!view.rows.length && <p className="px-3 py-6 text-[13px] text-label-3">{L(lang, '这张表是空的。', 'This table is empty.')}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1 border-t border-divider px-2 py-1.5 text-xs text-label-3">
          <span className="px-1 font-mono tabular-nums">
            {view.rows.length ? `${view.offset + 1}–${last}` : '0'}{total !== null && L(lang, ` / 共 ${total} 行`, ` of ${total}`)}
          </span>
          {error && <span className="text-bad">{error}</span>}
          <span className="ml-auto flex items-center gap-0.5">
            <button type="button" className={pager} disabled={view.offset === 0 || loading} onClick={() => setOffset(Math.max(0, view.offset - PAGE))}>{L(lang, '上一页', 'Previous')}</button>
            <button type="button" className={pager} disabled={loading || (total !== null ? last >= total : view.rows.length < PAGE)} onClick={() => setOffset(view.offset + PAGE)}>{L(lang, '下一页', 'Next')}</button>
          </span>
        </div>
      </div>
    </div>
  );
}
