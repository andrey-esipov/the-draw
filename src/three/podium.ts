import * as THREE from 'three';
import { Text } from 'troika-three-text';
import type { SlamId } from '../data/types';
import type { SlamTheme } from '../ui/theme';
import { createVessel } from './vessels';
import { BLOOM_LAYER } from './stage';

const BASE = import.meta.env.BASE_URL;
const MONO = `${BASE}fonts/mono-latin.woff`;

const PLINTH_TOP = 1.72;
const SEAM_Y = 0.5;

export interface Podium {
  group: THREE.Group;
  /** 0 -> 1 reveal, driven by the cinematic. 0 = dark and empty, 1 = fully presented. */
  setReveal: (t: number) => void;
  update: (elapsedMs: number) => void;
  dispose: () => void;
}

function smooth(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const BEAM_VERT = `
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const BEAM_FRAG = `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uReveal;
  uniform float uOpacity;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    float facing = abs(dot(normalize(vNormalW), normalize(vViewDir)));
    float core = pow(facing, 2.2);
    float vertical = smoothstep(1.0, 0.02, vUv.y);
    float rise = smoothstep(0.0, 1.0, uReveal) * 1.2;
    float revealMask = smoothstep(vUv.y - 0.18, vUv.y + 0.04, rise);
    vec2 dir = normalize(vec2(vNormalW.x, vNormalW.z) + 1e-5);
    float band = vUv.y * 3.2 - uTime * 0.16;
    float shimmer = 0.78 + 0.22 * mix(
      noise(vec2(dir.x * 3.0, band)),
      noise(vec2(dir.y * 3.0 + 4.7, band * 1.13)),
      0.5
    );
    float a = core * vertical * revealMask * shimmer * uOpacity;
    gl_FragColor = vec4(uColor, a);
  }
`;

const POOL_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const POOL_FRAG = `
  uniform vec3 uColor;
  uniform float uReveal;
  uniform float uOpacity;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float d = distance(vUv, vec2(0.5)) * 2.0;
    float ring = smoothstep(1.0, 0.0, d);
    ring = pow(ring, 1.8);
    float breathe = 0.92 + 0.08 * sin(uTime * 0.9);
    float a = ring * uReveal * uOpacity * breathe;
    gl_FragColor = vec4(uColor, a);
  }
`;

function plinthProfile(): THREE.Vector2[] {
  const pts: [number, number][] = [
    [0.0, 0.0],
    [1.38, 0.0],
    [1.44, 0.06],
    [1.42, 0.3],
    [1.18, 0.38],
    [1.16, SEAM_Y],
    [1.0, 0.52],
    [0.98, 0.58],
    [0.97, 1.42],
    [0.99, 1.54],
    [0.94, 1.64],
    [0.86, PLINTH_TOP],
    [0.68, PLINTH_TOP],
    [0.0, PLINTH_TOP - 0.02],
  ];
  return pts.map(([r, y]) => new THREE.Vector2(r, y));
}

export function createPodium(
  slam: SlamId,
  theme: SlamTheme,
  championName: string,
  opts: { year: number; event: string },
): Podium {
  const group = new THREE.Group();
  group.name = 'podium';

  const flare = new THREE.Color(theme.flare);
  const glow = new THREE.Color(theme.flareGlow);

  const disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const anodised = track(
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#191c21').lerp(new THREE.Color(theme.ground), 0.14),
      metalness: 0.92,
      roughness: 0.34,
      anisotropy: 0.85,
      clearcoat: 0.55,
      clearcoatRoughness: 0.3,
      envMapIntensity: 1.15,
    }),
  );

  const profile = plinthProfile();
  const plinthGeo = track(new THREE.LatheGeometry(profile, 128));
  plinthGeo.computeVertexNormals();
  const plinth = new THREE.Mesh(plinthGeo, anodised);
  plinth.layers.set(0);
  group.add(plinth);

  const collarMat = track(
    new THREE.MeshPhysicalMaterial({
      color: flare.clone().lerp(new THREE.Color('#f4ede0'), 0.35),
      metalness: 1.0,
      roughness: 0.22,
      clearcoat: 0.6,
      clearcoatRoughness: 0.15,
      envMapIntensity: 1.6,
    }),
  );
  const collarGeo = track(new THREE.TorusGeometry(0.92, 0.02, 16, 128));
  collarGeo.rotateX(Math.PI / 2);
  collarGeo.translate(0, PLINTH_TOP - 0.04, 0);
  const collar = new THREE.Mesh(collarGeo, collarMat);
  collar.layers.set(0);
  group.add(collar);

  const seamMat = track(
    new THREE.MeshBasicMaterial({
      color: glow,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const seamGeo = track(new THREE.TorusGeometry(1.185, 0.02, 20, 180));
  seamGeo.rotateX(Math.PI / 2);
  seamGeo.translate(0, 0.42, 0);
  const seam = new THREE.Mesh(seamGeo, seamMat);
  seam.layers.enable(BLOOM_LAYER);
  group.add(seam);

  const poolMat = track(
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: glow.clone() },
        uReveal: { value: 0 },
        uOpacity: { value: 0.22 },
        uTime: { value: 0 },
      },
      vertexShader: POOL_VERT,
      fragmentShader: POOL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const poolGeo = track(new THREE.CircleGeometry(0.98, 64));
  poolGeo.rotateX(-Math.PI / 2);
  poolGeo.translate(0, PLINTH_TOP + 0.01, 0);
  const pool = new THREE.Mesh(poolGeo, poolMat);
  pool.layers.enable(BLOOM_LAYER);
  group.add(pool);

  const beamMats: THREE.ShaderMaterial[] = [];
  const makeBeam = (bottom: number, top: number, height: number, opacity: number, color: THREE.Color) => {
    const mat = track(
      new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: color },
          uTime: { value: 0 },
          uReveal: { value: 0 },
          uOpacity: { value: opacity },
        },
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    beamMats.push(mat);
    const geo = track(new THREE.CylinderGeometry(top, bottom, height, 96, 1, true));
    geo.translate(0, PLINTH_TOP + height / 2 - 0.1, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.layers.enable(BLOOM_LAYER);
    group.add(mesh);
  };
  makeBeam(0.6, 2.4, 6.6, 0.22, glow.clone().lerp(new THREE.Color('#fff2d4'), 0.55));
  makeBeam(0.26, 1.0, 5.8, 0.16, new THREE.Color('#fff8ea'));

  const plaqueMat = track(
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#20242b').lerp(new THREE.Color(theme.ground), 0.16),
      metalness: 0.95,
      roughness: 0.3,
      anisotropy: 0.6,
      clearcoat: 0.5,
      clearcoatRoughness: 0.28,
      envMapIntensity: 1.2,
    }),
  );
  const plateR = 1.02;
  const plateHalf = 0.86;
  const plateGeo = track(
    new THREE.CylinderGeometry(plateR, plateR, 0.96, 80, 1, true, -plateHalf, plateHalf * 2),
  );
  plateGeo.translate(0, 0.98, 0);
  const plaque = new THREE.Mesh(plateGeo, plaqueMat);
  plaque.layers.set(0);
  group.add(plaque);

  const underlineMat = track(
    new THREE.MeshBasicMaterial({
      color: flare,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const underlineGeo = track(new THREE.PlaneGeometry(1.28, 0.009));
  underlineGeo.translate(0, 0.8, 1.055);
  const underline = new THREE.Mesh(underlineGeo, underlineMat);
  underline.layers.enable(BLOOM_LAYER);
  group.add(underline);

  const vessel = createVessel(slam, { metal: theme.flare, accent: theme.chalk });
  const vesselScale = 2.2;
  vessel.scale.setScalar(vesselScale);
  vessel.position.set(0, PLINTH_TOP - 0.02, 0);
  group.add(vessel);

  const TEXT_Z = 1.06;
  const texts: Text[] = [];
  const mkText = (opt: {
    text: string;
    font: string;
    size: number;
    y: number;
    color: number;
    letterSpacing?: number;
  }): Text => {
    const t = new Text();
    t.text = opt.text;
    t.font = opt.font;
    t.fontSize = opt.size;
    t.anchorX = 'center';
    t.anchorY = 'middle';
    t.color = opt.color;
    t.letterSpacing = opt.letterSpacing ?? 0;
    t.maxWidth = 2.4;
    const tmat = t.material as THREE.Material | THREE.Material[];
    (Array.isArray(tmat) ? tmat : [tmat]).forEach((mm) => (mm.transparent = true));
    t.fillOpacity = 0;
    t.position.set(0, opt.y, TEXT_Z);
    t.layers.set(0);
    t.sync();
    texts.push(t);
    group.add(t);
    return t;
  };

  const eyebrow = mkText({
    text: opts.event.toUpperCase(),
    font: MONO,
    size: 0.07,
    y: 1.3,
    color: new THREE.Color(theme.chalkDim).getHex(),
    letterSpacing: 0.32,
  });
  const name = mkText({
    text: championName,
    font: MONO,
    size: 0.2,
    y: 1.02,
    color: new THREE.Color(theme.chalk).getHex(),
    letterSpacing: 0.02,
  });
  const line = mkText({
    text: `${opts.year} · ${theme.label.toUpperCase()} · CHAMPION`,
    font: MONO,
    size: 0.078,
    y: 0.62,
    color: flare.getHex(),
    letterSpacing: 0.14,
  });

  let vesselOpacity = 0;
  let seamReveal = 0;
  vessel.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    const mats = Array.isArray(m) ? m : m ? [m] : [];
    for (const mm of mats) {
      mm.transparent = true;
      mm.depthWrite = true;
    }
  });

  function setReveal(t: number): void {
    const rt = Math.min(1, Math.max(0, t));

    const beamRise = smooth(0.0, 0.55, rt);
    const beamFade = smooth(0.02, 0.4, rt);
    for (const m of beamMats) {
      m.uniforms.uReveal.value = beamRise;
      const base = m === beamMats[0] ? 0.16 : 0.12;
      m.uniforms.uOpacity.value = base * beamFade;
    }
    poolMat.uniforms.uReveal.value = smooth(0.15, 0.6, rt);

    seamReveal = smooth(0.3, 0.7, rt);
    seamMat.opacity = seamReveal;
    underlineMat.opacity = smooth(0.55, 0.9, rt) * 0.6;

    const vesselIn = smooth(0.35, 0.8, rt);
    vesselOpacity = vesselIn;
    vessel.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      const mats = Array.isArray(m) ? m : m ? [m] : [];
      for (const mm of mats) mm.opacity = vesselIn;
    });
    const s = vesselScale * (0.9 + 0.1 * vesselIn);
    vessel.scale.setScalar(s);

    eyebrow.fillOpacity = smooth(0.55, 0.8, rt);
    name.fillOpacity = smooth(0.62, 0.92, rt);
    line.fillOpacity = smooth(0.72, 1.0, rt);
    name.position.y = 1.02 - 0.04 * (1 - smooth(0.62, 0.92, rt));
    name.sync();
  }

  function update(elapsedMs: number): void {
    const s = elapsedMs / 1000;
    vessel.rotation.y = s * 0.18;
    for (const m of beamMats) m.uniforms.uTime.value = s;
    poolMat.uniforms.uTime.value = s;
    const pulse = 0.9 + 0.1 * Math.sin(s * 1.5);
    seamMat.opacity = seamReveal * pulse;
    seamMat.color.copy(glow).multiplyScalar(0.9 + 0.2 * Math.sin(s * 1.4));
    void vesselOpacity;
  }

  setReveal(0);

  function dispose(): void {
    for (const t of texts) {
      t.dispose();
      t.removeFromParent();
    }
    for (const d of disposables) d.dispose();
    const vd = vessel.userData.dispose as (() => void) | undefined;
    if (vd) vd();
    vessel.removeFromParent();
    group.removeFromParent();
  }

  return { group, setReveal, update, dispose };
}
