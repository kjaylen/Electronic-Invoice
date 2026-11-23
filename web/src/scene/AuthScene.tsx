/**
 * The sign-in panel's live layers: a GPU fluid the pointer stirs (WebGL)
 * and a faint drifting particle network (2D canvas), over the panel's CSS
 * aurora (see AuthShell). Purely decorative: hidden from assistive
 * technology and never in the way of the form.
 *
 * Scaled to the device: fewer particles and a coarser fluid on phones and
 * small machines; without WebGL there is no fluid; with reduced motion
 * neither starts. Both stop while the tab is hidden and are torn down on
 * unmount. Loaded on its own, after the page.
 */

import { useEffect, useRef, useState } from 'react';
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

export function LiveLayers() {
  const fluidRef = useRef<HTMLCanvasElement>(null);
  const sparksRef = useRef<HTMLCanvasElement>(null);
  const [on, setOn] = useState({ fluid: false, sparks: false });
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setOn({ fluid: Boolean(fluid), sparks: Boolean(sparks) })));
    return () => {
      cancelAnimationFrame(id);
      fluid?.dispose();
      sparks?.dispose();
    };
  }, []);
  return (
    <>
      <canvas ref={fluidRef} className={`lux-fluid${on.fluid ? ' on' : ''}`} />
      <canvas ref={sparksRef} className={`lux-sparks${on.sparks ? ' on' : ''}`} />
    </>
  );
}
