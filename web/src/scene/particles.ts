/**
 * A drifting particle network on a 2D canvas. Particles follow a slowly
 * turning flow field (so they move in currents, not at random), at three
 * depths (size, brightness, speed and parallax), with faint links between
 * neighbours found through a spatial grid. The pointer pushes them away as
 * it passes and pulls them in while pressed; nearby particles reach out to
 * it. Drawn additively with small glow sprites.
 */

export interface ParticleOptions {
  /** One particle per this many CSS pixels of screen. */
  areaPerParticle: number;
  maxParticles: number;
  /** Neighbours closer than this (CSS px) are linked. */
  linkDistance: number;
  maxPixelRatio: number;
  /** RGB colours for the particles. */
  colors: Array<[number, number, number]>;
  /** Where pointer input is taken from (default: the whole window). */
  input?: HTMLElement;
}

export interface Particles {
  dispose(): void;
}

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  z: number;
  r: number;
  c: number;
  phase: number;
}

const POINTER_RADIUS = 120;

function sprite(rgb: [number, number, number]): HTMLCanvasElement {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  const [r, gg, b] = rgb;
  g.addColorStop(0, `rgba(255,255,255,1)`);
  g.addColorStop(0.12, `rgba(${r},${gg},${b},0.95)`);
  g.addColorStop(0.35, `rgba(${r},${gg},${b},0.28)`);
  g.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return c;
}

export function startParticles(canvas: HTMLCanvasElement, options: ParticleOptions): Particles {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas');
  const sprites = options.colors.map(sprite);
  let width = 0;
  let height = 0;
  let ratio = 1;
  let particles: P[] = [];

  const spawn = (): P => {
    const z = 0.35 + Math.random() * 0.65;
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      vx: 0,
      vy: 0,
      z,
      r: 0.7 + z * z * 2.1,
      c: Math.floor(Math.random() * sprites.length),
      phase: Math.random() * Math.PI * 2,
    };
  };

  const fit = () => {
    ratio = Math.min(window.devicePixelRatio || 1, options.maxPixelRatio);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const target = Math.min(options.maxParticles, Math.round((width * height) / options.areaPerParticle));
    while (particles.length < target) particles.push(spawn());
    if (particles.length > target) particles = particles.slice(0, target);
    for (const p of particles) {
      if (p.x > width) p.x = Math.random() * width;
      if (p.y > height) p.y = Math.random() * height;
    }
  };
  fit();

  // The pointer, in CSS pixels, eased for the parallax.
  const pointer = { x: -9999, y: -9999, down: false, active: false, nx: 0.5, ny: 0.5, ex: 0.5, ey: 0.5 };
  const onMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
    pointer.nx = pointer.x / Math.max(1, width);
    pointer.ny = pointer.y / Math.max(1, height);
    pointer.active = true;
  };
  const onDown = (e: PointerEvent) => {
    onMove(e);
    pointer.down = true;
  };
  const onUp = () => {
    pointer.down = false;
  };
  const onLeave = () => {
    pointer.active = false;
    pointer.down = false;
  };
  const input: HTMLElement | Window = options.input ?? window;
  input.addEventListener('pointermove', onMove as EventListener, { passive: true });
  input.addEventListener('pointerdown', onDown as EventListener, { passive: true });
  window.addEventListener('pointerup', onUp, { passive: true });
  window.addEventListener('pointercancel', onUp, { passive: true });
  (options.input ?? document).addEventListener('pointerleave', onLeave);

  const L = options.linkDistance;
  const grid = new Map<number, number[]>();
  const cellOf = (x: number, y: number) => (Math.floor(x / L) + 1) * 4096 + (Math.floor(y / L) + 1);

  const tick = (now: number, dt: number) => {
    const t = now * 0.001;
    pointer.ex += (pointer.nx - pointer.ex) * 0.05;
    pointer.ey += (pointer.ny - pointer.ey) * 0.05;
    const R2 = POINTER_RADIUS * POINTER_RADIUS;
    for (const p of particles) {
      // A smooth, slowly changing flow field: overlapping waves, so neighbours move together.
      const a = (Math.sin(p.x * 0.0023 + t * 0.11) + Math.sin(p.y * 0.0019 - t * 0.13) + Math.sin((p.x + p.y) * 0.0012 + t * 0.07 + p.phase * 0.15)) * 1.9;
      const speed = 8 + p.z * 14;
      p.vx += (Math.cos(a) * speed - p.vx) * 0.018;
      p.vy += (Math.sin(a) * speed - p.vy) * 0.018;
      if (pointer.active) {
        const dx = p.x - pointer.x;
        const dy = p.y - pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < R2 && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const f = (1 - d / POINTER_RADIUS) ** 2;
          // Pressed: drawn in, swirling. Otherwise: nudged aside as the pointer passes.
          const k = pointer.down ? -160 : 240;
          p.vx += (dx / d) * f * k * dt + (pointer.down ? (-dy / d) * f * 160 * dt : 0);
          p.vy += (dy / d) * f * k * dt + (pointer.down ? (dx / d) * f * 160 * dt : 0);
        }
      }
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const m = 40;
      if (p.x < -m) p.x = width + m;
      else if (p.x > width + m) p.x = -m;
      if (p.y < -m) p.y = height + m;
      else if (p.y > height + m) p.y = -m;
    }
  };

  const draw = (now: number) => {
    ctx.clearRect(0, 0, width, height);
    const px = (pointer.ex - 0.5) * 26;
    const py = (pointer.ey - 0.5) * 26;
    // Where each particle is drawn: shifted by its depth, for parallax.
    const xs = new Float32Array(particles.length);
    const ys = new Float32Array(particles.length);
    grid.clear();
    particles.forEach((p, i) => {
      xs[i] = p.x - px * p.z;
      ys[i] = p.y - py * p.z;
      const key = cellOf(xs[i]!, ys[i]!);
      const cell = grid.get(key);
      if (cell) cell.push(i);
      else grid.set(key, [i]);
    });

    // Links: each pair once, from the 3×3 neighbourhood of cells.
    ctx.lineWidth = 0.7;
    for (let i = 0; i < particles.length; i++) {
      const xi = xs[i]!;
      const yi = ys[i]!;
      const cx = Math.floor(xi / L) + 1;
      const cy = Math.floor(yi / L) + 1;
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const cell = grid.get(gx * 4096 + gy);
          if (!cell) continue;
          for (const j of cell) {
            if (j <= i) continue;
            const dx = xi - xs[j]!;
            const dy = yi - ys[j]!;
            const d2 = dx * dx + dy * dy;
            if (d2 > L * L) continue;
            const alpha = (1 - Math.sqrt(d2) / L) * 0.18 * Math.min(particles[i]!.z, particles[j]!.z);
            if (alpha < 0.015) continue;
            ctx.strokeStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(xi, yi);
            ctx.lineTo(xs[j]!, ys[j]!);
            ctx.stroke();
          }
        }
      }
    }
    // The pointer joins the network.
    if (pointer.active) {
      const reach = L * 1.5;
      for (let i = 0; i < particles.length; i++) {
        const dx = xs[i]! - pointer.x;
        const dy = ys[i]! - pointer.y;
        const d = Math.hypot(dx, dy);
        if (d > reach) continue;
        const alpha = (1 - d / reach) * 0.16 * particles[i]!.z;
        ctx.strokeStyle = `rgba(243, 232, 255, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(xs[i]!, ys[i]!);
        ctx.lineTo(pointer.x, pointer.y);
        ctx.stroke();
      }
    }

    ctx.globalCompositeOperation = 'lighter';
    const t = now * 0.001;
    particles.forEach((p, i) => {
      const twinkle = 0.8 + 0.2 * Math.sin(t * (0.5 + p.z * 0.5) + p.phase);
      const size = p.r * 7;
      ctx.globalAlpha = (0.12 + p.z * 0.3) * twinkle;
      ctx.drawImage(sprites[p.c]!, xs[i]! - size / 2, ys[i]! - size / 2, size, size);
    });
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  };

  let frame = 0;
  let last = performance.now();
  let running = true;
  let disposed = false;
  const loop = (now: number) => {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    tick(now, dt);
    draw(now);
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);

  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(fit, 120);
  };
  const onVisibility = () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(frame);
    } else if (!running && !disposed) {
      running = true;
      last = performance.now();
      frame = requestAnimationFrame(loop);
    }
  };
  const resized = new ResizeObserver(onResize);
  resized.observe(canvas);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    dispose() {
      disposed = true;
      running = false;
      cancelAnimationFrame(frame);
      clearTimeout(resizeTimer);
      input.removeEventListener('pointermove', onMove as EventListener);
      input.removeEventListener('pointerdown', onDown as EventListener);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      (options.input ?? document).removeEventListener('pointerleave', onLeave);
      resized.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
