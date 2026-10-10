/**
 * Admin dashboard: a row of headline numbers, the last 30 days as three small column charts
 * (new users, runs started, runs graded) sharing one hover readout, the score-rate distribution,
 * and per-case practice counts. Charts are plain SVG/CSS, no chart library.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Empty } from '@/components/ui';
import { downloadCsv, useAdminToken, type AdminApi } from '@/lib/admin';
import { L, type Lang } from '@/lib/i18n';

type Stats = {
  totals: { users: number; admins: number; banned: number; runs: number; graded: number; active7: number; anonymousLearners: number; avgRate: number | null };
  series: { day: string; users: number; runs: number; graded: number }[];
  cases: { caseId: string; title: string; started: number; graded: number; avgRate: number | null }[];
  distribution: { from: number; to: number; n: number }[];
};

// Series colours come from theme tokens so they follow light/dark mode. Checked with the dataviz
// palette validator on white: adjacent CVD ΔE ≥ 15. Teal is under 3:1 on white, so every series is
// also named in text and the numbers are in a table view.
const SERIES = [
  { key: 'users', color: 'var(--color-link)', zh: '新用户', en: 'New users' },
  { key: 'runs', color: 'var(--color-brand-text)', zh: '开始练习', en: 'Runs started' },
  { key: 'graded', color: 'var(--color-easy)', zh: '完成评分', en: 'Graded' },
] as const;
const BAR = 'var(--color-link)';
const GRID = 'var(--color-border)';
const AXIS = 'var(--color-label-4)';

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const fmt = (n: number) => n.toLocaleString('en-US');
const shortDay = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** Smallest of 1, 2, 5 × 10^k that is ≥ v (v > 0). */
function niceMax(v: number) {
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * mag >= v) return m * mag;
  return 10 * mag;
}

/** Column with a 4px rounded data end, square at the baseline. */
function columnPath(x: number, baseline: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  const top = baseline - h;
  return `M${x},${baseline}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${baseline}Z`;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function AdminDashboard({ adminApi, lang }: { adminApi: AdminApi; lang: Lang }) {
  const { token } = useAdminToken();
  const [stats, setStats] = useState<Stats>();
  const [error, setError] = useState<string>();
  const [loadedAt, setLoadedAt] = useState<Date>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(() => {
    adminApi<Stats>('/api/admin/stats').then((s) => { setStats(s); setError(undefined); setLoadedAt(new Date()); }).catch((e) => setError((e as Error).message));
  }, [adminApi]);
  useEffect(load, [load]);

  async function exportCsv(kind: 'users' | 'runs') {
    setBusy(kind);
    try { await downloadCsv(`/api/admin/export/${kind}.csv`, `fde-gym-${kind}.csv`, token); setError(undefined); }
    catch (e) { setError((e as Error).message); } finally { setBusy(undefined); }
  }

  const toolbar = (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-label-3">
        {loadedAt && <>{L(lang, '数据截至', 'As of')} {loadedAt.toLocaleTimeString(lang === 'en' ? 'en-SG' : 'zh-CN', { hour: '2-digit', minute: '2-digit' })} · </>}
        {L(lang, '按 UTC 日期统计', 'Days are in UTC')}
        <button type="button" onClick={load} className="ml-2 text-link hover:underline">{L(lang, '刷新', 'Refresh')}</button>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" tone="outline" disabled={busy === 'users'} onClick={() => void exportCsv('users')}><DownloadIcon />{L(lang, '用户 CSV', 'Users CSV')}</Button>
        <Button size="sm" tone="outline" disabled={busy === 'runs'} onClick={() => void exportCsv('runs')}><DownloadIcon />{L(lang, '练习记录 CSV', 'Runs CSV')}</Button>
      </div>
    </div>
  );

  if (!stats) {
    return (
      <>
        {toolbar}
        {error
          ? <p className="mt-4 rounded-lg bg-bad/10 px-4 py-3 text-sm text-bad">{error}</p>
          : <div className="flex items-center gap-2 py-16 text-label-3"><span className="size-4 animate-spin rounded-full border-2 border-fill-1 border-t-label-3" />{L(lang, '加载中……', 'Loading…')}</div>}
      </>
    );
  }

  const t = stats.totals;
  const runs30 = stats.series.reduce((a, d) => a + d.runs, 0);
  return (
    <>
      {toolbar}
      {error && <p className="mt-4 rounded-lg bg-bad/10 px-4 py-3 text-sm text-bad">{error}</p>}

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label={L(lang, '注册用户', 'Members')} value={fmt(t.users)}
          sub={L(lang, `管理员 ${t.admins} · 停用 ${t.banned}`, `${t.admins} admin · ${t.banned} banned`)} />
        <Stat label={L(lang, '7 天活跃', 'Active, 7 days')} value={fmt(t.active7)}
          sub={L(lang, '练习过的人，含匿名', 'Practised, incl. anon.')} />
        <Stat label={L(lang, '练习次数', 'Runs')} value={fmt(t.runs)}
          sub={L(lang, `近 30 天 ${runs30}`, `${runs30} in 30 days`)} />
        <Stat label={L(lang, '已评分', 'Graded')} value={fmt(t.graded)}
          sub={t.runs ? L(lang, `完成率 ${pct(t.graded / t.runs)}`, `${pct(t.graded / t.runs)} of runs`) : L(lang, '还没有练习', 'No runs yet')} />
        <Stat label={L(lang, '平均得分率', 'Mean score rate')} value={pct(t.avgRate)}
          sub={t.avgRate === null ? L(lang, '还没有已评分的练习', 'Nothing graded yet') : <Meter value={t.avgRate} />} />
        <Stat label={L(lang, '匿名学员', 'Anonymous learners')} value={fmt(t.anonymousLearners)}
          sub={L(lang, '未注册的练习者', 'Not signed up')} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section className="card p-5 lg:col-span-2">
          <CardTitle sub={L(lang, '每日数量，悬停或用方向键查看', 'Per day. Hover, or focus and use arrow keys')}>{L(lang, '近 30 天趋势', 'Last 30 days')}</CardTitle>
          <Trend series={stats.series} lang={lang} />
        </section>
        <section className="card p-5">
          <CardTitle sub={L(lang, `${t.graded} 次已评分练习的得分率`, `Score rate of ${t.graded} graded runs`)}>{L(lang, '得分率分布', 'Score distribution')}</CardTitle>
          <Distribution buckets={stats.distribution} avg={t.avgRate} lang={lang} />
        </section>
      </div>

      <CaseTable rows={stats.cases} lang={lang} />
    </>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d="M8 2.5v7.5m0 0L5 7m3 3 3-3M3 12.5h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CardTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-semibold">{children}</h2>
      {sub && <p className="mt-0.5 text-xs text-label-3">{sub}</p>}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: ReactNode }) {
  return (
    <div className="card min-w-0 p-4">
      <p className="truncate text-[13px] text-label-3">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      <div className="mt-1.5 truncate text-xs text-label-3" title={typeof sub === 'string' ? sub : undefined}>{sub}</div>
    </div>
  );
}

/** 0–1 meter on a grey track. */
function Meter({ value, className = '' }: { value: number; className?: string }) {
  return (
    <span className={`block h-1.5 w-full overflow-hidden rounded-full bg-fill-3 ${className}`}>
      <span className="block h-full rounded-full" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: BAR }} />
    </span>
  );
}

// ---- 30-day trend: three stacked panels, one per series, sharing the x axis and the readout

const GUTTER = 30;
const LABEL_H = 22;
const PLOT_H = 52;
const PANEL_GAP = 14;
const XAXIS_H = 22;

function Trend({ series, lang }: { series: Stats['series']; lang: Lang }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const n = series.length;
  const panelH = LABEL_H + PLOT_H + PANEL_GAP;
  const height = SERIES.length * panelH - PANEL_GAP + XAXIS_H;
  const slot = width > GUTTER ? (width - GUTTER) / n : 0;
  const barW = Math.max(2, Math.min(24, slot * 0.68, slot - 2));
  const ticks = [0, 7, 14, 21, n - 1].filter((i) => i >= 0 && i < n);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setHi((h) => Math.max(0, (h ?? n) - 1)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setHi((h) => Math.min(n - 1, (h ?? -1) + 1)); }
    if (e.key === 'Escape') setHi(null);
  }

  const d = hi !== null ? series[hi] : undefined;
  const tipX = hi !== null ? GUTTER + (hi + 0.5) * slot : 0;
  return (
    <div>
      <div ref={box} className="relative w-full">
        {width > 0 && (
          <svg width={width} height={height} className="block touch-none outline-none" tabIndex={0} onKeyDown={onKey}
            onFocus={() => setHi((h) => h ?? n - 1)} onBlur={() => setHi(null)} onPointerLeave={() => setHi(null)}
            role="img" aria-label={L(lang, '近 30 天每日新用户、开始练习、完成评分的柱状图', 'Daily new users, runs started and runs graded over the last 30 days')}>
            {SERIES.map((s, si) => {
              const top = si * panelH;
              const base = top + LABEL_H + PLOT_H;
              const values = series.map((x) => x[s.key]);
              const total = values.reduce((a, b) => a + b, 0);
              const peak = Math.max(0, ...values);
              const max = peak > 0 ? niceMax(peak) : 1;
              return (
                <g key={s.key}>
                  <rect x={0} y={top + 5} width={10} height={10} rx={2} fill={s.color} />
                  <text x={16} y={top + 14} fontSize={12} fill="var(--color-label-2)">
                    {L(lang, s.zh, s.en)}<tspan fill="var(--color-label-3)">{L(lang, ` · 30 天共 ${total}`, ` · ${total} in 30 days`)}</tspan>
                  </text>
                  {hi !== null && <rect x={GUTTER + hi * slot} y={top + LABEL_H - 4} width={slot} height={PLOT_H + 4} fill="var(--color-fill-4)" />}
                  {peak > 0 && <>
                    <line x1={GUTTER} x2={width} y1={top + LABEL_H + 0.5} y2={top + LABEL_H + 0.5} stroke={GRID} />
                    <text x={GUTTER - 6} y={top + LABEL_H + 4} fontSize={11} textAnchor="end" fill="var(--color-label-3)" className="tabular-nums">{max}</text>
                  </>}
                  <text x={GUTTER - 6} y={base + 4} fontSize={11} textAnchor="end" fill="var(--color-label-3)" className="tabular-nums">0</text>
                  {values.map((v, i) => v > 0 && (
                    <path key={i} d={columnPath(GUTTER + i * slot + (slot - barW) / 2, base, barW, Math.max(2, (v / max) * PLOT_H))} fill={s.color}
                      opacity={hi === null || hi === i ? 1 : 0.55} />
                  ))}
                  <line x1={GUTTER} x2={width} y1={base + 0.5} y2={base + 0.5} stroke={AXIS} />
                  {peak === 0 && (
                    <text x={GUTTER + (width - GUTTER) / 2} y={base - PLOT_H / 2 + 4} fontSize={12} textAnchor="middle" fill="var(--color-label-4)">
                      {L(lang, '这 30 天都是 0', 'Zero every day')}
                    </text>
                  )}
                </g>
              );
            })}
            {ticks.map((i, k) => (
              <text key={i} x={k === 0 ? GUTTER + (slot - barW) / 2 : k === ticks.length - 1 ? width : GUTTER + (i + 0.5) * slot}
                y={height - 6} fontSize={11} fill="var(--color-label-3)" className="tabular-nums"
                textAnchor={k === 0 ? 'start' : k === ticks.length - 1 ? 'end' : 'middle'}>
                {shortDay(series[i].day)}
              </text>
            ))}
            {/* Hit targets: the whole day column across all three panels. */}
            {series.map((_, i) => (
              <rect key={i} x={GUTTER + i * slot} y={0} width={slot} height={height - XAXIS_H} fill="transparent"
                onPointerEnter={() => setHi(i)} onPointerDown={() => setHi(i)} />
            ))}
          </svg>
        )}
        {d && (
          <div className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-lg bg-layer-1 px-3 py-2 text-xs shadow-menu"
            style={tipX > width / 2 ? { right: width - tipX + slot / 2 + 6 } : { left: tipX + slot / 2 + 6 }}>
            <p className="mb-1.5 text-label-3">{d.day}</p>
            {SERIES.map((s) => (
              <p key={s.key} className="flex items-center gap-2 py-0.5">
                <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                <span className="w-6 font-semibold text-label-1 tabular-nums">{d[s.key]}</span>
                <span className="text-label-2">{L(lang, s.zh, s.en)}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-label-3 select-none hover:text-label-1">{L(lang, '查看每日数据表', 'Show daily table')}</summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-lg bg-fill-4">
          <table className="w-full tabular-nums">
            <thead className="sticky top-0 bg-layer-2 text-label-3">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">{L(lang, '日期', 'Day')}</th>
                {SERIES.map((s) => <th key={s.key} className="px-3 py-1.5 text-right font-medium">{L(lang, s.zh, s.en)}</th>)}
              </tr>
            </thead>
            <tbody>
              {[...series].reverse().map((r) => (
                <tr key={r.day} className="even:bg-fill-4">
                  <td className="px-3 py-1 text-label-2">{r.day}</td>
                  {SERIES.map((s) => <td key={s.key} className={`px-3 py-1 text-right ${r[s.key] ? 'text-label-1' : 'text-label-4'}`}>{r[s.key]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

// ---- score-rate distribution: horizontal bars, highest band on top

function Distribution({ buckets, avg, lang }: { buckets: Stats['distribution']; avg: number | null; lang: Lang }) {
  const total = buckets.reduce((a, b) => a + b.n, 0);
  const max = Math.max(1, ...buckets.map((b) => b.n));
  const band = (b: Stats['distribution'][number]) => `${Math.round(b.from * 100)}–${Math.round(b.to * 100)}%`;
  return (
    <div>
      <div className="space-y-1">
        {[...buckets].reverse().map((b) => {
          const tip = L(lang, `得分率 ${band(b)}：${b.n} 次`, `Score ${band(b)}: ${b.n} runs`) + (total ? ` (${pct(b.n / total)})` : '');
          return (
            <div key={b.from} title={tip} className="group grid grid-cols-[64px_1fr] items-center gap-2 rounded-md py-1 hover:bg-fill-4">
              <span className="pl-1 text-right text-xs text-label-3 tabular-nums">{band(b)}</span>
              <div className="flex h-5 items-center border-l border-label-4">
                {b.n > 0 && <span className="h-5 rounded-r-[4px] transition-opacity group-hover:opacity-80" style={{ width: `calc((100% - 72px) * ${b.n / max})`, minWidth: 3, background: BAR }} />}
                <span className={`ml-2 text-xs tabular-nums whitespace-nowrap ${b.n ? 'text-label-1' : 'text-label-4'}`}>
                  {b.n}{total > 0 && b.n > 0 && <span className="text-label-3"> · {pct(b.n / total)}</span>}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-4 border-t border-divider pt-3 text-xs text-label-3">
        {total
          ? L(lang, `平均得分率 ${pct(avg)}，共 ${total} 次已评分`, `Mean ${pct(avg)} over ${total} graded runs`)
          : L(lang, '还没有已评分的练习，评分完成后会出现在这里。', 'No graded runs yet. They show here once grading finishes.')}
      </p>
    </div>
  );
}

// ---- per-case table

function CaseTable({ rows, lang }: { rows: Stats['cases']; lang: Lang }) {
  const navigate = useNavigate();
  const th = 'h-10 px-3 font-medium whitespace-nowrap';
  return (
    <section className="card mt-4 overflow-hidden">
      <div className="flex items-baseline gap-2 px-5 pt-5 pb-3">
        <h2 className="text-base font-semibold">{L(lang, '各题练习情况', 'Practice by case')}</h2>
        <span className="text-sm text-label-3 tabular-nums">{rows.length}</span>
      </div>
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-y border-divider text-left text-xs text-label-3">
                <th className={`${th} pl-5`}>{L(lang, '题目', 'Case')}</th>
                <th className={`${th} text-right`}>{L(lang, '开始次数', 'Started')}</th>
                <th className={`${th} text-right`}>{L(lang, '已评分', 'Graded')}</th>
                <th className={`${th} w-56 pr-5`}>{L(lang, '平均得分率', 'Mean score rate')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.caseId} onClick={() => navigate('/admin?tab=cases')} className="group h-11 cursor-pointer transition-colors even:bg-fill-4 hover:bg-fill-3">
                  <td className="max-w-[420px] py-2 pr-3 pl-5">
                    <Link to="/admin?tab=cases" onClick={(e) => e.stopPropagation()} className="block truncate font-medium text-label-1 group-hover:text-link" title={r.title}>{r.title}</Link>
                    <p className="mt-0.5 font-mono text-xs text-label-3">{r.caseId}</p>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.started}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${r.graded ? '' : 'text-label-4'}`}>{r.graded}</td>
                  <td className="py-2 pr-5 pl-3">
                    {r.avgRate === null
                      ? <span className="text-label-4">—</span>
                      : <div className="flex items-center gap-2.5"><span className="w-10 text-right tabular-nums">{pct(r.avgRate)}</span><Meter value={r.avgRate} className="max-w-32 flex-1" /></div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="border-t border-divider"><Empty>{L(lang, '还没有人练习过。', 'Nobody has practised yet.')}</Empty></div>
      )}
    </section>
  );
}
