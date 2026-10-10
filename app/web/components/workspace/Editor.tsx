import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { getIndentUnit, HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { api } from '@/lib/client';
import { L, type Lang } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { CsvTable, Markdown } from '../Markdown';
import { Cross, tabClass } from '../ui';
import { SqliteTables } from './SqliteTables';
import { basename, locked } from './types';

interface Buffer { text: string; saved: string; binary: boolean; truncated: boolean; bytes: number }

const LANGUAGES: [RegExp, () => ReturnType<typeof python> | ReturnType<typeof StreamLanguage.define>][] = [
  [/\.py$/, python], [/\.jsonl?$/, json], [/\.md$/, markdown], [/\.sql$/, sql], [/\.ya?ml$/, yaml],
  [/\.(sh|bash)$|(^|\/)(Makefile|\.env[^/]*)$/, () => StreamLanguage.define(shell)], [/\.(toml|ini|cfg)$/, () => StreamLanguage.define(toml)],
];
// Python is written four spaces to a level; the rest keep the editor's two.
const languageOf = (path: string) => { const found = LANGUAGES.find(([re]) => re.test(path)); return found ? [found[1](), ...(/\.py$/.test(path) ? [indentUnit.of('    ')] : [])] : []; };
/**
 * The editor in the page's own colours, the same few the rendered Markdown uses for code (--syn-*
 * in styles.css), so that a file reads alike in both and in either theme. The editor's stock
 * schemes are not used: the light one on a dark page is where red strings came from.
 */
const SYNTAX = syntaxHighlighting(HighlightStyle.define([
  { tag: [t.comment, t.meta], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.bool, t.null, t.atom, t.typeName, t.tagName, t.self], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.inserted, t.escape], color: 'var(--syn-string)' },
  { tag: [t.number, t.deleted], color: 'var(--syn-number)' },
  { tag: [t.propertyName, t.attributeName, t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName), t.className, t.labelName], color: 'var(--syn-name)' },
  { tag: t.heading, fontWeight: '600', color: 'var(--color-label-1)' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--color-link)' },
  { tag: t.invalid, color: 'var(--color-bad)' },
]));
const look = (dark: boolean) => EditorView.theme({
  '&': { color: 'var(--color-label-1)', backgroundColor: 'transparent' },
  '.cm-content': { caretColor: 'var(--color-label-1)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-label-1)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--color-fill-1)' },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--color-fill-2)', outline: 'none' },
  '.cm-selectionMatch, .cm-searchMatch': { backgroundColor: 'var(--color-brand-soft)' },
  '.cm-tooltip, .cm-panels': { backgroundColor: 'var(--glass-thick)', color: 'var(--color-label-1)', border: '1px solid var(--color-border)', borderRadius: '8px' },
}, { dark });
/**
 * Indentation made visible: a hairline down the left of every level a line is indented by, so that
 * what belongs to which block can be read at a glance (in Python the indentation is the structure).
 * Each line is told how many levels it has; the lines themselves are drawn in CSS (.cm-guides). An
 * empty line inside a block carries the block's lines through it.
 */
function guideLines(view: EditorView): DecorationSet {
  const { state } = view;
  const unit = getIndentUnit(state), tab = state.tabSize;
  const marks = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const lines: { from: number; columns: number }[] = [];
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      const lead = /^[ \t]*/.exec(line.text)![0];
      let columns = 0;
      for (const ch of lead) columns += ch === '\t' ? tab - (columns % tab) : 1;
      // -1: nothing on the line but space, to be settled from the lines around it.
      lines.push({ from: line.from, columns: lead.length === line.text.length ? -1 : columns });
      pos = line.to + 1;
    }
    lines.forEach((l, i) => {
      let columns = l.columns;
      if (columns < 0) {
        const before = lines.slice(0, i).reverse().find((x) => x.columns >= 0)?.columns ?? 0;
        const after = lines.slice(i + 1).find((x) => x.columns >= 0)?.columns ?? 0;
        columns = Math.min(before, after);
      }
      const levels = Math.ceil(columns / unit);
      if (levels > 0) marks.add(l.from, l.from, Decoration.line({ class: 'cm-guides', attributes: { style: `--guides:${levels};--unit:${unit}` } }));
    });
  }
  return marks.finish();
}
const guides = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = guideLines(view); }
  update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = guideLines(u.view); }
}, { decorations: (v) => v.decorations });

const LOOKS = { light: [look(false), SYNTAX, guides], dark: [look(true), SYNTAX, guides] };
const isSqlite = (path: string) => /\.(db|sqlite3?)$/.test(path);
const CSV_VIEW_MAX = 300_000;

/**
 * Open files as tabs over one code editor. Markdown and CSV open rendered, with a switch to the
 * source. ⌘S / Ctrl+S saves. `rev` changes when something else may have written to the workspace
 * (a command finished): files without unsaved edits are read again.
 */
export function Editor({ runId, lang, open, active, readOnly, rev, onSelect, onClose, onDirty, onSaved }: {
  runId: string; lang: Lang; open: string[]; active?: string; readOnly: boolean; rev: number;
  onSelect: (path: string) => void; onClose: (path: string) => void;
  onDirty: (paths: Set<string>) => void; onSaved: () => void;
}) {
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [source, setSource] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const { theme } = useTheme();
  const live = useRef(buffers);
  live.current = buffers;

  const fetchFile = useCallback((path: string) => {
    api<{ content: string; binary: boolean; truncated: boolean; bytes: number }>(`/api/sessions/${runId}/file?path=${encodeURIComponent(path)}`)
      .then((d) => {
        setBuffers((b) => (b[path] && b[path].text !== b[path].saved ? b : { ...b, [path]: { text: d.content, saved: d.content, binary: d.binary, truncated: d.truncated, bytes: d.bytes } }));
        setErrors(({ [path]: _gone, ...rest }) => rest);
      })
      .catch((e) => setErrors((x) => ({ ...x, [path]: (e as Error).message })));
  }, [runId]);

  // Load newly opened files; forget closed ones.
  useEffect(() => {
    for (const p of open) if (!live.current[p]) fetchFile(p);
    setBuffers((b) => (Object.keys(b).every((p) => open.includes(p)) ? b : Object.fromEntries(Object.entries(b).filter(([p]) => open.includes(p)))));
  }, [open, fetchFile]);
  // A command may have changed files on disk.
  useEffect(() => { if (rev) for (const p of open) fetchFile(p); }, [rev]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { onDirty(new Set(Object.entries(buffers).filter(([, b]) => b.text !== b.saved).map(([p]) => p))); }, [buffers]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async (path: string) => {
    const b = live.current[path];
    if (!b || b.text === b.saved || readOnly || locked(path)) return;
    setSaving(true);
    try {
      await api(`/api/sessions/${runId}/file`, { method: 'PUT', json: { path, content: b.text } });
      setBuffers((x) => (x[path] ? { ...x, [path]: { ...x[path], saved: b.text } } : x));
      setErrors(({ [path]: _gone, ...rest }) => rest);
      onSaved();
    } catch (e) { setErrors((x) => ({ ...x, [path]: (e as Error).message })); }
    setSaving(false);
  }, [runId, readOnly, onSaved]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (active) void save(active); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, save]);

  // The row of tabs scrolls sideways when there are more than fit. Which ones are not wholly in view
  // is counted beside it ("+3"), and that count opens to their names.
  const strip = useRef<HTMLDivElement>(null);
  const [beyond, setBeyond] = useState<{ paths: string[]; left: boolean; right: boolean }>({ paths: [], left: false, right: false });
  const [more, setMore] = useState(false);
  const moreBox = useRef<HTMLDivElement>(null);
  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const paths = [...el.children].filter((t) => {
      const h = t as HTMLElement;
      return h.offsetLeft < el.scrollLeft - 1 || h.offsetLeft + h.offsetWidth > el.scrollLeft + el.clientWidth + 1;
    }).map((t) => (t as HTMLElement).dataset.tab ?? '');
    const next = { paths, left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 };
    setBeyond((was) => (was.left === next.left && was.right === next.right && was.paths.join('\n') === paths.join('\n') ? was : next));
  }, []);
  // The tab being looked at is brought into view, whichever way it was chosen and whenever the row changes width.
  const shown = useRef(active);
  shown.current = active;
  const settle = useCallback(() => {
    const el = strip.current;
    const tab = el && ([...el.children] as HTMLElement[]).find((t) => t.dataset.tab === shown.current);
    if (el && tab) {
      if (tab.offsetLeft < el.scrollLeft) el.scrollLeft = tab.offsetLeft - 6;
      else if (tab.offsetLeft + tab.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = tab.offsetLeft + tab.offsetWidth - el.clientWidth + 6;
    }
    measure();
  }, [measure]);
  useLayoutEffect(settle, [open, active, settle]);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const watch = new ResizeObserver(settle);
    watch.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => { watch.disconnect(); el.removeEventListener('scroll', measure); };
  }, [measure, settle]);
  useEffect(() => { if (!beyond.paths.length) setMore(false); }, [beyond.paths.length]);
  useEffect(() => {
    if (!more) return;
    const away = (e: Event) => { if (!moreBox.current?.contains(e.target as Node)) setMore(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMore(false); };
    window.addEventListener('mousedown', away, true);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', away, true); window.removeEventListener('keydown', esc); };
  }, [more]);
  const isDirty = (p: string) => !!buffers[p] && buffers[p].text !== buffers[p].saved;
  // Names running off an end fade out there instead of being cut.
  const fade = beyond.left || beyond.right
    ? `linear-gradient(to right, ${beyond.left ? 'transparent, #000 28px' : '#000'}, ${beyond.right ? '#000 calc(100% - 28px), transparent' : '#000'})`
    : undefined;

  const b = active ? buffers[active] : undefined;
  const fixed = !active || readOnly || locked(active) || !!b?.truncated;
  const renders = !!active && (active.endsWith('.md') || (active.endsWith('.csv') && (b?.bytes ?? 0) <= CSV_VIEW_MAX));
  // Notes the learner writes open as source; everything else that renders opens rendered.
  const showSource = !!active && (source[active] ?? active.startsWith('deliverables/'));
  const dirty = !!b && b.text !== b.saved;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-stretch border-b border-divider bg-fill-4">
        <div ref={strip} className="no-scrollbar relative flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1.5" style={{ maskImage: fade, WebkitMaskImage: fade }}>
          {open.map((p) => {
            const on = p === active;
            const d = isDirty(p);
            return (
              <div key={p} data-tab={p} className={`group ${tabClass(on, 'sm')} gap-0 pr-1`}>
                <button type="button" onClick={() => onSelect(p)} title={p} className="font-mono text-xs">{basename(p)}</button>
                <button type="button" onClick={() => onClose(p)} aria-label={L(lang, '关闭', 'Close')}
                  className="ml-1 grid size-5 place-items-center rounded-full text-label-3 hover:bg-fill-2 hover:text-label-1">
                  {d ? <span className="size-1.5 rounded-full bg-warn group-hover:hidden" /> : null}
                  <span className={d ? 'hidden group-hover:inline' : ''}><Cross className="size-2.5" /></span>
                </button>
              </div>
            );
          })}
        </div>
        {beyond.paths.length > 0 && (
          <div ref={moreBox} className="relative flex shrink-0 items-center pr-1.5 pl-0.5">
            <button type="button" onClick={() => setMore((x) => !x)} aria-expanded={more}
              title={L(lang, `还有 ${beyond.paths.length} 个打开的文件没显示全`, `${beyond.paths.length} more open files out of view`)}
              className={`rounded-md px-1.5 py-1 font-mono text-xs tabular-nums transition-colors hover:bg-fill-3 hover:text-label-1 ${more ? 'bg-fill-3 text-label-1' : 'text-label-2'}`}>
              +{beyond.paths.length}
            </button>
            {more && (
              <div role="menu" className="menu absolute top-full right-1 z-30 mt-1 max-h-80 max-w-80 min-w-52 overflow-y-auto">
                {beyond.paths.map((p) => (
                  <button key={p} type="button" role="menuitem" title={p} onClick={() => { setMore(false); onSelect(p); }}
                    className="flex w-full items-baseline gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-fill-3">
                    <span className="min-w-0 truncate font-mono text-xs text-label-1">{basename(p)}</span>
                    {p.includes('/') && <span className="min-w-0 flex-1 truncate text-[11px] text-label-3">{p.slice(0, p.lastIndexOf('/'))}</span>}
                    {isDirty(p) && <span className="ml-auto size-1.5 shrink-0 self-center rounded-full bg-warn" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {/* What can be done with the file in view stands apart from the row of files, behind a rule. */}
        {active && b && !b.binary && (renders || !fixed) && (
          <div className="flex shrink-0 items-center gap-2 border-l border-fill-1 px-2 text-xs">
            {renders && (
              <button type="button" onClick={() => setSource((s) => ({ ...s, [active]: !showSource }))} className="rounded-md px-2 py-1 text-label-2 hover:bg-fill-3 hover:text-label-1">
                {showSource ? L(lang, '预览', 'Preview') : fixed ? L(lang, '源文件', 'Source') : L(lang, '编辑', 'Edit')}
              </button>
            )}
            {!fixed && (
              <button type="button" disabled={!dirty || saving} onClick={() => void save(active)}
                className="rounded-md bg-brand px-2.5 py-1 font-medium text-on-brand transition-colors hover:bg-brand-hover disabled:bg-fill-3 disabled:text-label-3">
                {saving ? L(lang, '保存中…', 'Saving…') : dirty ? L(lang, '保存', 'Save') : L(lang, '已保存', 'Saved')}
              </button>
            )}
          </div>
        )}
      </div>

      {active && errors[active] && <p className="shrink-0 border-b border-divider bg-bad/10 px-3 py-1.5 text-xs text-bad">{errors[active]}</p>}
      {b?.truncated && <p className="shrink-0 border-b border-divider bg-fill-4 px-3 py-1.5 text-xs text-label-2">{L(lang, '文件太大，这里只显示开头 1 MB，不能在这里编辑。用终端处理它。', 'Large file: only the first 1 MB is shown and it cannot be edited here. Work on it from the terminal.')}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        {!active ? (
          <p className="grid h-full place-items-center px-6 text-center text-sm text-label-3">{L(lang, '从左边打开一个文件。', 'Open a file from the left.')}</p>
        ) : !b ? (
          <p className="p-6 text-sm text-label-3">{errors[active] ? '' : L(lang, '加载中……', 'Loading…')}</p>
        ) : b.binary && isSqlite(active) ? (
          <SqliteTables runId={runId} path={active} lang={lang} rev={rev} />
        ) : b.binary ? (
          <div className="p-6 text-sm leading-relaxed text-label-2">
            <p>{L(lang, '这是二进制文件，不能在这里查看。', 'This is a binary file and cannot be shown here.')}</p>
            {/\.(db|sqlite3?)$/.test(active) && (
              <p className="mt-2">{L(lang, '它是 SQLite 数据库，可以在终端里查：', 'It is a SQLite database; query it from the terminal:')} <code className="rounded bg-fill-3 px-1.5 py-0.5 font-mono text-xs text-label-1">sqlite3 {active} .tables</code></p>
            )}
          </div>
        ) : renders && !showSource ? (
          active.endsWith('.csv') ? <CsvTable text={b.text} /> : <div className="mx-auto max-w-3xl p-6"><Markdown>{b.text}</Markdown></div>
        ) : (
          <CodeMirror
            key={active} value={b.text} height="100%" theme="none" readOnly={fixed} editable={!fixed} extensions={[...LOOKS[theme === 'dark' ? 'dark' : 'light'], ...languageOf(active)]}
            basicSetup={{ foldGutter: false, highlightActiveLine: !fixed }}
            onChange={(text) => setBuffers((x) => (x[active] ? { ...x, [active]: { ...x[active], text } } : x))}
          />
        )}
      </div>
    </div>
  );
}
