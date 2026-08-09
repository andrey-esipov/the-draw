import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SlamId } from '../../data/types';
import { createVessel, VesselOpts } from './index';

const app = document.getElementById('app')!;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const bgCanvas = document.createElement('canvas');
bgCanvas.width = 4;
bgCanvas.height = 512;
const bgCtx = bgCanvas.getContext('2d')!;
const grad = bgCtx.createLinearGradient(0, 0, 0, 512);
grad.addColorStop(0, '#050609');
grad.addColorStop(0.62, '#0a0c11');
grad.addColorStop(1, '#161922');
bgCtx.fillStyle = grad;
bgCtx.fillRect(0, 0, 4, 512);
const bgTex = new THREE.CanvasTexture(bgCanvas);
bgTex.colorSpace = THREE.SRGBColorSpace;
scene.background = bgTex;

const pmrem = new THREE.PMREMGenerator(renderer);
const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
const envMap = envRT.texture;
scene.environment = envMap;

const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1.15, 6.4);
camera.lookAt(0, 0.55, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.55, 0);
controls.enableDamping = true;
controls.update();

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 80),
  new THREE.MeshStandardMaterial({ color: '#0a0c11', roughness: 0.58, metalness: 0.0 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const key = new THREE.DirectionalLight('#fff4e6', 2.6);
key.position.set(3.5, 5.5, 4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 20;
key.shadow.camera.left = -5;
key.shadow.camera.right = 5;
key.shadow.camera.top = 5;
key.shadow.camera.bottom = -5;
key.shadow.bias = -0.0003;
scene.add(key);

const fill = new THREE.DirectionalLight('#9fb8ff', 0.7);
fill.position.set(-4, 2.5, 2);
scene.add(fill);

const rim = new THREE.DirectionalLight('#ffffff', 1.6);
rim.position.set(-1.5, 3.5, -5);
scene.add(rim);

scene.add(new THREE.HemisphereLight('#1a2436', '#040507', 0.35));

const OPTS: Record<SlamId, VesselOpts> = {
  'australian-open-men': { metal: '#cfd6e0', accent: '#2f6dff' },
  'australian-open-women': { metal: '#cfd6e0', accent: '#2f6dff' },
  'french-open-men': { metal: '#d7dde4', accent: '#c8502a' },
  'french-open-women': { metal: '#d7dde4', accent: '#c8502a' },
  'wimbledon-men': { metal: '#dfe4ea', accent: '#0c5a37' },
  'wimbledon-women': { metal: '#dfe4ea', accent: '#0c5a37' },
  'us-open-men': { metal: '#dbe0e6', accent: '#2ea3ff' },
  'us-open-women': { metal: '#dbe0e6', accent: '#2ea3ff' },
};

const ALL: SlamId[] = [
  'australian-open-men',
  'french-open-men',
  'wimbledon-men',
  'us-open-men',
  'australian-open-women',
  'french-open-women',
  'wimbledon-women',
  'us-open-women',
];

const params = new URLSearchParams(location.search);
const only = params.get('only') as SlamId | null;

const vessels: THREE.Group[] = [];
let spin = true;

function addVessel(slam: SlamId, x: number, z = 0) {
  const g = createVessel(slam, { ...OPTS[slam], envMap });
  g.position.set(x, 0, z);
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  scene.add(g);
  vessels.push(g);
  return g;
}

if (only && ALL.includes(only)) {
  spin = false;
  addVessel(only, 0, 0);
  controls.target.set(0, 0.5, 0);
  controls.update();
} else {
  const xs = [-2.55, -0.85, 0.85, 2.55];
  ALL.slice(0, 4).forEach((s, i) => addVessel(s, xs[i], 0.9));
  ALL.slice(4).forEach((s, i) => addVessel(s, xs[i], -0.9));
}

(window as unknown as { __view: (az: number, el: number, dist: number, ty?: number) => void }).__view = (
  az,
  el,
  dist,
  ty = 0.5,
) => {
  const a = (az * Math.PI) / 180;
  const e = (el * Math.PI) / 180;
  camera.position.set(
    dist * Math.cos(e) * Math.sin(a),
    ty + dist * Math.sin(e),
    dist * Math.cos(e) * Math.cos(a),
  );
  controls.target.set(0, ty, 0);
  camera.lookAt(0, ty, 0);
  controls.update();
};

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
function animate() {
  const t = clock.getElapsedTime();
  if (spin) {
    vessels.forEach((v, i) => {
      v.rotation.y = t * 0.35 + i * 0.4;
    });
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();
