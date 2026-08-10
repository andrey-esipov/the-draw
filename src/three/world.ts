import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { themeFor } from '../ui/theme';

/** The board's lower edge is at -SPAN/2; the court sits just below it. */
export const FLOOR_Y = -14.4;
import type { SlamId } from '../data/types';
import type { SlamTheme } from '../ui/theme';
import { createCourt } from './court';

/** Texture folders are named for the tournament, not the event. */
export function surfaceKey(slam: SlamId): string {
  if (slam.startsWith('australian')) return 'australian-open';
  if (slam.startsWith('french')) return 'roland-garros';
  if (slam.startsWith('wimbledon')) return 'wimbledon';
  return 'us-open';
}

const BASE = import.meta.env.BASE_URL;

/** The field must reach far past the frustum so fog, not an edge, ends it. */
const GROUND_SIZE = 3200;
/** Repeat scales with size to hold the foreground grain fixed in world units. */
const GROUND_REPEAT = Math.round(GROUND_SIZE / (520 / 44));

/** Per-surface atmosphere: the light and air of the place, not its colour. */
interface Feel {
  fogDensity: number;
  ambient: number;
  ambientTint: number;
  key: number;
  keyWarm: number;
  keyPos: [number, number, number];
  rim: number;
  normal: number;
  sky: number;
  /** Skylight opposite the key. Warm sun wants a cool fill or the place reads flat. */
  fill: number;
  fillCool: number;
}

const FEEL: Record<string, Feel> = {
  // Bright high-summer Melbourne day: cool light, but the field stays dark.
  'australian-open': {
    fogDensity: 0.0128,
    ambient: 0.3,
    ambientTint: 0x4d76a0,
    key: 0.92,
    keyWarm: 0xbfe0ff,
    keyPos: [-12, 30, 20],
    rim: 58,
    normal: 0.06,
    sky: 2.6,
    fill: 0.42,
    fillCool: 0x9fc4ef,
  },
  // Warm late-afternoon Paris clay: low raking sun, warm dust in near-black.
  'roland-garros': {
    fogDensity: 0.0128,
    ambient: 0.29,
    ambientTint: 0x8a5334,
    key: 0.86,
    keyWarm: 0xffcf87,
    keyPos: [-24, 17, 20],
    rim: 54,
    normal: 0.07,
    sky: 2.4,
    fill: 0.56,
    fillCool: 0x5f8fd6,
  },
  // Cool overcast London green: soft flat light, no hard sun. Overcast is flat
  // and bright, not flat and dim, so the level sits high and the contrast low.
  wimbledon: {
    fogDensity: 0.0104,
    ambient: 0.46,
    ambientTint: 0x5c8a6c,
    key: 1.12,
    keyWarm: 0xdff0e4,
    keyPos: [-14, 27, 22],
    rim: 68,
    normal: 0.05,
    sky: 2.55,
    fill: 0.48,
    fillCool: 0xa8c2e8,
  },
  // Floodlit New York night session: dark field, one hard cold key.
  'us-open': {
    fogDensity: 0.014,
    ambient: 0.26,
    ambientTint: 0x3f628a,
    key: 0.94,
    keyWarm: 0xeaf1ff,
    keyPos: [-14, 29, 18],
    rim: 60,
    normal: 0.06,
    sky: 2.5,
    fill: 0.4,
    fillCool: 0x7fa6e0,
  },
};

export interface World {
  group: THREE.Group;
  setSlam: (slam: SlamId, theme: SlamTheme) => void;
  warm: () => void;
  dispose: () => void;
}

// One id per court surface. Warming these covers every slam, since the men's
// and women's draws at a tournament stand on the same court.
const WARM_SLAMS: SlamId[] = [
  'australian-open-men',
  'french-open-men',
  'us-open-men',
  'wimbledon-men',
];

/**
 * The room the bracket stands in: a court stretching away into fog, a key light
 * raking across it, and a dark studio environment for the metal to reflect.
 */export function createWorld(scene: THREE.Scene, renderer: THREE.WebGLRenderer): World {
  const group = new THREE.Group();
  scene.add(group);
  const court = createCourt(scene, renderer);

  const loader = new THREE.TextureLoader();
  const cache = new Map<string, THREE.Texture>();
  const load = (path: string, srgb: boolean) => {
    const hit = cache.get(path);
    if (hit) return hit;
    const t = loader.load(`${BASE}${path}`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(GROUND_REPEAT, GROUND_REPEAT);
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    cache.set(path, t);
    return t;
  };

  const groundMat = new THREE.MeshPhysicalMaterial({
    color: 0x090909,
    roughness: 0.94,
    metalness: 0,
    clearcoat: 0.04,
    clearcoatRoughness: 0.9,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, 1, 1), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = FLOOR_Y;
  group.add(ground);


  const ambient = new THREE.AmbientLight(0xffffff, 0.34);
  const key = new THREE.DirectionalLight(0xffffff, 0.95);
  key.position.set(-14, 26, 20);
  const rimL = new THREE.PointLight(0xffffff, 40, 120, 2);
  rimL.position.set(-34, 10, -14);
  const rimR = new THREE.PointLight(0xffffff, 40, 120, 2);
  rimR.position.set(34, 10, -14);
  const fill = new THREE.DirectionalLight(0xffffff, 0.24);
  fill.position.set(8, -12, 26);
  group.add(ambient, key, rimL, rimR, fill);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  let envRT: THREE.WebGLRenderTarget | null = null;
  new RGBELoader().load(
    `${BASE}env/studio.hdr`,
    (hdr) => {
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      envRT = pmrem.fromEquirectangular(hdr);
      scene.environment = envRT.texture;
      hdr.dispose();
    },
    undefined,
    () => {
      /* No environment is a dimmer scene, not a broken one. */
    },
  );

  const fog = new THREE.FogExp2(0x000000, 0.0115);
  scene.fog = fog;

  function setSlam(slam: SlamId, theme: SlamTheme) {    const k = surfaceKey(slam);
    const feel = FEEL[k] ?? FEEL.wimbledon!;
    court.setSlam(slam, theme);

    groundMat.normalMap = load(`surfaces/${k}-normal.jpg`, false);
    groundMat.roughnessMap = null;
    groundMat.normalScale.set(feel.normal, feel.normal);
    groundMat.color.set(theme.groundDeep).multiplyScalar(0.92);
    groundMat.needsUpdate = true;

    const deep = new THREE.Color(theme.groundDeep);
    const fogC = new THREE.Color(theme.fog);
    fog.color.copy(fogC);
    fog.density = feel.fogDensity;
    scene.background = fogC.clone().multiplyScalar(feel.sky);

    const flare = new THREE.Color(theme.flare);
    const heritage = new THREE.Color(theme.rim);
    const white = new THREE.Color(0xffffff);

    ambient.color.copy(new THREE.Color(feel.ambientTint));
    ambient.intensity = feel.ambient;

    key.color.copy(white).lerp(new THREE.Color(feel.keyWarm), 0.55);
    key.intensity = feel.key;
    key.position.set(feel.keyPos[0], feel.keyPos[1], feel.keyPos[2]);

    rimL.color.copy(flare).lerp(white, 0.3);
    rimL.intensity = feel.rim;
    rimR.color.copy(heritage).lerp(deep, 0.18);
    rimR.intensity = feel.rim;

    fill.color.set(feel.fillCool);
    fill.intensity = feel.fill;
  }

  // Debug hook mirroring stage.ts's __cam: lets a harness drive an in-place
  // palette swap (theme resolved from the id) so the transition can be judged
  // without a full remount. Overwritten each mount, cleared on dispose.
  (window as unknown as Record<string, unknown>).__worldSetSlam = (id: SlamId) =>
    setSlam(id, themeFor(id));

  return {
    group,
    setSlam,
    warm: () => {
      // Each surface is drawn procedurally the first time its slam is picked,
      // which lands as a stall on the click. Build the other three while the
      // room is just sitting there, so the switch has nothing left to make.
      const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 240));
      for (const id of WARM_SLAMS) {
        idle(() => {
          court.warm(id, themeFor(id));
          load(`surfaces/${surfaceKey(id)}-normal.jpg`, false);
        });
      }
    },
    dispose: () => {
      if ((window as unknown as Record<string, unknown>).__worldSetSlam) {
        delete (window as unknown as Record<string, unknown>).__worldSetSlam;
      }
      court.dispose();
    ground.geometry.dispose();
      groundMat.dispose();
      cache.forEach((t) => t.dispose());
      envRT?.dispose();
      pmrem.dispose();
      scene.environment = null;
      scene.fog = null;
      scene.background = null;
      group.removeFromParent();
    },
  };
}
