/** Original artwork for the app: the brand mark, the floating crystals and the sign-in flow field. */

import { type CSSProperties, useEffect, useId, useRef, useState } from 'react';

/** The Floreo mark (brand/floreo-mark-small.svg): an F whose arms are two leaves growing from the stem. */
export function BrandMark() {
  // Each copy needs its own gradient id (one inside a hidden element would blank the others).
  const id = `bm${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5B2384" />
          <stop offset="1" stopColor="#2E0F45" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="15" fill={`url(#${id})`} />
      <path d="M23 22.5Q32.33 8.57 48.5 13Q39.17 26.93 23 22.5Z" fill="#ffffff" />
      <path d="M23 35.5Q30.59 25.48 42.5 29.5Q34.91 39.52 23 35.5Z" fill="#D8C3EA" />
      <rect x="19.5" y="14" width="7.5" height="36" rx="3.75" fill="#ffffff" />
    </svg>
  );
}

export function Brand({ light = false }: { light?: boolean }) {
  return (
    <>
      <BrandMark />
      <span style={light ? { color: '#fbf8f1' } : undefined}>Floreo<span style={{ color: light ? '#7bf583' : '#5FD068' }}>.</span></span>
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
