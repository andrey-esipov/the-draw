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

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  render: () => void;
  resize: (w: number, h: number) => void;
  dispose: () => void;
  setBloom: (strength: number) => void;
}

export function createStage(canvas: HTMLCanvasElement, w: number, h: number): Stage {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = false;

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
      },
      vertexShader: `varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform sampler2D baseTexture;
        uniform sampler2D bloomTexture;
        uniform float bloomStrength;
        varying vec2 vUv;
        void main(){
          gl_FragColor = texture2D(baseTexture, vUv)
            + texture2D(bloomTexture, vUv) * bloomStrength;
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

  function render() {
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
  }

  return {
    renderer,
    scene,
    camera,
    render,
    resize,
    setBloom: (s) => {
      bloomPass.strength = s;
    },
    dispose: () => {
      bloomComposer.dispose();
      finalComposer.dispose();
      half.dispose();
      finalTarget.dispose();
      renderer.dispose();
    },
  };
}
