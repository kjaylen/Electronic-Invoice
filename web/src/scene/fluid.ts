/**
 * A real-time 2D fluid on the GPU (WebGL2, or WebGL1 with half-float
 * textures): stable-fluids style. Each frame the velocity field gets its
 * vorticity reinforced, is made divergence-free (a Jacobi pressure solve and
 * gradient subtraction) and advected along itself; dye is advected through
 * it and slowly dissipates. The pointer injects velocity and dye; a click or
 * tap makes a splash. Rendered opaque over black, meant for `mix-blend-mode:
 * screen` over whatever is behind the canvas.
 *
 * Throws when the GPU cannot do it (no WebGL, no renderable half floats,
 * a shader that does not compile): callers fall back to no fluid.
 */

export interface FluidOptions {
  /** Velocity grid, on the short side (cells). */
  simResolution: number;
  /** Dye texture, on the short side (texels). */
  dyeResolution: number;
  /** Pressure solve iterations per frame. */
  pressureIterations: number;
  /** Device-pixel cap for the visible canvas. */
  maxPixelRatio: number;
  /** Dye colours (linear 0..1), picked at random for each stroke. */
  palette: Array<[number, number, number]>;
  /** Gentle automatic splats when nobody is moving the pointer. */
  ambient?: boolean;
  /** Where pointer input is taken from (default: the whole window). */
  input?: HTMLElement;
}

export interface Fluid {
  /** A splat at a point (0..1, origin bottom-left) with a velocity (pixels per frame) and colour. */
  splat(x: number, y: number, dx: number, dy: number, color: [number, number, number]): void;
  dispose(): void;
}

const VELOCITY_DISSIPATION = 0.4;
const DYE_DISSIPATION = 1.6;
const PRESSURE_DECAY = 0.8;
const CURL = 10;
const SPLAT_RADIUS = 0.0022;
const SPLAT_FORCE = 3000;

// ---------- shaders (GLSL ES 1.00: runs in WebGL1 and WebGL2) ----------

const BASE_VERTEX = `
precision highp float;
attribute vec2 aPosition;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform vec2 texelSize;
void main () {
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const SPLAT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;
void main () {
  vec2 p = vUv - point;
  p.x *= aspectRatio;
  vec3 splat = exp(-dot(p, p) / radius) * color;
  gl_FragColor = vec4(texture2D(uTarget, vUv).xyz + splat, 1.0);
}`;

const ADVECTION = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform vec2 sourceTexelSize;
uniform float dt;
uniform float dissipation;
#ifdef MANUAL_FILTERING
vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
  vec2 st = uv / tsize - 0.5;
  vec2 iuv = floor(st);
  vec2 fuv = fract(st);
  vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
  vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
  vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
  vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}
#endif
void main () {
#ifdef MANUAL_FILTERING
  vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
  vec4 result = bilerp(uSource, coord, sourceTexelSize);
#else
  vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
  vec4 result = texture2D(uSource, coord);
#endif
  gl_FragColor = result / (1.0 + dissipation * dt);
}`;

const DIVERGENCE = `
precision highp float;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uVelocity;
void main () {
  float L = texture2D(uVelocity, vL).x;
  float R = texture2D(uVelocity, vR).x;
  float T = texture2D(uVelocity, vT).y;
  float B = texture2D(uVelocity, vB).y;
  vec2 C = texture2D(uVelocity, vUv).xy;
  if (vL.x < 0.0) { L = -C.x; }
  if (vR.x > 1.0) { R = -C.x; }
  if (vT.y > 1.0) { T = -C.y; }
  if (vB.y < 0.0) { B = -C.y; }
  gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;

const CURL_SHADER = `
precision highp float;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uVelocity;
void main () {
  float L = texture2D(uVelocity, vL).y;
  float R = texture2D(uVelocity, vR).y;
  float T = texture2D(uVelocity, vT).x;
  float B = texture2D(uVelocity, vB).x;
  gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`;

const VORTICITY = `
precision highp float;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main () {
  float L = texture2D(uCurl, vL).x;
  float R = texture2D(uCurl, vR).x;
  float T = texture2D(uCurl, vT).x;
  float B = texture2D(uCurl, vB).x;
  float C = texture2D(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 velocity = texture2D(uVelocity, vUv).xy + force * dt;
  gl_FragColor = vec4(clamp(velocity, -1000.0, 1000.0), 0.0, 1.0);
}`;

const PRESSURE = `
precision highp float;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main () {
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  float divergence = texture2D(uDivergence, vUv).x;
  gl_FragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADIENT_SUBTRACT = `
precision highp float;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main () {
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  vec2 velocity = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
  gl_FragColor = vec4(velocity, 0.0, 1.0);
}`;

const SCALE = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform float value;
void main () {
  gl_FragColor = value * texture2D(uTexture, vUv);
}`;

/** The dye, softly lit from its own gradient (a sense of depth) and tone-mapped so it never clips. */
const DISPLAY = `
precision highp float;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uTexture;
void main () {
  vec3 c = texture2D(uTexture, vUv).rgb;
  float dx = length(texture2D(uTexture, vR).rgb) - length(texture2D(uTexture, vL).rgb);
  float dy = length(texture2D(uTexture, vT).rgb) - length(texture2D(uTexture, vB).rgb);
  vec3 n = normalize(vec3(dx, dy, 0.35));
  float light = clamp(dot(n, normalize(vec3(-0.4, 0.6, 1.0))) * 0.55 + 0.6, 0.45, 1.15);
  c *= light;
  c = vec3(1.0) - exp(-c * 1.35);
  gl_FragColor = vec4(c, 1.0);
}`;

// ---------- GL plumbing ----------

type GL = WebGL2RenderingContext | WebGLRenderingContext;

interface Target {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  texelX: number;
  texelY: number;
  attach(unit: number): number;
}

interface DoubleTarget {
  width: number;
  height: number;
  texelX: number;
  texelY: number;
  read: Target;
  write: Target;
  swap(): void;
}

interface Formats {
  type: number;
  rgba: { internal: number; format: number };
  rg: { internal: number; format: number };
  r: { internal: number; format: number };
  linear: boolean;
}

class Program {
  readonly program: WebGLProgram;
  readonly uniforms: Record<string, WebGLUniformLocation> = {};
  constructor(private gl: GL, vertex: WebGLShader, fragment: WebGLShader) {
    const p = gl.createProgram();
    if (!p) throw new Error('createProgram failed');
    gl.attachShader(p, vertex);
    gl.attachShader(p, fragment);
    gl.bindAttribLocation(p, 0, 'aPosition');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link failed: ${gl.getProgramInfoLog(p)}`);
    this.program = p;
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(p, i)!.name;
      this.uniforms[name] = gl.getUniformLocation(p, name)!;
    }
  }
  use() {
    this.gl.useProgram(this.program);
    return this.uniforms;
  }
}

function compile(gl: GL, type: number, source: string, defines: string[] = []): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, defines.map((d) => `#define ${d}\n`).join('') + source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`shader failed: ${gl.getShaderInfoLog(shader)}`);
  return shader;
}

function renderable(gl: GL, internal: number, format: number, type: number): boolean {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, format, type, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(tex);
  return ok;
}

function context(canvas: HTMLCanvasElement): { gl: GL; formats: Formats } {
  const attrs: WebGLContextAttributes = { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
  const gl2 = canvas.getContext('webgl2', attrs);
  if (gl2) {
    gl2.getExtension('EXT_color_buffer_float');
    const linear = Boolean(gl2.getExtension('OES_texture_float_linear')) || true; // half floats filter in WebGL2
    const type = gl2.HALF_FLOAT;
    const pick = (internal: number, format: number) => (renderable(gl2, internal, format, type) ? { internal, format } : null);
    const rgba = pick(gl2.RGBA16F, gl2.RGBA);
    if (!rgba) throw new Error('no renderable half-float textures');
    const rg = pick(gl2.RG16F, gl2.RG) ?? rgba;
    const r = pick(gl2.R16F, gl2.RED) ?? rg;
    return { gl: gl2, formats: { type, rgba, rg, r, linear } };
  }
  const gl1 = (canvas.getContext('webgl', attrs) ?? canvas.getContext('experimental-webgl', attrs)) as WebGLRenderingContext | null;
  if (!gl1) throw new Error('no WebGL');
  const half = gl1.getExtension('OES_texture_half_float');
  if (!half) throw new Error('no half-float textures');
  const linear = Boolean(gl1.getExtension('OES_texture_half_float_linear'));
  const type = half.HALF_FLOAT_OES;
  if (!renderable(gl1, gl1.RGBA, gl1.RGBA, type)) throw new Error('half-float textures are not renderable');
  const rgba = { internal: gl1.RGBA, format: gl1.RGBA };
  return { gl: gl1, formats: { type, rgba, rg: rgba, r: rgba, linear } };
}

// ---------- the simulation ----------

export function startFluid(canvas: HTMLCanvasElement, options: FluidOptions): Fluid {
  const { gl, formats } = context(canvas);
  const manual = formats.linear ? [] : ['MANUAL_FILTERING'];
  const vertex = compile(gl, gl.VERTEX_SHADER, BASE_VERTEX);
  const make = (src: string, defines: string[] = []) => new Program(gl, vertex, compile(gl, gl.FRAGMENT_SHADER, src, defines));
  const programs = {
    splat: make(SPLAT),
    advection: make(ADVECTION, manual),
    divergence: make(DIVERGENCE),
    curl: make(CURL_SHADER),
    vorticity: make(VORTICITY),
    pressure: make(PRESSURE),
    gradient: make(GRADIENT_SUBTRACT),
    scale: make(SCALE),
    display: make(DISPLAY),
  };

  // A full-screen quad, drawn for every pass.
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  const indices = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);
  gl.disable(gl.BLEND);

  const blit = (target: Target | null) => {
    if (target) {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    } else {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };

  const textures: WebGLTexture[] = [];
  const buffers: WebGLFramebuffer[] = [];
  const target = (w: number, h: number, f: { internal: number; format: number }, filter: number): Target => {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, f.internal, w, h, 0, f.format, formats.type, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    textures.push(texture);
    buffers.push(fbo);
    return {
      texture, fbo, width: w, height: h, texelX: 1 / w, texelY: 1 / h,
      attach(unit: number) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return unit;
      },
    };
  };
  const double = (w: number, h: number, f: { internal: number; format: number }, filter: number): DoubleTarget => {
    let a = target(w, h, f, filter);
    let b = target(w, h, f, filter);
    return {
      width: w, height: h, texelX: 1 / w, texelY: 1 / h,
      get read() { return a; },
      get write() { return b; },
      swap() { [a, b] = [b, a]; },
    };
  };
  const release = () => {
    for (const t of textures.splice(0)) gl.deleteTexture(t);
    for (const f of buffers.splice(0)) gl.deleteFramebuffer(f);
  };

  const resolution = (short: number) => {
    let aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1 / aspect;
    const min = Math.round(short);
    const max = Math.round(short * aspect);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? { w: max, h: min } : { w: min, h: max };
  };

  let dye!: DoubleTarget;
  let velocity!: DoubleTarget;
  let divergence!: Target;
  let curl!: Target;
  let pressure!: DoubleTarget;
  const filter = formats.linear ? gl.LINEAR : gl.NEAREST;
  const allocate = () => {
    release();
    const sim = resolution(options.simResolution);
    const dyeRes = resolution(options.dyeResolution);
    dye = double(dyeRes.w, dyeRes.h, formats.rgba, filter);
    velocity = double(sim.w, sim.h, formats.rg, filter);
    divergence = target(sim.w, sim.h, formats.r, gl.NEAREST);
    curl = target(sim.w, sim.h, formats.r, gl.NEAREST);
    pressure = double(sim.w, sim.h, formats.r, gl.NEAREST);
  };

  const fit = (): boolean => {
    const ratio = Math.min(window.devicePixelRatio || 1, options.maxPixelRatio);
    const w = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    return true;
  };
  fit();
  allocate();

  const aspect = () => canvas.width / canvas.height;
  const splat = (x: number, y: number, dx: number, dy: number, color: [number, number, number], radiusScale = 1) => {
    const u = programs.splat.use();
    gl.uniform1i(u.uTarget!, velocity.read.attach(0));
    gl.uniform1f(u.aspectRatio!, aspect());
    gl.uniform2f(u.point!, x, y);
    gl.uniform3f(u.color!, dx, dy, 0);
    const radius = SPLAT_RADIUS * radiusScale * (aspect() > 1 ? aspect() : 1);
    gl.uniform1f(u.radius!, radius);
    blit(velocity.write);
    velocity.swap();
    gl.uniform1i(u.uTarget!, dye.read.attach(0));
    gl.uniform3f(u.color!, color[0], color[1], color[2]);
    blit(dye.write);
    dye.swap();
  };

  const step = (dt: number) => {
    let u = programs.curl.use();
    gl.uniform2f(u.texelSize!, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uVelocity!, velocity.read.attach(0));
    blit(curl);

    u = programs.vorticity.use();
    gl.uniform2f(u.texelSize!, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uVelocity!, velocity.read.attach(0));
    gl.uniform1i(u.uCurl!, curl.attach(1));
    gl.uniform1f(u.curl!, CURL);
    gl.uniform1f(u.dt!, dt);
    blit(velocity.write);
    velocity.swap();

    u = programs.divergence.use();
    gl.uniform2f(u.texelSize!, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uVelocity!, velocity.read.attach(0));
    blit(divergence);

    u = programs.scale.use();
    gl.uniform1i(u.uTexture!, pressure.read.attach(0));
    gl.uniform1f(u.value!, PRESSURE_DECAY);
    blit(pressure.write);
    pressure.swap();

    u = programs.pressure.use();
    gl.uniform2f(u.texelSize!, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uDivergence!, divergence.attach(0));
    for (let i = 0; i < options.pressureIterations; i++) {
      gl.uniform1i(u.uPressure!, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    u = programs.gradient.use();
    gl.uniform2f(u.texelSize!, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uPressure!, pressure.read.attach(0));
    gl.uniform1i(u.uVelocity!, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    u = programs.advection.use();
    gl.uniform2f(u.texelSize!, velocity.texelX, velocity.texelY);
    if (u.sourceTexelSize) gl.uniform2f(u.sourceTexelSize, velocity.texelX, velocity.texelY);
    const v = velocity.read.attach(0);
    gl.uniform1i(u.uVelocity!, v);
    gl.uniform1i(u.uSource!, v);
    gl.uniform1f(u.dt!, dt);
    gl.uniform1f(u.dissipation!, VELOCITY_DISSIPATION);
    blit(velocity.write);
    velocity.swap();

    if (u.sourceTexelSize) gl.uniform2f(u.sourceTexelSize, dye.texelX, dye.texelY);
    gl.uniform1i(u.uVelocity!, velocity.read.attach(0));
    gl.uniform1i(u.uSource!, dye.read.attach(1));
    gl.uniform1f(u.dissipation!, DYE_DISSIPATION);
    blit(dye.write);
    dye.swap();
  };

  const render = () => {
    const u = programs.display.use();
    gl.uniform2f(u.texelSize!, 1 / gl.drawingBufferWidth, 1 / gl.drawingBufferHeight);
    gl.uniform1i(u.uTexture!, dye.read.attach(0));
    blit(null);
  };

  // ---------- input ----------
  const palette = options.palette;
  const pickColor = (strength: number): [number, number, number] => {
    const c = palette[Math.floor(Math.random() * palette.length)]!;
    return [c[0] * strength, c[1] * strength, c[2] * strength];
  };
  const pointer = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, moved: false, seen: false, color: pickColor(0.07), colorAt: 0 };
  const toUv = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: 1 - (e.clientY - rect.top) / rect.height };
  };
  let lastInput = 0;
  const onMove = (e: PointerEvent) => {
    const p = toUv(e);
    if (!pointer.seen) {
      pointer.px = p.x;
      pointer.py = p.y;
      pointer.seen = true;
    } else {
      pointer.px = pointer.x;
      pointer.py = pointer.y;
    }
    pointer.x = p.x;
    pointer.y = p.y;
    pointer.moved = true;
    lastInput = performance.now();
  };
  const onDown = (e: PointerEvent) => {
    const p = toUv(e);
    pointer.x = pointer.px = p.x;
    pointer.y = pointer.py = p.y;
    pointer.seen = true;
    lastInput = performance.now();
    // A splash: a ring of outward pushes, brighter dye.
    const color = pickColor(0.18);
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      splat(p.x, p.y, Math.cos(a) * 900, Math.sin(a) * 900, [color[0] / n * 2.2, color[1] / n * 2.2, color[2] / n * 2.2], 1.6);
    }
  };
  const onLeave = () => {
    pointer.seen = false;
  };
  const input: HTMLElement | Window = options.input ?? window;
  input.addEventListener('pointermove', onMove as EventListener, { passive: true });
  input.addEventListener('pointerdown', onDown as EventListener, { passive: true });
  (options.input ?? document).addEventListener('pointerleave', onLeave);

  const applyInput = (now: number) => {
    if (!pointer.moved) return;
    pointer.moved = false;
    const dx = (pointer.x - pointer.px) * (aspect() < 1 ? aspect() : 1);
    const dy = (pointer.y - pointer.py) / (aspect() > 1 ? aspect() : 1);
    const speed = Math.hypot(dx, dy);
    if (speed < 1e-5) return;
    // A new colour every so often while moving; faster strokes carry more dye and force.
    if (now - pointer.colorAt > 1400) {
      pointer.color = pickColor(0.07);
      pointer.colorAt = now;
    }
    const boost = Math.min(1.3, 0.55 + speed * 22);
    splat(pointer.x, pointer.y, dx * SPLAT_FORCE, dy * SPLAT_FORCE, [pointer.color[0] * boost, pointer.color[1] * boost, pointer.color[2] * boost]);
  };

  // A few slow currents to start, and now and then when nobody is touching it.
  const ambientSplat = () => {
    const x = 0.15 + Math.random() * 0.7;
    const y = 0.15 + Math.random() * 0.7;
    const a = Math.random() * Math.PI * 2;
    const force = 260 + Math.random() * 380;
    splat(x, y, Math.cos(a) * force * 0.7, Math.sin(a) * force * 0.7, pickColor(0.09), 2.4);
  };
  for (let i = 0; i < 3; i++) ambientSplat();
  let nextAmbient = performance.now() + 3000;

  // ---------- the loop ----------
  let frame = 0;
  let last = performance.now();
  let running = true;
  let resizeTimer = 0;
  const loop = (now: number) => {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 1 / 60);
    last = now;
    applyInput(now);
    if (options.ambient !== false && now > nextAmbient && now - lastInput > 2500) {
      ambientSplat();
      nextAmbient = now + 4500 + Math.random() * 3500;
    }
    step(dt);
    render();
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);

  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (fit()) allocate();
    }, 120);
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
  let disposed = false;
  const onLost = (e: Event) => {
    e.preventDefault();
    running = false;
    cancelAnimationFrame(frame);
  };
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('webglcontextlost', onLost);

  return {
    splat: (x, y, dx, dy, color) => splat(x, y, dx, dy, color),
    dispose() {
      disposed = true;
      running = false;
      cancelAnimationFrame(frame);
      clearTimeout(resizeTimer);
      input.removeEventListener('pointermove', onMove as EventListener);
      input.removeEventListener('pointerdown', onDown as EventListener);
      (options.input ?? document).removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onLost);
      release();
      for (const p of Object.values(programs)) gl.deleteProgram(p.program);
      gl.deleteBuffer(quad);
      gl.deleteBuffer(indices);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
