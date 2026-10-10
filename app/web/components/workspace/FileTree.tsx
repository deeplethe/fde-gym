import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { L, type Lang } from '@/lib/i18n';
import { Cross, Plus } from '../ui';
import { basename, dirname, locked, type View } from './types';

/** Marks what is the customer's to keep as it is: read it, do not change it. */
function Lock({ lang }: { lang: Lang }) {
  const label = L(lang, '只读', 'Read-only');
  return (
    <span title={label} aria-label={label} role="img" className="grid size-5 shrink-0 place-items-center text-label-4">
      <svg viewBox="0 0 12 12" aria-hidden className="size-3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.5" y="5.5" width="7" height="5" rx="1.2" /><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
      </svg>
    </span>
  );
}

const icon = { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const NewFileIcon = () => <svg {...icon} className="size-[15px]"><path d="M9 2.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6L9 2.5Z" /><path d="M9 2.5V6h3.5M8 8.200v3.600M6.200 10h3.600" /></svg>;

const SHEET = 'M9 2.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6L9 2.5ZM9 2.5V6h3.5';
/** What a file is, by its name: the shape to draw and the colour to draw it in (the editor's own few, so a kind looks the same in both places). */
const KINDS: [RegExp, string, string][] = [
  // A database: a drum.
  [/\.(db|sqlite3?)$/, 'M3.5 4.5c0-1 2-1.8 4.500-1.800s4.500.8 4.500 1.800-2 1.800-4.500 1.800S3.500 5.500 3.500 4.500ZM3.500 4.500v7c0 1 2 1.800 4.500 1.800s4.500-.800 4.500-1.800v-7M3.500 8c0 1 2 1.800 4.500 1.800S12.500 9 12.500 8', 'var(--syn-string)'],
  // Rows and columns.
  [/\.(csv|tsv|xlsx?)$/, 'M3.500 3.500h9a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM2.500 6.500h11M2.500 9.500h11M6.500 3.500v9', 'var(--syn-string)'],
  // Code: angle brackets.
  [/\.(py|js|ts|sh|bash|sql|html|css)$/, 'M5.500 4.500 2.500 8l3 3.500M10.500 4.500l3 3.500-3 3.500M9 3.500 7 12.500', 'var(--syn-keyword)'],
  // Data and settings: braces.
  [/\.(jsonl?|ya?ml|toml|ini|cfg|env)$|(^|\/)\.env/, 'M6.500 3C5 3 5 4 5 5.200S4.500 8 3.500 8c1 0 1.500 1.300 1.500 2.800S5 13 6.500 13M9.500 3c1.500 0 1.500 1 1.500 2.200S11.500 8 12.500 8c-1 0-1.500 1.300-1.500 2.800S11 13 9.500 13', 'var(--syn-number)'],
  // Words: a sheet with lines on it.
  [/\.(md|txt|log|rst)$/, `${SHEET}M5.500 8.500h5M5.500 10.800h3.500`, 'var(--color-label-3)'],
];
/** A file's or a folder's mark in the tree. */
function Mark({ path, dir = false, open = false }: { path: string; dir?: boolean; open?: boolean }) {
  if (dir) {
    return (
      <svg {...icon} className="size-[15px] shrink-0 text-label-3">
        {open
          ? <path d="M2 12V4.500a1 1 0 0 1 1-1h3L7.500 5H12a1 1 0 0 1 1 1v1M2 12l1.500-4.300a1 1 0 0 1 .95-.7H14a.5.5 0 0 1 .47.67L13.200 12.300a1 1 0 0 1-.95.7H3a1 1 0 0 1-1-1Z" />
          : <path d="M2 4.500a1 1 0 0 1 1-1h3L7.500 5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />}
      </svg>
    );
  }
  const [, shape, colour] = KINDS.find(([re]) => re.test(path)) ?? [undefined, SHEET, 'var(--color-label-3)'];
  return <svg {...icon} className="size-[15px] shrink-0" style={{ color: colour }}><path d={shape} /></svg>;
}
const FoldIcon = () => <svg {...icon} className="size-[15px]"><path d="M3 4.500 8 2l5 2.500M3 11.500 8 14l5-2.500M4.500 8h7" /></svg>;

type Item = { label: string; act?: () => void; tone?: 'bad'; note?: boolean };

/**
 * The menu a right click opens, where the pointer is; gone on a click elsewhere, Escape, or a scroll.
 * It is drawn on the page itself, not inside the panel it was opened in: a pane of glass clips what
 * is inside it and places "fixed" things by its own corner, which cut the menu off at the pane's edge.
 */
function ContextMenu({ at, items, onClose }: { at: { x: number; y: number }; items: (Item | 'rule')[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  // Kept inside the window: a menu opened near an edge opens the other way.
  useEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) });
  }, [at]);
  useEffect(() => {
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', away, true);
    window.addEventListener('wheel', onClose, true);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', onClose);
    return () => { window.removeEventListener('mousedown', away, true); window.removeEventListener('wheel', onClose, true); window.removeEventListener('keydown', esc); window.removeEventListener('blur', onClose); };
  }, [onClose]);
  return createPortal(
    <div ref={box} role="menu" className="menu fixed z-50 min-w-44 whitespace-nowrap" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => (it === 'rule' ? <div key={i} className="my-1 h-px bg-divider" />
        : it.note ? <p key={i} className="px-3 py-1.5 text-xs text-label-3">{it.label}</p>
          : (
            <button key={i} type="button" role="menuitem" onClick={() => { onClose(); it.act?.(); }}
              className={`flex w-full items-center rounded-lg px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-fill-3 ${it.tone === 'bad' ? 'text-bad' : 'text-label-1'}`}>{it.label}</button>
          )))}
    </div>,
    document.body,
  );
}

/**
 * The workspace as a tree, the brief first. Folders fold. What can be done is on the bar at the top
 * (a new file) and under a right click on anything in the tree (a new file there, a copy beside it,
 * removing it, its path). `onNew`, `onDuplicate` and `onDelete` are absent once the run is over, and
 * what was handed over to be read (the brief, docs/, bin/) carries a lock instead.
 */
export function FileTree({ view, lang, current, dirty, onOpen, onNew, onDuplicate, onDelete }: {
  view: View; lang: Lang; current?: string; dirty: Set<string>;
  onOpen: (path: string) => void; onNew?: (dir: string) => void; onDuplicate?: (path: string) => void; onDelete?: (path: string) => void;
}) {
  // Top-level folders start open; deeper ones open on demand.
  const [closed, setClosed] = useState<Set<string>>(() => new Set(view.files.filter((f) => f.dir && f.path.includes('/')).map((f) => f.path)));
  const [menu, setMenu] = useState<{ x: number; y: number; items: (Item | 'rule')[] }>();
  const toggle = (p: string) => setClosed((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const folders = useMemo(() => view.files.filter((f) => f.dir).map((f) => f.path), [view.files]);
  const allClosed = folders.length > 0 && folders.every((p) => closed.has(p));
  // The brief leads; the rest follows as the workspace lists it.
  // Two parts. Background: what the customer handed over, to work from (the brief, their documents and
  // data, the tools for asking them). Deliverables: what the learner changes and hands over (the
  // system, the notes), and anything else they make along the way.
  const parts = useMemo(() => {
    const open = view.files.filter((f) => {
      for (let d = dirname(f.path); d; d = dirname(d)) if (closed.has(d)) return false;
      return true;
    });
    // The customer's material is exactly what is kept from change; everything else is the learner's work.
    const given = locked;
    const brief = open.filter((f) => f.path === 'TASK.md');
    return {
      resources: [...brief, ...open.filter((f) => given(f.path) && f.path !== 'TASK.md')],
      deliverables: open.filter((f) => !given(f.path)),
    };
  }, [view.files, closed]);

  /** What a right click offers on a file, a folder, or the empty part of the tree (`path` undefined). */
  function open(e: MouseEvent, path?: string, dir = false) {
    e.preventDefault();
    e.stopPropagation();
    const kept = path !== undefined && locked(path);
    const here = path === undefined ? '' : dir ? path : dirname(path);
    const items: (Item | 'rule')[] = [];
    if (path !== undefined && !dir) items.push({ label: L(lang, '打开', 'Open'), act: () => onOpen(path) });
    if (onNew && !locked(here)) items.push({ label: here ? L(lang, `在 ${here}/ 新建文件`, `New file in ${here}/`) : L(lang, '新建文件', 'New file'), act: () => onNew(here) });
    if (path !== undefined && onDuplicate && !kept) items.push({ label: L(lang, '复制', 'Duplicate'), act: () => onDuplicate(path) });
    if (path !== undefined) items.push({ label: L(lang, '拷贝路径', 'Copy path'), act: () => { void navigator.clipboard?.writeText(path).catch(() => undefined); } });
    if (path !== undefined && onDelete && !kept) items.push('rule', { label: L(lang, '删除', 'Delete'), tone: 'bad', act: () => onDelete(path) });
    if (kept) items.push('rule', { label: L(lang, '题目文件 - 只读', 'Case file - read-only'), note: true });
    if (items.length) setMenu({ x: e.clientX, y: e.clientY, items });
  }

  const row = 'group flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[13px] transition-colors';
  const tool = 'grid size-7 place-items-center rounded-md text-label-3 transition-colors hover:bg-fill-2 hover:text-label-1';
  const bar = (label: string, onClick: () => void, children: ReactNode) => <button type="button" title={label} aria-label={label} onClick={onClick} className={tool}>{children}</button>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-divider bg-fill-4 pr-1.5 pl-3">
        <span className="eyebrow mr-auto">{L(lang, '文件', 'Files')}</span>
        {onNew && bar(L(lang, '新建文件', 'New file'), () => onNew(''), <NewFileIcon />)}
        {folders.length > 0 && bar(allClosed ? L(lang, '全部展开', 'Expand all') : L(lang, '全部收起', 'Collapse all'), () => setClosed(allClosed ? new Set() : new Set(folders)), <FoldIcon />)}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-1 select-none" onContextMenu={(e) => open(e)}>
        {([['resources', L(lang, '背景资料', 'Background')], ['deliverables', L(lang, '交付物', 'Deliverables')]] as const).map(([part, title]) => (
          <div key={part}>
            <p className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-divider bg-layer-1 px-3 pt-2.5 pb-1.5 text-[11px]">
              <span className="min-w-0 flex-1 truncate font-semibold tracking-wide text-label-2">{title}</span>
              {/* One lock for the whole part: everything under Background is read-only. */}
              {part === 'resources' && <span className="-my-1 self-center"><Lock lang={lang} /></span>}
            </p>
            <div className="py-1">
        {parts[part].map((f) => {
          const depth = f.path.split('/').length - 1;
          const pad = { paddingLeft: 12 + depth * 14 };
          if (f.dir) {
            return (
              <div key={f.path} className={`${row} text-label-2 hover:bg-fill-4`} style={pad} onContextMenu={(e) => open(e, f.path, true)}>
                <button type="button" onClick={() => toggle(f.path)} aria-expanded={!closed.has(f.path)} className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left">
                  <Mark path={f.path} dir open={!closed.has(f.path)} />
                  <span className="truncate font-medium">{basename(f.path)}</span>
                </button>
                {onNew && !locked(f.path) && (
                  <button type="button" onClick={() => onNew(f.path)} title={L(lang, '在这里新建文件', 'New file here')} aria-label={L(lang, '在这里新建文件', 'New file here')}
                    className="hidden size-5 shrink-0 place-items-center rounded-md text-label-3 group-hover:grid hover:bg-fill-2 hover:text-label-1"><Plus className="size-2.5" /></button>
                )}
                {/* Whether it is open, at the row's right end. */}
                <button type="button" tabIndex={-1} aria-hidden onClick={() => toggle(f.path)} className="grid size-5 shrink-0 place-items-center text-label-3">
                  <svg viewBox="0 0 12 12" className={`size-3 transition-transform ${closed.has(f.path) ? '' : 'rotate-90'}`}><path d="M4.5 3 7.5 6 4.5 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            );
          }
          const on = f.path === current;
          const brief = f.path === 'TASK.md';
          return (
            <div key={f.path} className={`${row} ${on ? 'bg-fill-3 font-medium text-label-1' : 'text-label-1 hover:bg-fill-4'}`} style={pad} onContextMenu={(e) => open(e, f.path)}>
              <button type="button" onClick={() => onOpen(f.path)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={f.path}>
                <Mark path={f.path} />
                <span className="truncate font-mono text-xs">{basename(f.path)}</span>
                {brief && <span className="shrink-0 text-[11px] font-normal text-label-3">{L(lang, '任务书', 'the brief')}</span>}
                {dirty.has(f.path) && <span aria-label={L(lang, '未保存', 'unsaved')} className="size-1.5 shrink-0 rounded-full bg-warn" />}
              </button>
              {onDelete && !locked(f.path) && (
                <button type="button" onClick={() => onDelete(f.path)} title={L(lang, '删除', 'Delete')} aria-label={L(lang, '删除', 'Delete')}
                  className="hidden size-5 shrink-0 place-items-center rounded-md text-label-3 group-hover:grid hover:bg-fill-2 hover:text-bad"><Cross className="size-2.5" /></button>
              )}
            </div>
          );
        })}
            </div>
          </div>
        ))}
      </div>
      {menu && <ContextMenu at={menu} items={menu.items} onClose={() => setMenu(undefined)} />}
    </div>
  );
}
