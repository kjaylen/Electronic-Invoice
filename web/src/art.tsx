/** Original artwork for the app: the brand mark, the floating crystals and the sign-in flow field. */

import { type CSSProperties, useEffect, useRef, useState } from 'react';

/** A folded ledger sheet with a tick: "documents, authorized". */
export function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#160923" />
      <path d="M9 7.5h10l5 5V24.5a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z" fill="#fbf8f1" />
      <path d="M19 7.5v5h5" fill="#e7dcc6" />
      <path d="M11.5 18.2l3 3 6-6.4" fill="none" stroke="#6d2d93" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="25" cy="25" r="4.2" fill="#7bf583" stroke="#160923" strokeWidth="1.6" />
    </svg>
  );
}

export function Brand({ light = false }: { light?: boolean }) {
  return (
    <>
      <BrandMark />
      <span style={light ? { color: '#fbf8f1' } : undefined}>eInvoicing<span style={{ color: light ? '#7bf583' : '#6d2d93' }}>.</span></span>
    </>
  );
}

type Shape = 'gem' | 'prism' | 'shard' | 'cube';

function CrystalShape({ shape, fill, size }: { shape: Shape; fill: string; size: number }) {
  const stroke = 'rgba(22,9,35,0.55)';
  switch (shape) {
    case 'gem':
      return (
        <svg width={size} height={size} viewBox="0 0 60 60">
          <polygon points="30,3 55,22 46,55 14,55 5,22" fill={fill} stroke={stroke} strokeWidth="1.4" />
          <polygon points="30,3 40,22 30,55 20,22" fill="rgba(255,255,255,0.18)" stroke={stroke} strokeWidth="1" />
          <polyline points="5,22 55,22" fill="none" stroke={stroke} strokeWidth="1" />
        </svg>
      );
    case 'prism':
      return (
        <svg width={size} height={size * 0.45} viewBox="0 0 80 36">
          <polygon points="6,8 64,2 74,26 16,32" fill={fill} stroke={stroke} strokeWidth="1.4" />
          <polygon points="6,8 64,2 66,8 8,14" fill="rgba(255,255,255,0.25)" />
        </svg>
      );
    case 'shard':
      return (
        <svg width={size * 0.5} height={size} viewBox="0 0 30 60">
          <polygon points="15,2 28,20 22,58 6,50 2,18" fill={fill} stroke={stroke} strokeWidth="1.4" />
          <polygon points="15,2 18,30 6,50 2,18" fill="rgba(255,255,255,0.2)" />
        </svg>
      );
    case 'cube':
      return (
        <svg width={size} height={size} viewBox="0 0 60 60">
          <polygon points="30,4 54,16 54,44 30,56 6,44 6,16" fill={fill} stroke={stroke} strokeWidth="1.4" />
          <polygon points="30,4 54,16 30,28 6,16" fill="rgba(255,255,255,0.28)" stroke={stroke} strokeWidth="1" />
          <polyline points="30,28 30,56" fill="none" stroke={stroke} strokeWidth="1" />
        </svg>
      );
  }
}

const SET: Array<{ shape: Shape; fill: string; size: number; left: string; top: string; t: number; d: number; r: number; dx: number; dy: number }> = [
  { shape: 'gem', fill: '#7bf583', size: 62, left: '68%', top: '64%', t: 10, d: 0, r: -12, dx: 8, dy: -16 },
  { shape: 'prism', fill: '#c98ae8', size: 92, left: '58%', top: '16%', t: 12, d: -3, r: 14, dx: -10, dy: 12 },
  { shape: 'shard', fill: '#e4c6f7', size: 70, left: '16%', top: '58%', t: 9, d: -1.5, r: -24, dx: 6, dy: -12 },
  { shape: 'cube', fill: '#9a5bc2', size: 46, left: '82%', top: '34%', t: 11, d: -5, r: 10, dx: -6, dy: -10 },
  { shape: 'shard', fill: '#c98ae8', size: 40, left: '40%', top: '78%', t: 8, d: -2, r: 32, dx: 5, dy: -8 },
  { shape: 'cube', fill: '#7bf583', size: 26, left: '30%', top: '24%', t: 7, d: -4, r: -8, dx: 4, dy: -6 },
];

/** Slowly drifting crystals; pure CSS animation, paused for reduced-motion users. */
export function Crystals({ count = SET.length }: { count?: number }) {
  return (
    <div className="crystals" aria-hidden="true">
      {SET.slice(0, count).map((c, i) => (
        <div
          key={i}
          className="crystal"
          style={{ left: c.left, top: c.top, '--t': `${c.t}s`, '--d': `${c.d}s`, '--r': `${c.r}deg`, '--dx': `${c.dx}px`, '--dy': `${c.dy}px` } as CSSProperties}
        >
          <CrystalShape shape={c.shape} fill={c.fill} size={c.size} />
        </div>
      ))}
    </div>
  );
}

/**
 * The interactive flow field (three.js, loaded only here and only when
 * WebGL works). Until it is ready, or without WebGL, the crystals show.
 */
export function FlowField() {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    let field: { dispose(): void } | null = null;
    let cancelled = false;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    void import('./flowfield')
      .then(({ startFlowField }) => {
        if (cancelled || !host.current) return;
        field = startFlowField(host.current, { reducedMotion });
        // Fade in on the next frame, after the first render has painted.
        requestAnimationFrame(() => !cancelled && setState('ready'));
      })
      .catch(() => !cancelled && setState('failed'));
    return () => {
      cancelled = true;
      field?.dispose();
    };
  }, []);
  return (
    <>
      {state !== 'ready' && <Crystals />}
      {state !== 'failed' && <div ref={host} className={`flow-field${state === 'ready' ? ' ready' : ''}`} aria-hidden="true" />}
    </>
  );
}

/** The left half of the sign-in and onboarding screens. */
export function AuthArt({ kicker, title, text }: { kicker: string; title: string; text: string }) {
  return (
    <aside className="auth-art">
      <FlowField />
      <div className="brand"><Brand light /></div>
      <div className="headline">
        <span className="kicker">{kicker}</span>
        <h2>{title}</h2>
        <p>{text}</p>
      </div>
      <div className="facts">
        <span>BTS e-invoicing</span>
        <span>Signed &amp; authorized</span>
        <span>Keeps working in outages</span>
      </div>
    </aside>
  );
}
