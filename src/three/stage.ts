import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** Only what sits on this layer is allowed to glow. */
export const BLOOM_LAYER = 1;
const DEBUG_NO_BLOOM = new URLSearchParams(location.search).has('nobloom');

const DARK = new THREE.MeshBasicMaterial({ color: 0x000000 });

export interface TransitionOpts {
  /** Static, motion-free fade for prefers-reduced-motion. */
  reduced?: boolean;
  /** Fires once, on the first covered frame — the moment it's safe to swap the world. */
  onCovered?: () => void;
}

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  render: () => void;
  resize: (w: number, h: number) => void;
  dispose: () => void;
  setBloom: (strength: number) => void;
  /**
   * Sweep the frame from a fully-covered wash to the live world. Meant to be
   * called on a fresh slam so the new palette resolves in through a crafted
   * light-wipe instead of a hard cut. Safe to call again mid-flight — it just
   * restarts from covered, so rapid slam-hopping never stacks or half-states.
   */
  beginTransition: (durationMs: number, opts?: TransitionOpts) => Promise<void>;
}

export function createStage(canvas: HTMLCanvasElement, w: number, h: number): Stage {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = false;
  // Checking the compile log costs a synchronous GPU flush on every new
  // program. In a shipped build that reads as a half-second freeze when the
  // slam changes, so only pay for it in development where it buys diagnosis.
  renderer.debug.checkShaderErrors = import.meta.env.DEV;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, w / h, 0.4, 400);
  camera.position.set(0, 9.5, 46);

  const half = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
  const bloomComposer = new EffectComposer(renderer, half);
  bloomComposer.renderToScreen = false;
  bloomComposer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.5, 0.2, 0.3);
  bloomComposer.addPass(bloomPass);

  const composite = new ShaderPass(
    new THREE.ShaderMaterial({
      uniforms: {
        baseTexture: { value: null },
        bloomTexture: { value: bloomComposer.renderTarget2.texture },
        bloomStrength: { value: 1 },
        // 1 = idle passthrough. During a slam change this rides 0 (fully
        // covered by the wash) up to 1 (the live world, fully resolved).
        uReveal: { value: 1 },
        uReduced: { value: reducedMotion ? 1 : 0 },
        uTime: { value: 0 },
        uAspect: { value: new THREE.Vector2(w / h, 1) },
      },
      vertexShader: `varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform sampler2D baseTexture;
        uniform sampler2D bloomTexture;
        uniform float bloomStrength;
        uniform float uReveal;
        uniform float uReduced;
        uniform float uTime;
        uniform vec2  uAspect;
        varying vec2 vUv;

        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          float a = hash(i), b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }

        // The lit floor falls off before it reaches the edge of frame, so the
        // outer rounds dissolve into the dark instead of being cut by it, and
        // the chrome along the edges always has unlit ground to sit on.
        vec3 edgeFall(vec3 col){
          vec2 d = abs(vUv - 0.5) * 2.0;
          float edge = max(pow(d.x, 2.8) * 1.05, pow(d.y, 3.0));
          float fall = 1.0 - smoothstep(0.72, 1.18, edge) * 0.62;
          float wide = smoothstep(1.25, 1.55, uAspect.x);
          float rail = 1.0 - smoothstep(0.86, 0.99, vUv.x) * 0.72 * wide;
          return col * fall * rail;
        }

        vec3 venueAtmosphere(vec3 col){
          vec2 p = vUv - 0.5;
          float t = uReduced > 0.5 ? 0.0 : uTime;

          // Two slow raking banks of venue light cross the court at different
          // depths. They stay below the bracket and trophy, so the world feels
          // occupied without turning the background into animated wallpaper.
          vec2 axis = normalize(vec2(0.84, 0.54));
          float along = dot(p, axis);
          float nearOffset = sin(t * 0.047) * 0.72;
          float farOffset = sin(t * 0.031 + 2.1) * 0.88;
          float nearBank = exp(-pow((along - nearOffset) / 0.19, 2.0));
          float farBank = exp(-pow((along - farOffset) / 0.27, 2.0));
          float courtMask = smoothstep(0.76, 0.12, length(p * vec2(0.76, 1.35)));
          float floorMask = smoothstep(0.82, 0.24, vUv.y);
          float light = (nearBank * 0.026 + farBank * 0.014) * courtMask * floorMask;

          // Fine stationary grain prevents the deep fields from reading as a
          // flat CSS gradient. It is deliberately static under reduced motion.
          float grain = hash(floor(vUv * vec2(720.0, 450.0))) - 0.5;
          vec3 atmosphere = vec3(1.0, 0.965, 0.84) * light;
          return max(vec3(0.0), col + atmosphere + grain * 0.006);
        }

        void main(){
          vec4 base = texture2D(baseTexture, vUv);
          vec3 lit = venueAtmosphere(base.rgb + texture2D(bloomTexture, vUv).rgb * bloomStrength);

          if (uReveal >= 1.0) {
            gl_FragColor = vec4(edgeFall(lit), base.a);
            return;
          }

          float p = clamp(uReveal, 0.0, 1.0);

          // The cover is the new palette blown through white, not a black dip:
          // the surface's own light flares up and settles. A lower floor keeps
          // the wash tinted by the world beneath it, and fine grain keeps it
          // alive rather than a flat sheet of white.
          float grain = vnoise(vUv * vec2(220.0, 220.0) + uTime * 2.0) - 0.5;
          vec3 wash = pow(max(lit, 0.0), vec3(0.66)) * 1.34 + 0.15;
          wash = mix(wash, vec3(dot(wash, vec3(0.333))), 0.10);
          wash += grain * 0.05;

          float cover;
          float band = 0.0;
          if (uReduced > 0.5) {
            cover = 1.0 - smoothstep(0.0, 1.0, p);
          } else {
            // A raking light-wipe that retreats along the key-light diagonal,
            // its front broken up by a noise field so it dissolves organically.
            vec2 q = (vUv - 0.5) * uAspect + 0.5;
            float axis = clamp(dot(q, normalize(vec2(1.0, 0.62))) / 1.35, 0.0, 1.0);
            float n = vnoise(vUv * vec2(3.0, 3.4) + uTime * 0.06);
            float jitter = (n - 0.5) * 0.14;
            float front = p * 1.36 - 0.18 + jitter;
            float feather = 0.18;
            cover = smoothstep(front - feather, front + 0.02, axis);
            // Two bands: a wide soft glow plus a tight hot crest, so the front
            // reads as a defined edge of light travelling across the court.
            float dist = abs(axis - front);
            band = (smoothstep(feather, 0.0, dist) * 0.55
              + smoothstep(0.05, 0.0, dist) * 0.75) * (1.0 - p * 0.35);
          }

          // A shallow chromatic breath rides the moving front and relaxes out.
          vec3 world = lit;
          if (uReduced < 0.5) {
            float ca = band * 0.0045;
            world.r = texture2D(baseTexture, vUv + vec2(ca, 0.0)).r
              + texture2D(bloomTexture, vUv + vec2(ca, 0.0)).r * bloomStrength;
            world.b = texture2D(baseTexture, vUv - vec2(ca, 0.0)).b
              + texture2D(bloomTexture, vUv - vec2(ca, 0.0)).b * bloomStrength;
          }

          vec3 col = mix(world, wash, cover);
          // Warm light bleed on the crest — the sweep that leaves the world behind it.
          col += band * vec3(1.0, 0.95, 0.86);
          gl_FragColor = vec4(edgeFall(col), base.a);
        }`,
    }),
    'baseTexture',
  );
  composite.needsSwap = true;

  const finalTarget = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
  const finalComposer = new EffectComposer(renderer, finalTarget);
  finalComposer.addPass(new RenderPass(scene, camera));
  finalComposer.addPass(composite);
  finalComposer.addPass(new OutputPass());

  const bloomLayer = new THREE.Layers();
  bloomLayer.set(BLOOM_LAYER);
  const stash = new Map<string, THREE.Material | THREE.Material[]>();
  const hidden: THREE.Object3D[] = [];

  /** Everything not on the bloom layer is blacked out for the glow pass, then restored. */
  function darken(obj: THREE.Object3D) {
    const m = obj as THREE.Mesh;
    if (!m.isMesh || bloomLayer.test(obj.layers)) return;
    if (obj.userData.isText) {
      obj.visible = false;
      hidden.push(obj);
      return;
    }
    stash.set(obj.uuid, m.material);
    m.material = DARK;
  }
  function restore(obj: THREE.Object3D) {
    const saved = stash.get(obj.uuid);
    if (saved) {
      (obj as THREE.Mesh).material = saved;
      stash.delete(obj.uuid);
    }
  }

  const bg = new THREE.Color(0x000000);
  let sceneBg: THREE.Color | THREE.Texture | null = null;

  const cu = composite.material.uniforms;
  let transActive = false;
  let transStart = 0;
  let transDur = 1;
  let coveredFired = false;
  let onCovered: (() => void) | null = null;
  let resolveTrans: (() => void) | null = null;

  function beginTransition(durationMs: number, opts?: TransitionOpts): Promise<void> {
    // A restart mid-flight resolves the prior promise so no caller is left
    // hanging when a judge hammers the slam rail.
    resolveTrans?.();
    transActive = true;
    transStart = performance.now();
    transDur = Math.max(1, durationMs);
    coveredFired = false;
    onCovered = opts?.onCovered ?? null;
    cu.uReduced.value = opts?.reduced ? 1 : 0;
    cu.uReveal.value = 0;
    return new Promise((res) => {
      resolveTrans = res;
    });
  }

  // Debug hook mirroring __cam: drive the transition from a harness.
  (window as unknown as Record<string, unknown>).__stageTransition = beginTransition;
  function advanceTransition(now: number) {
    cu.uTime.value = now * 0.001;
    if (!transActive) return;
    if (!coveredFired) {
      coveredFired = true;
      onCovered?.();
    }
    const raw = Math.min((now - transStart) / transDur, 1);
    // easeInOutCubic: the wash holds a beat to hide the swap, the light-wipe
    // sweeps through the middle, then the world settles in. That shape is what
    // makes the reveal read as authored rather than mechanical.
    const e = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
    cu.uReveal.value = e;
    if (raw >= 1) {
      transActive = false;
      cu.uReveal.value = 1;
      const done = resolveTrans;
      resolveTrans = null;
      onCovered = null;
      done?.();
    }
  }

  function render() {
    const now = performance.now();
    advanceTransition(now);
    sceneBg = scene.background;
    scene.background = bg;
    if (!DEBUG_NO_BLOOM) {
      scene.traverse(darken);
      bloomComposer.render();
      scene.traverse(restore);
      for (const o of hidden) o.visible = true;
      hidden.length = 0;
    }
    scene.background = sceneBg;
    finalComposer.render();
  }

  function resize(nw: number, nh: number) {
    camera.aspect = nw / nh;
    camera.updateProjectionMatrix();
    renderer.setSize(nw, nh);
    bloomComposer.setSize(nw, nh);
    finalComposer.setSize(nw, nh);
    bloomPass.setSize(nw, nh);
    (cu.uAspect.value as THREE.Vector2).set(nw / nh, 1);
  }

  return {
    renderer,
    scene,
    camera,
    render,
    resize,
    beginTransition,
    setBloom: (s) => {
      bloomPass.strength = s;
    },
    dispose: () => {
      if ((window as unknown as Record<string, unknown>).__stageTransition) {
        delete (window as unknown as Record<string, unknown>).__stageTransition;
      }
      bloomComposer.dispose();
      finalComposer.dispose();
      half.dispose();
      finalTarget.dispose();
      renderer.dispose();
    },
  };
}
