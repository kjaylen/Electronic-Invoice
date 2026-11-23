/**
 * The sign-in backdrop: an aurora of slowly morphing gradient light (CSS), a
 * GPU fluid the pointer stirs (WebGL), a drifting particle network (2D
 * canvas), film grain and a vignette. Purely decorative: hidden from
 * assistive technology, behind everything, never in the way of the form.
 *
 * Scaled to the device: fewer particles and a coarser fluid on phones and
 * small machines; without WebGL there is no fluid; with reduced motion
 * nothing moves (the aurora stays as a still gradient). Everything stops
 * while the tab is hidden and is torn down on unmount.
 */

import { type RefObject, useEffect, useRef, useState } from 'react';
import { startFluid } from './fluid';
import { startParticles } from './particles';

const DYE: Array<[number, number, number]> = [
  [1.0, 1.0, 1.0], // white
  [0.88, 0.82, 1.0], // lavender
  [0.74, 0.58, 1.0], // soft violet
  [0.93, 0.78, 1.0], // lilac
];
const SPARKS: Array<[number, number, number]> = [
  [255, 255, 255],
  [243, 232, 255],
  [221, 214, 254],
];

function quality() {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  const cores = navigator.hardwareConcurrency ?? 8;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const low = cores <= 4 || memory <= 4;
  if (small || (coarse && low)) return { sim: 64, dye: 320, iterations: 10, fluidRatio: 1, sparks: 12, area: 12000, sparkRatio: 1.25 };
  if (coarse || low || window.innerWidth < 1024) return { sim: 80, dye: 512, iterations: 14, fluidRatio: 1, sparks: 28, area: 15000, sparkRatio: 1.5 };
  return { sim: 112, dye: 768, iterations: 18, fluidRatio: 1.25, sparks: 46, area: 14000, sparkRatio: 1.75 };
}

export function AuthScene() {
  const fluidRef = useRef<HTMLCanvasElement>(null);
  const sparksRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<{ fluid: boolean; sparks: boolean; still: boolean }>({ fluid: false, sparks: false, still: false });
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setState({ fluid: false, sparks: false, still: true });
      return;
    }
    const q = quality();
    // Only the panel responds to the pointer, not the form beside it.
    const input = fluidRef.current?.closest<HTMLElement>('.lux-art') ?? undefined;
    let fluid: { dispose(): void } | null = null;
    let sparks: { dispose(): void } | null = null;
    try {
      if (fluidRef.current) fluid = startFluid(fluidRef.current, { simResolution: q.sim, dyeResolution: q.dye, pressureIterations: q.iterations, maxPixelRatio: q.fluidRatio, palette: DYE, input });
    } catch {
      fluid = null; // No WebGL (or no float textures): the aurora and particles carry it.
    }
    try {
      if (sparksRef.current) sparks = startParticles(sparksRef.current, { areaPerParticle: q.area, maxParticles: q.sparks, linkDistance: 110, maxPixelRatio: q.sparkRatio, colors: SPARKS, input });
    } catch {
      sparks = null;
    }
    // Fade in after the first frames have painted.
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setState({ fluid: Boolean(fluid), sparks: Boolean(sparks), still: false })));
    return () => {
      cancelAnimationFrame(id);
      fluid?.dispose();
      sparks?.dispose();
    };
  }, []);
  return (
    <div className={`lux-scene${state.still ? ' still' : ''}`} aria-hidden="true">
      <div className="lux-aurora">
        <span className="blob b1" />
        <span className="blob b2" />
        <span className="blob b3" />
        <span className="blob b4" />
        <span className="blob b5" />
      </div>
      <canvas ref={fluidRef} className={`lux-fluid${state.fluid ? ' on' : ''}`} />
      <canvas ref={sparksRef} className={`lux-sparks${state.sparks ? ' on' : ''}`} />
      <div className="lux-grain" />
      <div className="lux-vignette" />
    </div>
  );
}

/**
 * Pointer parallax: sets --px and --py (-1..1, eased) on the element, for
 * layers to drift against. Off for reduced motion and touch-only screens.
 */
export function useParallax(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !window.matchMedia('(hover: hover)').matches) return;
    let tx = 0;
    let ty = 0;
    let x = 0;
    let y = 0;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      tx = ((e.clientX - r.left) / r.width) * 2 - 1;
      ty = ((e.clientY - r.top) / r.height) * 2 - 1;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const onLeave = () => {
      tx = 0;
      ty = 0;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const tick = () => {
      x += (tx - x) * 0.08;
      y += (ty - y) * 0.08;
      el.style.setProperty('--px', x.toFixed(4));
      el.style.setProperty('--py', y.toFixed(4));
      frame = Math.abs(tx - x) + Math.abs(ty - y) > 0.001 ? requestAnimationFrame(tick) : 0;
    };
    el.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      cancelAnimationFrame(frame);
    };
  }, [ref]);
}
