// Hero WebGL scene: the brand "signal ring" rendered as a slowly revolving
// particle torus (purple -> teal -> lime, mirroring the OKLCH gradient arc used
// across the site), wrapped in a faint dust field for depth. The camera leans
// toward the pointer, the floating cover art parallaxes with it, and the whole
// scene recedes as you scroll into the page.
//
// Progressive enhancement: skipped entirely under prefers-reduced-motion or if
// WebGL is unavailable — the CSS orbs/floats remain as the fallback backdrop.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from "three";

const VERT = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aPhase;
  uniform float uTime;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vTwinkle;
  void main() {
    float tw = sin(uTime * 1.3 + aPhase) * 0.5 + 0.5;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio * (17.0 / -mv.z) * (0.75 + tw * 0.5);
    gl_Position = projectionMatrix * mv;
    vColor = aColor;
    vTwinkle = 0.5 + tw * 0.5;
  }
`;

const FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vTwinkle;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.05, d);
    gl_FragColor = vec4(vColor, a * vTwinkle * uOpacity);
  }
`;

// Brand gradient sampled the way the CSS does it: purple to lime, arcing
// through teal instead of the muddy sRGB midpoint.
const STOPS = [new Color("#a06bff"), new Color("#38e0c8"), new Color("#86ff4a")];

function rampColor(t: number, out: Color): Color {
  // Tighten the teal crossover so the ring reads purple -> lime, not rainbow.
  t = t * t * (3 - 2 * t);
  const seg = t < 0.5 ? 0 : 1;
  return out.copy(STOPS[seg]).lerp(STOPS[seg + 1], t * 2 - seg);
}

function makeCloud(count: number, fill: (i: number, pos: Float32Array, col: Float32Array, size: Float32Array, phase: Float32Array) => void) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) fill(i, pos, col, size, phase);
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  geo.setAttribute("aColor", new BufferAttribute(col, 3));
  geo.setAttribute("aSize", new BufferAttribute(size, 1));
  geo.setAttribute("aPhase", new BufferAttribute(phase, 1));
  return geo;
}

// Approximate gaussian for a soft tube cross-section.
const gauss = () => (Math.random() + Math.random() + Math.random()) / 3 - 0.5;

function init(canvas: HTMLCanvasElement) {
  const hero = canvas.closest<HTMLElement>(".hero") ?? document.body;
  const small = window.innerWidth < 720;
  const RING_N = small ? 1600 : 3400;
  const DUST_N = small ? 350 : 900;

  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: "high-performance" });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);

  const scene = new Scene();
  const camera = new PerspectiveCamera(42, 1, 0.1, 40);
  camera.position.set(0, 0, 5.4);

  const tmp = new Color();

  // The signal ring: a particle torus, color keyed to the angle around it.
  const ringGeo = makeCloud(RING_N, (i, pos, col, size, phase) => {
    const u = Math.random() * Math.PI * 2;
    const v = Math.random() * Math.PI * 2;
    // A few strays drift wide of the tube so the ring feels alive, not drawn.
    const spread = Math.random() < 0.1 ? 3.4 : 1;
    const r = 0.46 * spread * (gauss() + gauss());
    const R = 2.85;
    pos[i * 3] = (R + r * Math.cos(v)) * Math.cos(u);
    pos[i * 3 + 1] = (R + r * Math.cos(v)) * Math.sin(u);
    pos[i * 3 + 2] = r * Math.sin(v);
    rampColor((1 - Math.cos(u)) / 2, tmp);
    col[i * 3] = tmp.r;
    col[i * 3 + 1] = tmp.g;
    col[i * 3 + 2] = tmp.b;
    size[i] = 0.55 + Math.random() * 1.1;
    phase[i] = Math.random() * Math.PI * 2;
  });

  // Sparse dust shell behind everything for parallax depth.
  const dustGeo = makeCloud(DUST_N, (i, pos, col, size, phase) => {
    const r = 4 + Math.random() * 7;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th) * 0.6;
    pos[i * 3 + 2] = -Math.abs(r * Math.cos(ph)) - 1;
    tmp.set(Math.random() < 0.5 ? "#8d7bd8" : "#9aa3c0");
    col[i * 3] = tmp.r;
    col[i * 3 + 1] = tmp.g;
    col[i * 3 + 2] = tmp.b;
    size[i] = 0.5 + Math.random() * 0.9;
    phase[i] = Math.random() * Math.PI * 2;
  });

  const material = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: dpr },
      uOpacity: { value: 0.62 },
    },
  });

  const ring = new Points(ringGeo, material);
  const dust = new Points(dustGeo, material);
  const group = new Group();
  group.add(ring, dust);
  // Tip the ring toward the viewer so it reads as a 3D object, not a circle.
  group.rotation.x = 1.12;
  scene.add(group);

  // Floating cover art joins the same pointer-space (CSS `translate` composes
  // with their scroll-driven `transform` animation).
  const floats = Array.from(hero.querySelectorAll<HTMLElement>(".hero__float[data-depth]"));

  let targetX = 0;
  let targetY = 0;
  let px = 0;
  let py = 0;
  window.addEventListener(
    "pointermove",
    (e) => {
      targetX = (e.clientX / window.innerWidth) * 2 - 1;
      targetY = (e.clientY / window.innerHeight) * 2 - 1;
    },
    { passive: true },
  );

  const resize = () => {
    const w = hero.clientWidth;
    const h = hero.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize, { passive: true });

  // Only render while the hero is on screen and the tab is visible.
  let inView = true;
  new IntersectionObserver(([entry]) => (inView = entry.isIntersecting), { threshold: 0 }).observe(hero);

  let last = performance.now();
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    if (!inView || document.hidden) {
      last = now;
      return;
    }
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    material.uniforms.uTime.value = now / 1000;
    // Revolve the ring around its own axis; let it breathe sideways.
    ring.rotation.z += dt * 0.06;
    group.rotation.y = Math.sin(now / 9000) * 0.1;

    // Eased pointer parallax.
    px += (targetX - px) * Math.min(1, dt * 3.5);
    py += (targetY - py) * Math.min(1, dt * 3.5);
    camera.position.x = px * 0.55;
    camera.position.y = -py * 0.35;
    camera.lookAt(0, 0, 0);
    for (const el of floats) {
      const depth = Number(el.dataset.depth) || 8;
      el.style.translate = `${(-px * depth).toFixed(1)}px ${(-py * depth * 0.7).toFixed(1)}px`;
    }

    // Recede + fade as the page scrolls past the hero.
    const p = Math.min(1, Math.max(0, window.scrollY / window.innerHeight));
    group.position.y = p * 1.6;
    group.position.z = -p * 2.2;
    material.uniforms.uOpacity.value = 0.62 * Math.max(0, 1 - p * 1.15);

    renderer.render(scene, camera);
  };
  requestAnimationFrame(frame);
}

const canvas = document.querySelector<HTMLCanvasElement>("canvas.hero__gl");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (canvas && !reduceMotion) {
  try {
    init(canvas);
  } catch {
    // No WebGL — the CSS orbs and floats carry the hero on their own.
    canvas.remove();
  }
}
