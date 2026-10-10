/**
 * The learner's workspace: what an agent gets as a directory and a shell, laid out for a person.
 * A slim top bar, then three columns on the gutter: the workspace's files; the file being read or
 * written, at full height; and one panel for everything done beside it, a tab at a time: directing
 * the coding agent, the customer's people, a command line, what has changed. After submitting, the
 * same page is read-only and that panel leads with the result.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { splitTitle } from '@/components/CaseCard';
import { Modal } from '@/components/Modal';
import { LangToggle, UserMenu } from '@/components/SiteHeader';
import { Logo } from '@/components/site-chrome';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useAuth } from '@/components/auth/AuthDialog';
import { Button, ButtonLink, Pill, tabClass } from '@/components/ui';
import { Verdict } from '@/components/Verdict';
import { Agent } from '@/components/workspace/Agent';
import { Changes, Counts, loadChanges, type ChangeList } from '@/components/workspace/Changes';
import { Editor } from '@/components/workspace/Editor';
import { FileTree } from '@/components/workspace/FileTree';
import { Avatar, People } from '@/components/workspace/People';
import { Terminal } from '@/components/workspace/Terminal';
import { GradeDialog, Grading, seenResult } from '@/components/workspace/Grade';
import { Timeline } from '@/components/workspace/Timeline';
import type { Message, View } from '@/components/workspace/types';
import { api } from '@/lib/client';
import { L, useLang, type Lang } from '@/lib/i18n';
import { useMe } from '@/lib/me';
import { PASS, points } from '@/lib/score';

const NOTE = 'deliverables/delivery_note.md';

export function SessionPage() {
  const { lang } = useLang();
  const { id } = useParams();
  const navigate = useNavigate();
  const [view, setView] = useState<View>();
  const [error, setError] = useState<string>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [open, setOpen] = useState<string[]>(['TASK.md']);
  const [active, setActive] = useState<string | undefined>('TASK.md');
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [rev, setRev] = useState(0);
  const [dialog, setDialog] = useState<{ kind: 'new'; dir: string } | { kind: 'delete'; path: string } | { kind: 'submit' } | { kind: 'abandon' } | { kind: 'leave' }>();
  // What the right-hand panel shows. The agent to begin with: it is what the learner works through.
  const [side, setSide] = useState<'agent' | 'terminal' | 'changes' | 'people' | 'result' | 'timeline'>('agent');
  // How wide the right-hand panel is on a wide screen; dragged, and remembered.
  const [sideWidth, setSideWidth] = useState(() => { try { return Math.max(SIDE_MIN, Number(localStorage.getItem('fdegym:side')) || SIDE); } catch { return SIDE; } });
  const [treeWidth, setTreeWidth] = useState(() => { try { return Math.max(TREE_MIN, Number(localStorage.getItem('fdegym:tree')) || TREE); } catch { return TREE; } });
  useEffect(() => { try { localStorage.setItem('fdegym:tree', String(treeWidth)); } catch { /* private mode */ } }, [treeWidth]);
  const [sizing, setSizing] = useState<'tree' | 'side'>();
  const columns = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem('fdegym:side', String(sideWidth)); } catch { /* private mode */ } }, [sideWidth]);
  // The agent does the work; the command line stays for doing something by hand.
  // How many files differ from when the run began; shown on the tab.
  const [changed, setChanged] = useState(0);

  const load = useCallback(async () => {
    try { setView(await api<View>(`/api/sessions/${id}`)); setError(undefined); }
    catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<{ messages: Message[] }>(`/api/sessions/${id}/messages`).then((d) => setMessages(d.messages)).catch(() => undefined);
  }, [id]);

  // Grading takes minutes; look again until it is over.
  const status = view?.status;
  useEffect(() => {
    if (status !== 'grading') return;
    const t = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(t);
  }, [status, load]);
  useEffect(() => { if (status && status !== 'running') setSide('result'); }, [status]);
  // The grade is shown in the middle of the page: from the moment the run is handed over, and again
  // when a score arrives that this browser has not shown yet. Put aside, it stays aside until then.
  const [gradeOpen, setGradeOpen] = useState(false);
  const statusWas = useRef<string>(undefined);
  useEffect(() => {
    if (status === 'grading' && statusWas.current !== 'grading') setGradeOpen(true);
    else if (status === 'graded' && id && !seenResult(id)) setGradeOpen(true);
    statusWas.current = status;
  }, [status, id]);

  // Leaving with unsaved edits loses them.
  useEffect(() => {
    if (!dirty.size) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const openFile = useCallback((path: string) => { setOpen((o) => (o.includes(path) ? o : [...o, path])); setActive(path); }, []);
  const closeFile = useCallback((path: string) => {
    setOpen((o) => {
      const next = o.filter((p) => p !== path);
      setActive((a) => (a === path ? next[Math.max(0, o.indexOf(path) - 1)] : a));
      return next;
    });
  }, []);
  const onMessage = useCallback((m: Message) => { setMessages((ms) => [...ms, m]); void load(); }, [load]);
  const afterCommand = useCallback(() => { setRev((r) => r + 1); void load(); }, [load]);

  if (error && !view) return <Blocked lang={lang} message={error} retry={load} />;
  if (!view) return <div className="grid h-screen place-items-center text-label-3">{L(lang, '加载中……', 'Loading…')}</div>;

  const readOnly = view.finished;

  async function createFile(path: string) {
    await api(`/api/sessions/${id}/file`, { method: 'PUT', json: { path, content: '' } });
    setDialog(undefined);
    await load();
    openFile(path);
  }
  async function deleteFile(path: string) {
    await api(`/api/sessions/${id}/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    setDialog(undefined);
    closeFile(path);
    await load();
  }
  /** A copy beside the original, named as a desktop names one; a file's copy is opened, as a desktop selects it. */
  async function duplicate(path: string) {
    try {
      const made = await api<{ path: string }>(`/api/sessions/${id}/duplicate`, { method: 'POST', json: { path, lang } });
      afterCommand();
      if (!view?.files.find((f) => f.path === path)?.dir) openFile(made.path);
    } catch (e) { window.alert((e as Error).message); }
  }
  async function abandon() {
    await api(`/api/sessions/${id}/abandon`, { method: 'POST' });
    setDialog(undefined);
    await load();
  }
  async function submit() {
    await api(`/api/sessions/${id}/submit`, { method: 'POST' });
    setDialog(undefined);
    await load();
  }

  /** Drag the line between the middle and the right-hand panel; the width is kept for next time. */
  function startSizing(e: React.PointerEvent, which: 'tree' | 'side') {
    e.preventDefault();
    setSizing(which);
    const move = (ev: PointerEvent) => {
      const box = columns.current!.getBoundingClientRect();
      // From the pointer to the row's edge on that side, less the row's own padding; never so wide that the middle is squeezed out.
      if (which === 'side') setSideWidth(Math.round(Math.min(Math.max(SIDE_MIN, box.right - 8 - ev.clientX), Math.max(SIDE_MIN, box.width - treeWidth - MIDDLE_MIN))));
      else setTreeWidth(Math.round(Math.min(Math.max(TREE_MIN, ev.clientX - box.left - 8), Math.max(TREE_MIN, Math.min(TREE_MAX, box.width - sideWidth - MIDDLE_MIN)))));
    };
    const up = () => { setSizing(undefined); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  // The run is open and has a command line: the agent, the terminal and the list of changes are on offer.
  const working = view.terminal && !readOnly;
  // What the panel really shows: a tab that is not on offer (no agent on this site, a run that is over) gives way to one that is.
  const offered = (t: typeof side) => t === 'people' || (working && (t === 'terminal' || t === 'changes' || (t === 'agent' && view.agent.available))) || (view.finished && (t === 'result' || t === 'timeline'));
  const shown = offered(side) ? side : working ? (view.agent.available ? 'agent' : 'terminal') : view.finished ? 'result' : 'people';
  const changesTab = (
    <SideTab on={shown === 'changes'} onClick={() => setSide('changes')}>
      {L(lang, '改动', 'Changes')}
      {changed > 0 && <span className="ml-1.5 font-mono text-[11px] text-label-3 tabular-nums">{changed}</span>}
    </SideTab>
  );
  return (
    <div className="flex h-screen flex-col bg-gutter">
      <TopBar view={view} lang={lang} onBrief={() => openFile('TASK.md')} onSubmit={() => setDialog({ kind: 'submit' })} onAbandon={() => setDialog({ kind: 'abandon' })}
        // Leaving a run that is over loses nothing, so it needs no asking.
        onLeave={() => (view.finished ? navigate('/me') : setDialog({ kind: 'leave' }))} />
      <div ref={columns} className={`flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2 lg:flex-row ${sizing ? 'cursor-col-resize select-none' : ''}`}>
        <Panel className="max-h-64 lg:max-h-none lg:w-[var(--tree)] lg:shrink-0" style={{ ['--tree' as string]: `${treeWidth}px` }}>
          <FileTree view={view} lang={lang} current={active} dirty={dirty} onOpen={openFile}
            onNew={readOnly ? undefined : (dir) => setDialog({ kind: 'new', dir })}
            onDuplicate={readOnly ? undefined : (path) => void duplicate(path)}
            onDelete={readOnly ? undefined : (path) => setDialog({ kind: 'delete', path })} />
        </Panel>

        <div role="separator" aria-orientation="vertical" onPointerDown={(e) => startSizing(e, 'tree')} onDoubleClick={() => setTreeWidth(TREE)}
          className="group -mx-2 hidden w-2 shrink-0 cursor-col-resize items-center justify-center lg:flex">
          <span className={`h-8 w-1 rounded-full transition-colors ${sizing === 'tree' ? 'bg-brand' : 'bg-transparent group-hover:bg-label-4'}`} />
        </div>
        {/* The middle is the file being read or written, and nothing else: the whole height for the code or the document. */}
        <Panel className="min-h-[70vh] min-w-0 flex-1 lg:min-h-0">
          <Editor runId={view.runId} lang={lang} open={open} active={active} readOnly={readOnly} rev={rev} onSelect={setActive} onClose={closeFile} onDirty={setDirty} onSaved={load} />
        </Panel>

        {/* Between the file and the panel beside it: drag to give either more room; a double click puts it back. It sits in the gap between the two. */}
        <div role="separator" aria-orientation="vertical" onPointerDown={(e) => startSizing(e, 'side')} onDoubleClick={() => setSideWidth(SIDE)}
          className="group -mx-2 hidden w-2 shrink-0 cursor-col-resize items-center justify-center lg:flex">
          <span className={`h-8 w-1 rounded-full transition-colors ${sizing === 'side' ? 'bg-brand' : 'bg-transparent group-hover:bg-label-4'}`} />
        </div>
        <Panel className="min-h-[50vh] lg:min-h-0 lg:w-[var(--side)] lg:shrink-0" style={{ ['--side' as string]: `${sideWidth}px` }}>
          {/* Everything the learner does beside the file, one at a time: direct the agent, run a command by hand, see what has changed, talk to the customer's people; and, once the run is over, the result and the way there. */}
          <div className="no-scrollbar flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-divider bg-fill-4 px-1.5">
            {view.finished && <SideTab on={shown === 'result'} onClick={() => setSide('result')}>{L(lang, '结果', 'Result')}</SideTab>}
            {view.finished && <SideTab on={shown === 'timeline'} onClick={() => setSide('timeline')}>{L(lang, '过程', 'Timeline')}</SideTab>}
            {working && view.agent.available && <SideTab on={shown === 'agent'} onClick={() => setSide('agent')}>Agent</SideTab>}
            <SideTab on={shown === 'people'} onClick={() => setSide('people')}>
              {L(lang, '客户列表', 'Customers')}
              {view.inboxNew > 0 && <span className="ml-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-semibold text-on-brand tabular-nums" title={L(lang, '收件箱有新消息', 'New messages in the inbox')}>{view.inboxNew}</span>}
            </SideTab>
            {working && <SideTab on={shown === 'terminal'} onClick={() => setSide('terminal')}>{L(lang, '终端', 'Terminal')}</SideTab>}
            {working && changesTab}
            {view.at && <span className="ml-auto shrink-0 pr-2 pl-2 font-mono text-[11px] text-label-3" title={L(lang, '客户那边的时间', 'The time at the customer')}>{view.at}</span>}
          </div>
          {working && (
            // All three stay mounted, so switching keeps the conversation and the command history.
            <>
              {view.agent.available && <div className={shown === 'agent' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}><Agent runId={view.runId} view={view} lang={lang} onChanged={afterCommand} /></div>}
              <div className={shown === 'terminal' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}><Terminal runId={view.runId} view={view} lang={lang} onDone={afterCommand} /></div>
              <div className={shown === 'changes' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}><Changes runId={view.runId} lang={lang} rev={rev} active={shown === 'changes'} readOnly={readOnly} onChanged={afterCommand} onCount={setChanged} /></div>
            </>
          )}
          {shown === 'result' ? <Result view={view} lang={lang} reload={load} onTimeline={() => setSide('timeline')} held={gradeOpen} />
            : shown === 'timeline' ? <Timeline view={view} lang={lang} />
            : shown === 'people' && <People runId={view.runId} view={view} lang={lang} messages={messages} onMessage={onMessage} readOnly={readOnly} />}
        </Panel>
      </div>

      {dialog?.kind === 'new' && <NewFileDialog lang={lang} dir={dialog.dir} existing={view.files.map((f) => f.path)} onCancel={() => setDialog(undefined)} onCreate={createFile} />}
      {dialog?.kind === 'delete' && (
        <Modal lang={lang} title={L(lang, '删除文件', 'Delete file')} onClose={() => setDialog(undefined)}
          actions={<><Button size="sm" tone="ghost" onClick={() => setDialog(undefined)}>{L(lang, '取消', 'Cancel')}</Button><Button size="sm" onClick={() => void deleteFile(dialog.path)}>{L(lang, '删除', 'Delete')}</Button></>}>
          <p className="text-sm text-label-2">{L(lang, '删除 ', 'Delete ')}<code className="font-mono text-xs text-label-1">{dialog.path}</code>{L(lang, '？删除后不能恢复。', '? This cannot be undone.')}</p>
        </Modal>
      )}
      {dialog?.kind === 'abandon' && (
        <Modal lang={lang} title={L(lang, '终止这次练习', 'Terminate this run')} onClose={() => setDialog(undefined)}
          actions={<><Button size="sm" tone="ghost" onClick={() => setDialog(undefined)}>{L(lang, '继续做', 'Keep going')}</Button><Button size="sm" tone="secondary" onClick={() => void abandon()}>{L(lang, '终止，不提交', 'Terminate without submitting')}</Button></>}>
          <p className="text-sm leading-relaxed text-label-2">
            {L(lang, '终止后这次练习不会评分，也不计入成绩；工作区还能看，但不能再改、不能再问人。正在运行的 agent 和命令会被停掉。想重做可以从题目页重新开始。',
              'The run will not be graded and counts for nothing. You can still look at the workspace, but not change it or ask anyone. A running agent or command is stopped. To try again, start afresh from the case page.')}
          </p>
        </Modal>
      )}
      {dialog?.kind === 'leave' && (
        <Modal lang={lang} title={L(lang, '离开这次练习', 'Leave this run')} onClose={() => setDialog(undefined)}
          actions={<><Button size="sm" tone="ghost" onClick={() => setDialog(undefined)}>{L(lang, '留在这里', 'Stay')}</Button><Button size="sm" onClick={() => navigate('/me')}>{L(lang, '离开', 'Leave')}</Button></>}>
          <p className="text-sm leading-relaxed text-label-2">
            {L(lang, '这次练习会原样保留：工作区里的文件、和 agent 的对话、问过客户方的话都在。之后从“我的练习”回来，可以接着做。',
              'The run is kept as it is: the files in the workspace, the conversation with the agent, what you asked the customer’s people. Come back to it from “My runs” and carry on.')}
          </p>
          {view.agent.busy && <p className="text-sm leading-relaxed text-label-2">{L(lang, 'agent 正在做的这一轮会继续做完。', 'The turn the agent is on will run to its end.')}</p>}
          {dirty.size > 0 && (
            <p className="rounded-lg bg-warn/15 px-3.5 py-2.5 text-[13px] leading-relaxed text-warn-text">
              {L(lang, '还有没保存的文件，离开会丢掉这些改动：', 'Unsaved files, whose changes are lost if you leave: ')}<span className="font-mono text-xs">{[...dirty].join(', ')}</span>
            </p>
          )}
          <p className="text-xs leading-relaxed text-label-3">{L(lang, '没交付的练习会占着你的一个名额；长时间不回来会被自动终止。', 'A run that is not handed over holds one of your places; left alone for long, it is ended.')}</p>
        </Modal>
      )}
      {gradeOpen && (view.status === 'grading' || view.status === 'graded' || view.status === 'failed') && (
        <GradeDialog runId={view.runId} status={view.status} since={view.finishedAt} lang={lang} error={view.gradingError}
          result={view.result ? { net: points(view.result.upliftNet), verdict: view.result.incidents.length > 0 ? 'incident' : view.result.upliftNet >= PASS ? 'accepted' : 'rejected' } : undefined}
          line={view.result ? reading(view.result, lang)[0] : undefined}
          onClose={() => setGradeOpen(false)} onHome={() => navigate('/')} />
      )}
      {dialog?.kind === 'submit' && <SubmitDialog view={view} lang={lang} unsaved={[...dirty]} onCancel={() => setDialog(undefined)} onConfirm={submit} />}
    </div>
  );
}

function Panel({ children, className = '', style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return <section style={style} className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg bg-layer-1 shadow-card ${className}`}>{children}</section>;
}

function SideTab({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={tabClass(on, 'sm')}>
      {children}
    </button>
  );
}


function TopBar({ view, lang, onBrief, onSubmit, onAbandon, onLeave }: { view: View; lang: Lang; onBrief: () => void; onSubmit: () => void; onAbandon: () => void; onLeave: () => void }) {
  const { org, ask } = splitTitle(view.title);
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 px-3">
      {/* The name only: in the middle of a run a click on it must not take the learner away. Leaving is the button on the right. */}
      <Logo className="shrink-0 text-[17px] select-none" />
      <span aria-hidden className="h-4 w-px bg-divider" />
      {/* The run's title opens what it is the title of: the brief. */}
      <button type="button" onClick={onBrief} className="flex min-w-0 items-baseline gap-2 text-left text-sm hover:text-link" title={L(lang, '打开任务书（TASK.md）', 'Open the brief (TASK.md)')}>
        <span className="truncate font-medium">{ask}</span>
        <span className="hidden shrink-0 text-xs text-label-3 md:inline">{org}</span>
      </button>
      {view.versions > 1 && view.version > 0 && <Pill className="font-mono" >#{view.version}</Pill>}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <ThemeToggle />
        <LangToggle />
        <UserMenu compact />
        {view.finished
          ? <Pill tone={view.status === 'graded' ? 'ok' : view.status === 'grading' ? 'warn' : view.status === 'abandoned' ? 'plain' : 'bad'} className="ml-2">{view.status === 'graded' ? L(lang, '已评分', 'Graded') : view.status === 'grading' ? L(lang, '评分中', 'Grading') : view.status === 'abandoned' ? L(lang, '已终止', 'Terminated') : L(lang, '评分失败', 'Grading failed')}</Pill>
          : <><span aria-hidden className="mx-2 h-5 w-px bg-divider" /><Button size="sm" tone="ghost" onClick={onAbandon}>{L(lang, '终止', 'Terminate')}</Button></>}
        <Button size="sm" tone={view.finished ? 'secondary' : 'ghost'} className={view.finished ? 'ml-2' : ''} onClick={onLeave}>{L(lang, '离开', 'Leave')}</Button>
        {!view.finished && <Button size="sm" onClick={onSubmit}>{L(lang, '提交交付', 'Submit delivery')}</Button>}
      </div>
    </header>
  );
}

function NewFileDialog({ lang, dir, existing, onCreate, onCancel }: { lang: Lang; dir: string; existing: string[]; onCreate: (path: string) => Promise<void>; onCancel: () => void }) {
  const [path, setPath] = useState(dir ? `${dir}/` : 'system/');
  const [error, setError] = useState<string>();
  const clean = path.trim().replace(/^\/+/, '');
  const problem = !clean || clean.endsWith('/') ? L(lang, '请填写文件名', 'Enter a file name')
    : existing.includes(clean) ? L(lang, '已经有这个文件', 'That file already exists')
    : clean === 'TASK.md' || clean.startsWith('bin/') || clean.split('/').includes('..') ? L(lang, '不能在这里新建', 'Files cannot be created there') : undefined;
  const create = () => { if (!problem) onCreate(clean).catch((e) => setError((e as Error).message)); };
  return (
    <Modal lang={lang} title={L(lang, '新建文件', 'New file')} onClose={onCancel}
      actions={<><Button size="sm" tone="ghost" onClick={onCancel}>{L(lang, '取消', 'Cancel')}</Button><Button size="sm" disabled={!!problem} onClick={create}>{L(lang, '新建', 'Create')}</Button></>}>
      <label className="block">
        <span className="field-label">{L(lang, '路径（相对工作区）', 'Path (inside the workspace)')}</span>
        <input autoFocus value={path} onChange={(e) => { setPath(e.target.value); setError(undefined); }} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} spellCheck={false} className="field font-mono text-[13px]" />
      </label>
      {(error || (clean && !clean.endsWith('/') && problem)) && <p className="text-xs text-bad">{error ?? problem}</p>}
    </Modal>
  );
}

function SubmitDialog({ view, lang, unsaved, onCancel, onConfirm }: { view: View; lang: Lang; unsaved: string[]; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const hasNote = view.files.some((f) => f.path === NOTE && f.bytes > 0);
  // What is about to go to production: the files under system/ that differ from when the run began.
  const [changes, setChanges] = useState<ChangeList>();
  useEffect(() => { loadChanges(view.runId).then(setChanges).catch(() => undefined); }, [view.runId]);
  const shipped = changes?.changes.filter((c) => c.path.startsWith('system/')) ?? [];
  const me = useMe();
  const auth = useAuth();
  // The sign-in dialog would open underneath this one, so step aside for it; the run is kept either way.
  const signIn = (v: 'login' | 'register') => { onCancel(); auth.open(v); };
  const go = () => { setBusy(true); onConfirm().catch((e) => { setError((e as Error).message); setBusy(false); }); };
  const warn = 'rounded-lg bg-warn/15 px-3.5 py-2.5 text-[13px] leading-relaxed text-warn-text';
  return (
    <Modal lang={lang} title={L(lang, '提交这次交付', 'Submit this delivery')} onClose={onCancel}
      actions={<><Button size="sm" tone="ghost" onClick={onCancel}>{L(lang, '再看看', 'Not yet')}</Button><Button size="sm" disabled={busy || unsaved.length > 0} onClick={go}>{busy ? L(lang, '提交中……', 'Submitting…') : L(lang, '提交并评分', 'Submit and grade')}</Button></>}>
      <p className="text-sm leading-relaxed text-label-2">
        {L(lang, 'system/ 里现在的内容会原样上线，用你没见过的流量回放打分。只能提交一次，提交后工作区不能再改，也不能再问人。评分要几分钟。',
          'What is in system/ now goes to production unchanged and is scored by replaying traffic you have not seen. You submit once: afterwards the workspace cannot be changed and nobody can be asked. Grading takes a few minutes.')}
      </p>
      {changes?.known && (shipped.length === 0
        ? <p className={warn}>{L(lang, 'system/ 里没有任何改动：现在提交，上线的就是客户原来的系统，得分是 0。', 'Nothing under system/ has changed: handing over now puts the customer’s system as it was into production, and scores 0.')}</p>
        : (
          <div className="rounded-lg bg-fill-4 px-3.5 py-2.5 text-[13px] leading-relaxed">
            <p className="text-label-2">{L(lang, `会上线的改动：system/ 下 ${shipped.length} 个文件`, `Going to production: ${shipped.length} file${shipped.length === 1 ? '' : 's'} under system/`)}</p>
            <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto">
              {shipped.map((c) => (
                <li key={c.path} className="flex items-center gap-2 font-mono text-xs">
                  <span className={`w-14 shrink-0 font-sans text-[11px] ${c.status === 'deleted' ? 'text-bad' : c.status === 'added' ? 'text-ok' : 'text-label-3'}`}>{c.status === 'added' ? L(lang, '新建', 'new') : c.status === 'deleted' ? L(lang, '删除', 'removed') : L(lang, '修改', 'changed')}</span>
                  <span className="min-w-0 flex-1 truncate" title={c.path}>{c.path}</span>
                  <Counts c={c} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      {unsaved.length > 0 && <p className={warn}>{L(lang, '还有没保存的文件：', 'Unsaved files: ')}<span className="font-mono text-xs">{unsaved.join(', ')}</span>{L(lang, '。先保存再提交。', '. Save them first.')}</p>}
      {!hasNote && <p className={warn}>{L(lang, '还没有交付说明 ', 'There is no delivery note yet: ')}<span className="font-mono text-xs">{NOTE}</span>{L(lang, '。任务书把它列为交付物。', '. The brief lists it as a deliverable.')}</p>}
      {me && !me.user && (
        <p className="rounded-lg bg-fill-4 px-3.5 py-2.5 text-[13px] leading-relaxed text-label-2">
          {L(lang, '你还没登录。这次的成绩只存在这个浏览器里，换设备或清掉浏览器数据就看不到了。', 'You are not signed in. This result is kept in this browser only and is lost if you switch devices or clear site data. ')}
          <button type="button" onClick={() => signIn('login')} className="font-medium text-link hover:underline">{L(lang, '登录', 'Sign in')}</button>
          {L(lang, ' 或 ', ' or ')}
          <button type="button" onClick={() => signIn('register')} className="font-medium text-link hover:underline">{L(lang, '注册', 'sign up')}</button>
          {L(lang, ' 之后，记录会归到账号下；也可以提交之后再登录。', ' and it moves to your account; you can also do that after submitting.')}
        </p>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
    </Modal>
  );
}

/** The side panels' widths to begin with and the narrowest they go; the file tree's widest; and what the middle is never squeezed below. */
const SIDE = 440, SIDE_MIN = 320, TREE = 240, TREE_MIN = 180, TREE_MAX = 520, MIDDLE_MIN = 420;

const num = (x: number, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : '—');

/**
 * What the numbers say, in a few sentences: whether it passed and, if not, where the score was most
 * likely lost: in what was never found out, in the system, or in what asking cost. It reads only
 * the result's own figures (how much of what mattered was learned by asking is a share, never which
 * facts), so it tells a learner where to look next time without telling them the answer.
 */
function reading(r: NonNullable<View['result']>, lang: Lang): string[] {
  const out: string[] = [];
  const pct = r.keyFactCoverage === null ? undefined : Math.round(r.keyFactCoverage * 100);
  const passed = r.incidents.length === 0 && r.upliftNet >= PASS;
  if (r.incidents.length) {
    out.push(L(lang, '上线后出了事故，这是这次不通过的直接原因：系统做了客户不能接受的事，或者没撑住真实流量。别处做得再好，分数也不高于 0。',
      'There was an incident in production, and that is why this did not pass: the system did something the customer cannot accept, or did not stand up to real traffic. Whatever else went well, the score is no higher than 0.'));
  } else if (passed) {
    out.push(L(lang, '通过：上线后的表现达到了参考解的八成以上。', 'Accepted: in production it did at least four fifths as well as the reference solution.'));
  } else if (r.uplift >= PASS) {
    out.push(L(lang, `系统本身达标（${points(r.uplift)} 分），是占用客户方的成本把分数拉到了 80 分以下。`, `The system itself was good enough (${points(r.uplift)}); what it cost the customer's people brought the score under 80.`));
  } else if (r.kpi === r.kpiBaseline) {
    out.push(L(lang, '上线后的表现和什么都不改一样：改动没有生效，或者没有碰到决定指标的地方。', 'In production it did exactly as well as changing nothing: the changes had no effect, or did not touch what the metric depends on.'));
  } else if (r.uplift < 0) {
    out.push(L(lang, '上线后比什么都不改还差：改动带来了新的问题。', 'In production it did worse than changing nothing: the changes brought problems of their own.'));
  } else {
    out.push(L(lang, '比原来好，但离参考解还有距离。', 'Better than it was, and still some way from the reference solution.'));
  }
  if (!passed && pct !== undefined) {
    if (pct < 50) {
      out.push(L(lang, `决定这道题结果的信息里，你通过问人拿到的只有 ${pct}%。丢分多半在没问清楚：下次先想清楚谁掌握哪条规则，再动手。`,
        `Of what decides this case, you learned ${pct}% by asking. The score was most likely lost in what was never found out: next time, work out who holds which rule before building.`));
    } else if (pct < 100) {
      out.push(L(lang, `决定结果的信息你问到了 ${pct}%。还没问到的那部分，以及问到的有没有真的落进系统，是该回头看的地方。`,
        `You learned ${pct}% of what decides the result by asking. Look back at the part you did not get, and at whether what you did get made it into the system.`));
    } else {
      out.push(L(lang, '决定结果的信息你都问到了。丢分在系统：规则知道了，却没有落进交付的系统，或者落错了。',
        'You found out everything that decides the result. The score was lost in the system: the rules were known, and did not make it into what was delivered, or went in wrong.'));
    }
  }
  if (r.offLimits.length) {
    out.push(L(lang, `你找了 ${r.offLimits.length} 位不该打扰的人，这部分被扣了分。`, `You contacted ${r.offLimits.length} ${r.offLimits.length === 1 ? 'person' : 'people'} who should not have been bothered, and it cost points.`));
  } else if (r.contactCost >= 0.1 && !(r.uplift >= PASS && !passed)) {
    out.push(L(lang, `问人一共扣了 ${points(r.uplift) - points(r.upliftNet)} 分。问题合起来问、问对人，可以少扣。`, `Asking cost ${points(r.uplift) - points(r.upliftNet)} points in all. Fewer, fuller questions to the right people cost less.`));
  }
  return out;
}

/** After submitting: grading in progress, a failure with a retry, or the score. */
function Result({ view, lang, reload, onTimeline, held }: { view: View; lang: Lang; reload: () => Promise<void>; onTimeline: () => void; held: boolean }) {
  if (view.status === 'grading') {
    return <Grading since={view.finishedAt} lang={lang} />;
  }
  if (view.status === 'abandoned') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <div>
          <p className="text-sm font-medium">{L(lang, '这次练习已终止，没有提交', 'This run was terminated without submitting')}</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-label-3">{L(lang, '没有评分，也不计入成绩。工作区和对话还能看。', 'It was not graded and counts for nothing. The workspace and the conversations can still be read.')}</p>
        </div>
        <ButtonLink to={`/cases/${view.caseId}`} size="sm" tone="secondary">{L(lang, '重新开始这道题', 'Start this case again')}</ButtonLink>
      </div>
    );
  }
  if (view.status === 'failed' || !view.result) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-bad">{view.gradingError ?? L(lang, '评分失败', 'Grading failed')}</p>
        <Button size="sm" onClick={async () => { await api(`/api/sessions/${view.runId}/grade`, { method: 'POST' }); await reload(); }}>{L(lang, '重新评分', 'Retry grading')}</Button>
      </div>
    );
  }
  // While the score is arriving in the middle of the page, it is not given away at the side.
  if (held) return <div className="flex-1" />;
  return <Graded view={view} r={view.result} lang={lang} onTimeline={onTimeline} />;
}

/** The score and what is behind it. */
function Graded({ view, r, lang, onTimeline }: { view: View; r: NonNullable<View['result']>; lang: Lang; onTimeline: () => void }) {
  const passed = r.incidents.length === 0 && r.upliftNet >= PASS;
  // What was gained and what asking cost are whole numbers that add up to the score shown.
  const system = points(r.uplift), net = points(r.upliftNet);
  const name = (id: string) => view.people.find((p) => p.id === id)?.name ?? id;
  const span = r.kpiOracle - r.kpiBaseline;
  const at = span ? Math.min(1, Math.max(0, (r.kpi - r.kpiBaseline) / span)) : 0;
  const row = 'flex items-baseline justify-between gap-4 py-2 text-[13px]';
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <p className="eyebrow flex items-center justify-between">
        {L(lang, '得分', 'Score')}
        <Verdict verdict={r.incidents.length > 0 ? 'incident' : passed ? 'accepted' : 'rejected'} lang={lang} className="text-[13px]" />
      </p>
      <p className={`mt-1 flex items-baseline gap-1.5 font-mono text-5xl font-semibold tabular-nums ${net < 0 ? 'text-bad' : passed ? 'text-ok' : ''}`}>
        {net}
        <span className="text-base font-normal text-label-3">/ 100</span>
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-label-3">{L(lang, '0 分是什么都不改，100 分是参考解，达到 80 分算通过。', '0 is changing nothing, 100 is the reference solution, and 80 or more is accepted.')}</p>

      <div className="mt-4 space-y-2 rounded-lg bg-fill-4 px-3.5 py-3 text-[13px] leading-relaxed text-label-1">
        {reading(r, lang).map((line) => <p key={line}>{line}</p>)}
      </div>

      <dl className="mt-4 divide-y divide-divider border-y border-divider">
        <div className={row}><dt className="text-label-2">{L(lang, '交付的系统', 'The delivered system')}</dt><dd className="font-mono tabular-nums">{system}</dd></div>
        <div className={row}><dt className="text-label-2">{L(lang, '占用客户方的成本', 'Cost to the customer’s people')}</dt><dd className="font-mono tabular-nums">−{system - net}</dd></div>
        {r.keyFactCoverage !== null && (
          <div className={row}><dt className="text-label-2">{L(lang, '问到的关键信息', 'Of what mattered, learned by asking')}</dt><dd className="font-mono tabular-nums">{Math.round(r.keyFactCoverage * 100)}%</dd></div>
        )}
      </dl>

      {r.incidents.length > 0 && (
        <div className="mt-4 rounded-lg bg-bad/10 px-3.5 py-3 text-[13px] leading-relaxed text-bad">
          <p className="font-medium">{L(lang, '上线后出了事故，这道题的分数不高于 0 分：', 'There were incidents in production, so the case scores no higher than 0:')}</p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 font-mono text-xs">{r.incidents.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}

      <p className="eyebrow mt-6">{L(lang, '客户的指标', 'The customer’s metric')}</p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-label-2">{r.kpiName}</p>
      <div className="relative mt-4 h-1.5 rounded-full bg-fill-2">
        <span className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${at * 100}%` }} />
      </div>
      <div className="mt-2 grid grid-cols-3 font-mono text-xs tabular-nums">
        <span className="text-label-3">{num(r.kpiBaseline)}<br /><span className="font-sans text-[11px]">{L(lang, '不改', 'unchanged')}</span></span>
        <span className="text-center font-semibold">{num(r.kpi)}<br /><span className="font-sans text-[11px] font-normal text-label-3">{L(lang, '你的', 'yours')}</span></span>
        <span className="text-right text-label-3">{num(r.kpiOracle)}<br /><span className="font-sans text-[11px]">{L(lang, '参考解', 'reference')}</span></span>
      </div>
      {r.summary && <p className="mt-3 rounded-lg bg-fill-4 px-3 py-2 font-mono text-xs break-words text-label-2">{r.summary}</p>}

      {view.versions > 1 && view.versionChange !== undefined && (
        <>
          <p className="eyebrow mt-6">{L(lang, `这道题（#${view.version}）的实情`, `What was true in this case (#${view.version})`)}</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-label-2">
            {view.versionChange === null
              ? L(lang, '这是这个场景的第 1 题，其余几题都是在它的基础上改的。', 'This is #1 of the scenario; the others are changes to it.')
              : <>{L(lang, '和第 1 题相比，改的是：', 'What differs from #1: ')}<span className="text-label-1">{view.versionChange}</span></>}
          </p>
        </>
      )}

      <p className="eyebrow mt-6">{L(lang, '找过的人', 'People you contacted')}</p>
      {r.questionsAsked === 0 ? <p className="mt-1.5 text-[13px] text-label-3">{L(lang, '没有问过任何人。', 'Nobody was asked.')}</p> : (
        <ul className="mt-2 space-y-1.5">
          {Object.entries(r.askedByPerson).filter(([who]) => who !== 'pilot' && who !== 'wait').sort((a, b) => b[1] - a[1]).map(([who, n]) => (
            <li key={who} className="flex items-center gap-2.5 text-[13px]">
              <Avatar name={name(who)} className="size-6 text-[11px]" />
              <span className="min-w-0 flex-1 truncate">{name(who)}</span>
              {r.offLimits.includes(who) && <Pill tone="warn">{L(lang, '不该打扰', 'Should not have been bothered')}</Pill>}
              <span className="font-mono text-xs text-label-3 tabular-nums">{n}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        <Button size="sm" tone="secondary" onClick={onTimeline}>{L(lang, '回看过程', 'Look back over the run')}</Button>
        <ButtonLink to={`/cases/${view.caseId}`} size="sm" tone="secondary">{L(lang, '再做一次', 'Try again')}</ButtonLink>
      </div>
    </div>
  );
}

function Blocked({ lang, message, retry }: { lang: Lang; message: string; retry: () => void }) {
  const auth = useAuth();
  const me = useMe();
  const needsSignIn = /登录|sign in/i.test(message) && !me?.user;
  // Signed in from the dialog: try the run again (the account now owns this browser's runs).
  const signedIn = !!me?.user;
  useEffect(() => { if (signedIn) retry(); }, [signedIn, retry]);
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="card max-w-md p-8 text-center">
        <p className="text-lg font-semibold">{message}</p>
        <div className="mt-6 flex justify-center gap-2">
          {needsSignIn && <Button onClick={() => auth.open('login')}>{L(lang, '登录', 'Sign in')}</Button>}
          <ButtonLink to="/cases" tone="secondary">{L(lang, '去题库', 'Browse cases')}</ButtonLink>
        </div>
      </div>
    </div>
  );
}
