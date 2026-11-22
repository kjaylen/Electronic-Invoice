/**
 * The sign-in page's background: particles on a quiet flow field. A few
 * hundred soft dots drift along a slowly changing noise field, fading in and
 * out; the pointer stirs the ones near it (a gentle swirl, a slight push,
 * and a pull in the direction it moves), and they glow lime as it passes.
 *
 * Kept light: a few hundred particles moved on the CPU (one noise lookup
 * each) and drawn as a single batch of points, pixel ratio capped, and no
 * frames while the tab is hidden or the panel is off screen. Reduced
 * motion: one still frame.
 */

import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  OneFactor,
  OrthographicCamera,
  Points,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from 'three';

// ---------- 3D simplex noise (after Stefan Gustavson, public domain) ----------

const GRAD = [1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1];
const PERM = (() => {
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  return Uint8Array.from([...p, ...p]);
})();

function noise3(x: number, y: number, z: number): number {
  const F3 = 1 / 3;
  const G3 = 1 / 6;
  const s = (x + y + z) * F3;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const k = Math.floor(z + s);
  const t = (i + j + k) * G3;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const z0 = z - (k - t);
  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 1, 0];
    else if (x0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 0, 1];
    else [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 1, 0, 1];
  } else if (y0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 0, 1, 1];
  else if (x0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 0, 1, 1];
  else [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 1, 1, 0];
  const corners = [
    [x0, y0, z0, 0, 0, 0],
    [x0 - i1 + G3, y0 - j1 + G3, z0 - k1 + G3, i1, j1, k1],
    [x0 - i2 + 2 * G3, y0 - j2 + 2 * G3, z0 - k2 + 2 * G3, i2, j2, k2],
    [x0 - 1 + 3 * G3, y0 - 1 + 3 * G3, z0 - 1 + 3 * G3, 1, 1, 1],
  ] as const;
  const ii = i & 255;
  const jj = j & 255;
  const kk = k & 255;
  let n = 0;
  for (const [cx, cy, cz, di, dj, dk] of corners) {
    let tt = 0.6 - cx * cx - cy * cy - cz * cz;
    if (tt <= 0) continue;
    const g = (PERM[ii + di + PERM[jj + dj + PERM[kk + dk]!]!]! % 12) * 3;
    tt *= tt;
    n += tt * tt * (GRAD[g]! * cx + GRAD[g + 1]! * cy + GRAD[g + 2]! * cz);
  }
  return 32 * n;
}

// ---------- shaders ----------

const VERTEX = /* glsl */ `
uniform float uPixelRatio;
attribute float aAlpha;
attribute float aTint;
attribute float aSize;
varying float vAlpha;
varying float vTint;
void main() {
  vAlpha = aAlpha;
  vTint = aTint;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPixelRatio;
}
`;

/** A soft round dot with a brighter core, premultiplied and added. */
const FRAGMENT = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uTint;
varying float vAlpha;
varying float vTint;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float a = (smoothstep(1.0, 0.0, r) * 0.6 + smoothstep(0.45, 0.0, r) * 0.4) * vAlpha;
  vec3 col = mix(uBase, uTint, vTint);
  gl_FragColor = vec4(col * a, a);
}
`;

export interface FlowField {
  dispose(): void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  brightness: number;
  lime: boolean;
}

/** Start the field in `host` (which it fills). Throws when WebGL is not available. */
export function startFlowField(host: HTMLElement, options: { reducedMotion?: boolean } = {}): FlowField {
  const renderer = new WebGLRenderer({ antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(dpr);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.appendChild(renderer.domElement);

  const material = new ShaderMaterial({
    uniforms: { uBase: { value: new Color('#dcc3f7') }, uTint: { value: new Color('#7bf583') }, uPixelRatio: { value: dpr } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
  });
  const scene = new Scene();
  const camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);
  let points: Points | null = null;
  let positions = new Float32Array(0);
  let alphas = new Float32Array(0);
  let tints = new Float32Array(0);
  let sizes = new Float32Array(0);
  let particles: Particle[] = [];
  let width = 0;
  let height = 0;

  const spawn = (p: Particle, anywhere: boolean) => {
    p.x = Math.random() * width;
    p.y = Math.random() * height;
    p.vx = 0;
    p.vy = 0;
    p.life = 6 + Math.random() * 10;
    p.age = anywhere ? Math.random() * p.life : 0;
  };

  const build = () => {
    // Few, airy particles: about one per 2,400 square pixels, 140 to 460.
    const count = Math.max(140, Math.min(460, Math.round((width * height) / 2400)));
    particles = Array.from({ length: count }, () => {
      // Most are fine dust; a few are larger, softer and dimmer (depth).
      const big = Math.random() < 0.07;
      const p: Particle = {
        x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 1,
        size: big ? 8 + Math.random() * 5 : 2.6 + Math.random() * 2.4,
        brightness: big ? 0.28 : 0.6 + Math.random() * 0.4,
        lime: Math.random() < 0.08,
      };
      spawn(p, true);
      return p;
    });
    positions = new Float32Array(count * 3);
    alphas = new Float32Array(count);
    tints = new Float32Array(count);
    sizes = new Float32Array(count);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aAlpha', new BufferAttribute(alphas, 1));
    geometry.setAttribute('aTint', new BufferAttribute(tints, 1));
    geometry.setAttribute('aSize', new BufferAttribute(sizes, 1));
    if (points) {
      points.geometry.dispose();
      points.geometry = geometry;
    } else {
      points = new Points(geometry, material);
      points.frustumCulled = false;
      scene.add(points);
    }
  };

  const resize = () => {
    const rect = host.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === width && h === height) return;
    const changedALot = !width || Math.abs(w * h - width * height) / (width * height) > 0.3;
    width = w;
    height = h;
    renderer.setSize(width, height, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.right = width;
    camera.top = height;
    camera.updateProjectionMatrix();
    if (changedALot) build();
    else for (const p of particles) if (p.x > width || p.y > height) spawn(p, true);
  };
  resize();

  // ---------- the pointer ----------
  const pointer = { x: -9999, y: -9999, vx: 0, vy: 0, active: false, last: 0, strength: 0 };
  const onPointer = (e: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = rect.height - (e.clientY - rect.top);
    if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
      pointer.active = false;
      return;
    }
    const now = performance.now();
    if (pointer.active) {
      const dt = Math.max(8, now - pointer.last) / 1000;
      // Smoothed pointer velocity, in px/s.
      pointer.vx += ((x - pointer.x) / dt - pointer.vx) * 0.3;
      pointer.vy += ((y - pointer.y) / dt - pointer.vy) * 0.3;
    }
    pointer.x = x;
    pointer.y = y;
    pointer.active = true;
    pointer.last = now;
  };
  const onLeave = () => {
    pointer.active = false;
  };
  window.addEventListener('pointermove', onPointer, { passive: true });
  document.addEventListener('pointerleave', onLeave);

  // ---------- simulation ----------
  const SCALE = 0.0016; // field feature size: ~600 px
  const SPEED = 24; // px/s: unhurried
  const RADIUS = 160;
  let time = Math.random() * 100;

  const step = (dt: number) => {
    time += dt * 0.04;
    // The influence eases in when the pointer arrives and out when it leaves or rests.
    const resting = (performance.now() - pointer.last) / 1000 > 1.5;
    pointer.strength += ((pointer.active ? (resting ? 0.45 : 1) : 0) - pointer.strength) * (1 - Math.exp(-dt * 3));
    pointer.vx *= Math.exp(-dt * 2.5);
    pointer.vy *= Math.exp(-dt * 2.5);
    const ease = 1 - Math.exp(-dt * 2.2);
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]!;
      p.age += dt;
      if (p.age > p.life || p.x < -30 || p.x > width + 30 || p.y < -30 || p.y > height + 30) spawn(p, false);
      const angle = noise3(p.x * SCALE, p.y * SCALE, time) * Math.PI * 2;
      // Larger particles drift slower, as if further away.
      const depth = p.size > 7 ? 0.55 : 1;
      let tx = Math.cos(angle) * SPEED * depth;
      let ty = Math.sin(angle) * SPEED * depth;
      let near = 0;
      if (pointer.strength > 0.01) {
        const dx = p.x - pointer.x;
        const dy = p.y - pointer.y;
        const d = Math.hypot(dx, dy);
        if (d < RADIUS && d > 0.001) {
          near = (1 - d / RADIUS) ** 2 * pointer.strength;
          // A gentle swirl around the pointer, a slight push outwards, and a pull along its motion.
          tx += (-dy / d) * 70 * near + (dx / d) * 30 * near + pointer.vx * 0.3 * near;
          ty += (dx / d) * 70 * near + (dy / d) * 30 * near + pointer.vy * 0.3 * near;
        }
      }
      // Ease the velocity towards the field: smooth curves, never a jerk.
      p.vx += (tx - p.vx) * ease;
      p.vy += (ty - p.vy) * ease;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const fade = Math.max(0, Math.min(1, p.age / 1.5, (p.life - p.age) / 2));
      // Ease in and out, so particles appear and vanish softly.
      const soft = fade * fade * (3 - 2 * fade);
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = 0;
      alphas[i] = soft * p.brightness * (1 + near * 1.4);
      tints[i] = p.lime ? 0.9 : Math.min(1, near * 1.6);
      sizes[i] = p.size * (1 + near * 0.6);
    }
    const g = points!.geometry;
    g.attributes.position!.needsUpdate = true;
    g.attributes.aAlpha!.needsUpdate = true;
    g.attributes.aTint!.needsUpdate = true;
    g.attributes.aSize!.needsUpdate = true;
  };

  const draw = () => renderer.render(scene, camera);

  // ---------- the loop: only while visible ----------
  let frame = 0;
  let running = false;
  let visible = document.visibilityState === 'visible';
  let onScreen = true;
  let last = performance.now();
  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    draw();
  };
  const update = () => {
    const should = visible && onScreen && !options.reducedMotion;
    if (should && !running) {
      running = true;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    } else if (!should && running) {
      running = false;
      cancelAnimationFrame(frame);
    }
  };
  const onVisibility = () => {
    visible = document.visibilityState === 'visible';
    update();
  };
  document.addEventListener('visibilitychange', onVisibility);
  const io = new IntersectionObserver(([entry]) => {
    onScreen = Boolean(entry?.isIntersecting);
    update();
  });
  io.observe(host);
  const ro = new ResizeObserver(() => {
    resize();
    if (!running) draw();
  });
  ro.observe(host);

  step(1 / 60);
  draw();
  update();

  return {
    dispose() {
      running = false;
      cancelAnimationFrame(frame);
      io.disconnect();
      ro.disconnect();
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      points?.geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
