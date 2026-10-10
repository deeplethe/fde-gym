/**
 * The picture beside the About page's opening lines: the customer's house, a tower of crystal with
 * their data running up through it. That is where the work is, and all the picture says.
 *
 * The scene has no frame: its light spills onto the page around it. The tower is drawn, glass (two
 * faces, a lit one and a shaded one, floors and mullions as hairlines, streams of light climbing
 * some of them; .scene and .tower-* in styles.css). It keeps one shape and is sized by its own
 * width (container units), so it scales as a whole.
 */
import type { CSSProperties } from 'react';
import { L, type Lang } from '@/lib/i18n';

/** A box in the scene's own units: hundredths of its width, from its top-left corner. */
const at = (x: number, y: number, w?: number, extra?: CSSProperties): CSSProperties => ({ left: `${x}cqw`, top: `${y}cqw`, ...(w === undefined ? {} : { width: `${w}cqw` }), ...extra });

// The tower, in its own units: a tall crystal seen from a corner. The left face catches the light,
// the right one is in shade, and both are cut on a slant at the top, as a crystal is.
const TOWER = { w: 400, h: 640, edge: 205, left: 60, right: 345, topLeft: 205, topEdge: 70, topRight: 165 };
/** A point on a face: `u` from the outer edge (0) to the corner the faces share (1), `t` from the roofline (0) to the ground (1). */
const onFace = (face: 'left' | 'right', u: number, t: number): [number, number] => {
  const T = TOWER;
  const x = face === 'left' ? T.left + u * (T.edge - T.left) : T.right + u * (T.edge - T.right);
  const top = (face === 'left' ? T.topLeft : T.topRight) + u * (T.topEdge - (face === 'left' ? T.topLeft : T.topRight));
  return [x, top + t * (T.h - top)];
};
const d = (points: [number, number][]) => points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
// Where light climbs: which face, how far across it, how long one climb takes, and when it sets off.
const STREAMS: ['left' | 'right', number, number, number][] = [
  ['left', 0.2, 7, 0], ['left', 0.6, 5, 1.4], ['left', 0.8, 9, 0.6], ['left', 0.4, 11, 3],
  ['right', 0.8, 6, 0.8], ['right', 0.4, 8, 2.2], ['right', 0.6, 10, 0.2],
];
// Rooms with the lights on: face, across, from floor, to floor.
const LIT: ['left' | 'right', number, number][] = [
  ['left', 0.2, 6], ['left', 0.6, 9], ['left', 0.4, 13], ['left', 0, 16], ['left', 0.6, 18], ['left', 0.2, 20],
  ['right', 0.6, 7], ['right', 0.2, 11], ['right', 0.4, 15], ['right', 0.6, 19],
];
const FLOORS = 24, BAYS = 5;

/** The customer's house: where the work is. */
function Tower({ x, y, w }: { x: number; y: number; w: number }) {
  const T = TOWER;
  const face = (f: 'left' | 'right') => d([onFace(f, 0, 0), onFace(f, 1, 0), onFace(f, 1, 1), onFace(f, 0, 1)]) + ' Z';
  const floors = Array.from({ length: FLOORS - 1 }, (_, i) => (i + 1) / FLOORS);
  const bays = Array.from({ length: BAYS - 1 }, (_, i) => (i + 1) / BAYS);
  return (
    <svg viewBox={`0 0 ${T.w} ${T.h}`} className="scene-tower pointer-events-none absolute" style={at(x, y, w, { zIndex: 2 })} aria-hidden>
      <defs>
        <linearGradient id="tower-left" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" style={{ stopColor: 'var(--tower-lit-a)' }} /><stop offset="1" style={{ stopColor: 'var(--tower-lit-b)' }} /></linearGradient>
        <linearGradient id="tower-right" x1="1" y1="0" x2="0.6" y2="1"><stop offset="0" style={{ stopColor: 'var(--tower-shade-a)' }} /><stop offset="1" style={{ stopColor: 'var(--tower-shade-b)' }} /></linearGradient>
        <linearGradient id="tower-sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0.25" stopColor="#fff" stopOpacity="0" /><stop offset="0.5" stopColor="#fff" stopOpacity="0.5" /><stop offset="0.62" stopColor="#fff" stopOpacity="0" /></linearGradient>
        <linearGradient id="tower-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" /><stop offset="0.82" stopColor="#fff" /><stop offset="1" stopColor="#fff" stopOpacity="0.15" /></linearGradient>
        <mask id="tower-foot"><rect width={T.w} height={T.h} fill="url(#tower-fade)" /></mask>
        <clipPath id="tower-left-clip"><path d={face('left')} /></clipPath>
      </defs>
      <g mask="url(#tower-foot)">
        <path d={face('left')} fill="url(#tower-left)" />
        <path d={face('right')} fill="url(#tower-right)" />
        {/* floors and mullions, as hairlines in the glass */}
        <g className="tower-line">
          {floors.map((t) => <path key={`l${t}`} d={d([onFace('left', 0, t), onFace('left', 1, t)])} />)}
          {floors.map((t) => <path key={`r${t}`} d={d([onFace('right', 0, t), onFace('right', 1, t)])} />)}
          {bays.map((u) => <path key={`lb${u}`} d={d([onFace('left', u, 0), onFace('left', u, 1)])} />)}
          {bays.map((u) => <path key={`rb${u}`} d={d([onFace('right', u, 0), onFace('right', u, 1)])} />)}
        </g>
        {/* rooms with the lights on */}
        {LIT.map(([f, u, floor], i) => (
          <path key={i} className="tower-lit" style={{ animationDelay: `${(i * 1.7) % 6}s` }}
            d={d([onFace(f, u, floor / FLOORS), onFace(f, u + 1 / BAYS, floor / FLOORS), onFace(f, u + 1 / BAYS, (floor + 1) / FLOORS), onFace(f, u, (floor + 1) / FLOORS)]) + ' Z'} />
        ))}
        {/* light climbing the mullions: the customer's data, on the move */}
        {STREAMS.map(([f, u, seconds, delay], i) => (
          <path key={i} className="tower-flow" style={{ animationDuration: `${seconds}s`, animationDelay: `${-delay}s` }} d={d([onFace(f, u, 1), onFace(f, u, 0)])} />
        ))}
        {/* the sky across the lit face */}
        <rect x="0" y="0" width={T.w} height={T.h} fill="url(#tower-sheen)" clipPath="url(#tower-left-clip)" opacity="0.5" />
        {/* edges: the corner the faces share, and the cut at the top */}
        <path className="tower-rim" d={d([onFace('left', 0, 0), onFace('left', 1, 0), onFace('right', 0, 0)])} />
        <path className="tower-rim" d={d([onFace('left', 1, 0), onFace('left', 1, 1)])} />
        <path className="tower-edge" d={d([onFace('left', 0, 0), onFace('left', 0, 1)])} />
        <path className="tower-edge" d={d([onFace('right', 0, 0), onFace('right', 0, 1)])} />
      </g>
    </svg>
  );
}

export function HeroDiagram({ lang }: { lang: Lang }) {
  return (
    <div className="scene" role="img" aria-label={L(lang, '客户的大厦：一座水晶大厦，数据的光沿着它往上走', 'The customer’s house: a tower of crystal, with light climbing through it')}>
      {/* the light it sits in: three small sources, spilling past the scene's own edges */}
      <span aria-hidden className="scene-light scene-light-a" />
      <span aria-hidden className="scene-light scene-light-b" />
      <span aria-hidden className="scene-light scene-light-c" />
      <div className="demo-line" style={{ '--i': 0 } as CSSProperties}><Tower x={14} y={3} w={72} /></div>
    </div>
  );
}
