/**
 * What moves around a grade. While the run is being graded: the held-out traffic going through the
 * delivered system, and how long it has been. When the score is first seen: it runs up from 0 to
 * where it stands, and an accepted run gets a throw of confetti. Both happen in a dialog in the
 * middle of the page (GradeDialog), which also offers the ways on from there; the panel at the side
 * keeps the full result. All of it stands still for someone who has asked for less motion.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui';
import { Verdict } from '@/components/Verdict';
import { L, type Lang } from '@/lib/i18n';

const still = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Requests on their way in, the system they go through, and what comes out judged. */
function Scene() {
  return (
    <div className="grading" aria-hidden>
      <div className="grading-lane">
        {[0, 1, 2, 3, 4].map((i) => <i key={i} style={{ animationDelay: `${i * -0.56}s` }} />)}
      </div>
      <div className="grading-system">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7.500 12 3l8 4.500v9L12 21l-8-4.500v-9ZM4 7.500l8 4.500 8-4.500M12 12v9" /></svg>
      </div>
      <div className="grading-lane grading-out">
        {[0, 1, 2, 3, 4].map((i) => <i key={i} style={{ animationDelay: `${i * -0.56 - 0.3}s` }} />)}
      </div>
    </div>
  );
}

/** "Grading", and how long it has been since the run was handed over. */
function Waiting({ since, lang }: { since: number | null; lang: Lang }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = since ? Math.max(0, Math.floor((now - since) / 1000)) : undefined;
  return (
    <p className="text-sm font-medium">
      {L(lang, '正在评分', 'Grading')}
      {s !== undefined && <span className="ml-2 font-mono text-xs font-normal text-label-3 tabular-nums">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>}
    </p>
  );
}

/** The side panel while a run is graded. */
export function Grading({ since, lang }: { since: number | null; lang: Lang }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <Scene />
      <div>
        <Waiting since={since} lang={lang} />
        <p className="mt-1.5 text-[13px] leading-relaxed text-label-3">{L(lang, '你的系统已经放进生产环境，正在回放留出的流量。要几分钟，可以关掉页面，稍后在“我的练习”里回来看。', 'Your system is in production and the held-out traffic is being replayed. It takes a few minutes; you can leave and come back from “My runs”.')}</p>
      </div>
    </div>
  );
}

/** The score, arriving: it runs up, the verdict follows, and an accepted run gets its confetti. */
function Arrival({ runId, net, verdict, line, lang }: { runId: string; net: number; verdict: 'accepted' | 'rejected' | 'incident'; line?: string; lang: Lang }) {
  const [fresh] = useState(() => !seenResult(runId));
  const [landed, setLanded] = useState(!fresh);
  const arrive = useCallback(() => {
    setLanded(true);
    if (fresh && sawResult(runId) && verdict === 'accepted') confetti();
  }, [fresh, runId, verdict]);
  return (
    <>
      <p className="eyebrow">{L(lang, '得分', 'Score')}</p>
      <p className={`mt-2 flex items-baseline justify-center gap-2 font-mono text-7xl font-semibold tabular-nums transition-colors duration-500 ${!landed ? '' : net < 0 ? 'text-bad' : verdict === 'accepted' ? 'text-ok' : ''}`}>
        <RollTo to={net} play={fresh} onDone={arrive} />
        <span className="text-lg font-normal text-label-3">/ 100</span>
      </p>
      <div className={`mt-4 transition-all duration-300 ${landed ? '' : 'translate-y-1 opacity-0'}`}>
        <Verdict verdict={verdict} lang={lang} className="text-sm" />
        {line && <p className="mx-auto mt-3 max-w-xs text-[13px] leading-relaxed text-label-2">{line}</p>}
      </div>
    </>
  );
}

/**
 * The grade, in the middle of the page: the wait while it is worked out, then the score as it
 * arrives, each with the ways on from there. Closing it leaves the workbench as it was, with the
 * full result in the panel at the side.
 */
export function GradeDialog({ runId, status, since, result, line, error, lang, onClose, onHome }: {
  runId: string; status: string; since: number | null;
  /** The score as people read it, once there is one. */
  result?: { net: number; verdict: 'accepted' | 'rejected' | 'incident' };
  /** What the result says, in a sentence. */
  line?: string; error?: string; lang: Lang; onClose: () => void; onHome: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const graded = status === 'graded' && result;
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-[6px]" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="w-full max-w-sm rounded-2xl bg-layer-1 px-7 pt-10 pb-6 text-center glass-thick shadow-menu" onClick={(e) => e.stopPropagation()}>
        {graded ? <Arrival runId={runId} net={result.net} verdict={result.verdict} line={line} lang={lang} />
          : status === 'grading' ? (
            <>
              <div className="flex justify-center py-3"><Scene /></div>
              <div className="mt-5"><Waiting since={since} lang={lang} /></div>
              <p className="mx-auto mt-2 max-w-xs text-[13px] leading-relaxed text-label-3">{L(lang, '你的系统已经放进生产环境，正在回放留出的流量。一般要几分钟，不用守着：结果会留在“我的练习”里。', 'Your system is in production and the held-out traffic is being replayed. It usually takes a few minutes, and there is no need to watch: the result will be in “My runs”.')}</p>
            </>
          ) : <p className="text-sm leading-relaxed text-bad">{error ?? L(lang, '评分失败', 'Grading failed')}</p>}
        <div className="mt-7 flex justify-center gap-2">
          {graded ? (
            <>
              <Button size="sm" tone="secondary" onClick={onHome}>{L(lang, '回首页', 'Back to the cases')}</Button>
              <Button size="sm" onClick={onClose}>{L(lang, '查看详情', 'See the details')}</Button>
            </>
          ) : status === 'grading' ? (
            <>
              <Button size="sm" tone="ghost" onClick={onClose}>{L(lang, '留在这里等', 'Wait here')}</Button>
              <Button size="sm" tone="secondary" onClick={onHome}>{L(lang, '回首页等待', 'Wait on the home page')}</Button>
            </>
          ) : <Button size="sm" onClick={onClose}>{L(lang, '关闭', 'Close')}</Button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A whole number that runs up (or down) from 0 to `to`, quickly at first and settling at the end.
 * With `play` false it simply stands at `to`. `onDone` is told once it has arrived.
 */
export function RollTo({ to, play, ms = 1500, onDone }: { to: number; play: boolean; ms?: number; onDone?: () => void }) {
  const [shown, setShown] = useState(play && !still() ? 0 : to);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!play || still()) { setShown(to); done.current?.(); return; }
    let frame = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setShown(Math.round(to * (1 - (1 - p) ** 4)));
      if (p < 1) frame = requestAnimationFrame(tick); else done.current?.();
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [to, play, ms]);
  return <>{shown}</>;
}

const COLOURS = ['#1d4f91', '#8fbaf0', '#30a46c', '#f5a524', '#ef8a6b', '#ffffff'];

/**
 * A throw of confetti over the whole window, from the two lower corners towards the middle, falling
 * away in a few seconds. Drawn on a canvas of its own that takes no clicks and removes itself.
 */
export function confetti() {
  if (still()) return;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '100' });
  canvas.width = w * ratio; canvas.height = h * ratio;
  ctx.scale(ratio, ratio);
  document.body.appendChild(canvas);

  const far = Math.hypot(w, h);
  const pieces = Array.from({ length: 150 }, (_, i) => {
    const left = i % 2 === 0;
    // Thrown up and inwards, each at its own angle and strength.
    const angle = (left ? -Math.PI / 3 : -2 * Math.PI / 3) + (Math.random() - 0.5) * 0.9;
    const speed = far * (0.55 + Math.random() * 0.75);
    return {
      x: left ? -10 : w + 10, y: h * (0.72 + Math.random() * 0.2),
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      w: 5 + Math.random() * 6, h: 8 + Math.random() * 8,
      turn: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 14, sway: Math.random() * Math.PI * 2,
      colour: COLOURS[Math.floor(Math.random() * COLOURS.length)], round: Math.random() < 0.2,
    };
  });
  const LASTS = 3.4;
  let last = performance.now(), age = 0, frame = 0;
  const draw = (t: number) => {
    const dt = Math.min(0.04, (t - last) / 1000);
    last = t; age += dt;
    ctx.clearRect(0, 0, w, h);
    for (const p of pieces) {
      // Air takes the throw out of it; after that it falls and drifts.
      p.vx *= 1 - 2.2 * dt; p.vy = p.vy * (1 - 2.2 * dt) + 620 * dt;
      p.x += (p.vx + Math.sin(age * 3 + p.sway) * 40) * dt; p.y += p.vy * dt;
      p.turn += p.spin * dt;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, (LASTS - age) / 0.9));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.turn);
      ctx.fillStyle = p.colour;
      // A piece seen edge-on is thin: that is what makes it flutter.
      const thin = Math.abs(Math.cos(age * 5 + p.sway));
      if (p.round) { ctx.beginPath(); ctx.ellipse(0, 0, p.w / 2, (p.w / 2) * thin, 0, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.w / 2, (-p.h / 2) * thin, p.w, p.h * thin);
      ctx.restore();
    }
    if (age < LASTS) frame = requestAnimationFrame(draw); else canvas.remove();
  };
  frame = requestAnimationFrame(draw);
  // Should the page be put away mid-throw, nothing is left drawing.
  window.addEventListener('pagehide', () => { cancelAnimationFrame(frame); canvas.remove(); }, { once: true });
}

const SEEN = 'fdegym:result-seen';
const seen = (): string[] => { try { return JSON.parse(localStorage.getItem(SEEN) ?? '[]'); } catch { return []; } };
/** Whether this run's result has been shown in this browser before. Where that cannot be kept, it counts as shown. */
export function seenResult(runId: string): boolean {
  try { localStorage.getItem(SEEN); } catch { return true; }
  return seen().includes(runId);
}
/** Note that it has been shown now; true if this was the first time. */
export function sawResult(runId: string): boolean {
  const was = seen();
  if (was.includes(runId)) return false;
  try { localStorage.setItem(SEEN, JSON.stringify([...was, runId].slice(-200))); } catch { /* shown again next time, then */ }
  return true;
}
