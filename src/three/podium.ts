import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { createText } from './text';
import type { SlamId } from '../data/types';
import type { SlamTheme } from '../ui/theme';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { createVessel, VESSEL_HEIGHT } from './vessels';
import { vesselStudioEnv } from './vessels/studio';
import { BLOOM_LAYER } from './stage';

const BASE = import.meta.env.BASE_URL;
const MONO = `${BASE}fonts/mono-latin.woff`;

export const PLINTH_TOP = 1.72;
/** The podium is mounted at this scale, so callers can find its top in world space. */
export const PODIUM_SCALE = 2.15;
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
  varying float vH;
  uniform float uTopY;
  void main() {
    vH = clamp(position.y / uTopY, 0.0, 1.0);
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
  varying float vH;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    // The glow lives on a dome whose outline is a curve, so fading toward the
    // silhouette leaves a soft body of light with no traceable straight edge.
    float facing = abs(dot(normalize(vNormalW), normalize(vViewDir)));
    float body = pow(facing, 2.4);
    // Strongly bottom-weighted: near-full where the cup meets the plinth and
    // essentially gone by a third of the way up, so it never climbs the bowl or
    // reaches the top of frame. The inverse of a downward spotlight cone.
    float vertical = pow(clamp(1.0 - vH / 0.42, 0.0, 1.0), 2.8);
    float rise = smoothstep(0.0, 1.0, uReveal) * 1.1;
    float revealMask = smoothstep(vH - 0.16, vH + 0.05, rise);
    vec2 dir = normalize(vec2(vNormalW.x, vNormalW.z) + 1e-5);
    float band = vH * 3.2 + uTime * 0.12;
    float shimmer = 0.85 + 0.15 * mix(
      noise(vec2(dir.x * 3.0, band)),
      noise(vec2(dir.y * 3.0 + 4.7, band * 1.11)),
      0.5
    );
    float a = body * vertical * revealMask * shimmer * uOpacity;
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
    ring = pow(ring, 1.25) * 0.85;
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
  opts: { year: number; event: string; reduced?: boolean },
  renderer: THREE.WebGLRenderer,
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
      roughness: 0.42,
      clearcoat: 0.6,
      clearcoatRoughness: 0.3,
      envMapIntensity: 1.1,
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
        uOpacity: { value: 0.13 },
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
  pool.layers.set(0);
  group.add(pool);

  const beamMats: THREE.ShaderMaterial[] = [];
  // Concealed uplight seated in the plinth: a soft glow dome, brightest where
  // the cup meets the plinth and dissolving fast as it rises. A dome (curved
  // outline) rather than a cone means there is no straight edge to read as a
  // spotlight beam, and the bottom weighting keeps the haze low and diffuse.
  const domeCenterY = PLINTH_TOP + 0.02;
  const makeGlowDome = (
    rx: number,
    ry: number,
    opacity: number,
    color: THREE.Color,
  ) => {
    const mat = track(
      new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: color },
          uTime: { value: 0 },
          uReveal: { value: 0 },
          uOpacity: { value: opacity },
          uTopY: { value: ry },
        },
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
      }),
    );
    beamMats.push(mat);
    const geo = track(new THREE.SphereGeometry(1, 48, 32));
    geo.scale(rx, ry, rx);
    geo.translate(0, domeCenterY, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.layers.enable(BLOOM_LAYER);
    group.add(mesh);
  };
  // A broad outer haze and a warmer tighter core, both hugging the base and
  // gone before mid-bowl, so nothing bright climbs to the rim or the top of
  // frame. Rendered back-side so the volume reads from within.
  makeGlowDome(2.05, 2.6, 0.09, glow.clone().lerp(new THREE.Color('#ffe6bd'), 0.5));
  makeGlowDome(1.2, 2.0, 0.08, new THREE.Color('#fff0d6'));

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

  // Polished metal shows its surroundings, and this room is almost black, so
  // the cup was reflecting nothing and reading as a dark urn. Give it a small
  // private studio to reflect: a soft key band, a cooler fill, and a warm rim
  // in the tournament's colour. This is what makes the form legible without
  // resorting to hot lights that blow the detail out.
  const studioTex = buildStudioEnv(theme);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const studioEnv = pmrem.fromEquirectangular(studioTex).texture;
  pmrem.dispose();
  studioTex.dispose();

  const vessel = createVessel(slam, { metal: theme.flare, accent: theme.chalk });
  const vesselScale = 2.5;
  vessel.scale.setScalar(vesselScale);
  vessel.position.set(0, PLINTH_TOP - 0.02, 0);
  group.add(vessel);

  // Physically measured metal reflectance (F0), so the cup reads as real metal
  // rather than a tinted design colour. Wimbledon's Gentlemen's Singles Trophy
  // is silver-gilt, so it alone runs warm gold; every other trophy is silver.
  const f0 = slam === 'wimbledon-men'
    ? new THREE.Color(1.0, 0.77, 0.34)
    : new THREE.Color(0.97, 0.96, 0.91);

  vessel.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      const phys = mat as THREE.MeshPhysicalMaterial;
      if (!phys.isMeshPhysicalMaterial) continue;
      // The same room the title screen lights these cups in, so the trophy is
      // the same object at both ends of the move onto the board.
      phys.envMap = vesselStudioEnv(renderer);
      phys.color.copy(f0);
      // Softer than a mirror. A broad highlight reveals the silhouette's
      // curvature; a sharp one just shows the room.
      phys.roughness = Math.max(phys.roughness, 0.29);
      // Keep the reflected room from filling the occluded areas, so the bowl
      // keeps genuinely dark values to read against the highlights.
      phys.envMapIntensity = Math.max(phys.envMapIntensity, 1.6);
      // The board is a night room lit by concealed uplights, so the contrast
      // curve the cups carry for the title set has almost nothing above its
      // black point here and renders the trophy as a silhouette. Ease it off.
      const curve = phys.userData.metalCurve as
        | { uContrast: { value: number }; uBlackPoint: { value: number } }
        | undefined;
      if (curve) {
        curve.uContrast.value = 1.2;
        curve.uBlackPoint.value = 0.004;
      }
      phys.needsUpdate = true;
    }
  });
  anodised.envMap = studioEnv;
  collarMat.envMap = studioEnv;

  // A real rectangular emitter (linearly transformed cosines) rather than a
  // point light, so the metal reflects the SHAPE of a soft source and reads as
  // broad studio highlights rather than pinpoint glints.
  RectAreaLightUniformsLib.init();

  const cupLights: THREE.RectAreaLight[] = [];
  // Concealed uplights: sources sit at the plinth rim, below the cup, angled up
  // and inward. RectAreaLight is one-sided, so lookAt() must point up at the
  // cup or it emits nothing. Lighting from beneath means the underside curves
  // of the bowl, foot and handles catch the brightest speculars while the upper
  // shoulder falls comparatively dark — the signature that says "lit from below".
  const addUplight = (
    color: THREE.ColorRepresentation,
    intensity: number,
    width: number,
    height: number,
    x: number,
    y: number,
    z: number,
    aimY: number,
  ) => {
    const l = new THREE.RectAreaLight(color, intensity, width, height);
    l.position.set(x, y, z);
    l.lookAt(0, aimY, 0);
    cupLights.push(l);
    group.add(l);
  };

  // Sources are recessed BELOW the plinth lip and tucked under the overhang so
  // the viewer never sees a bright point of origin — only the effect. They aim
  // up and inward at the lower cup.
  const rimY = PLINTH_TOP - 0.14;
  const footY = PLINTH_TOP - 0.02 + VESSEL_HEIGHT * vesselScale * 0.34;
  // Front pair, low and wide, does most of the work: rakes up the lower bowl.
  addUplight(0xfff2df, 6.4, 2.4, 1.0, -1.9, rimY, 2.1, footY);
  addUplight(0xfff2df, 6.4, 2.4, 1.0, 1.9, rimY, 2.1, footY);
  // Side wrap, cooler and weaker, so the light comes from around the base
  // rather than one direction and the handles rim-light from beneath.
  addUplight(0xdfeaff, 3.0, 1.8, 0.9, -2.4, rimY + 0.06, -0.3, footY + 0.2);
  addUplight(0xdfeaff, 3.0, 1.8, 0.9, 2.4, rimY + 0.06, -0.3, footY + 0.2);
  // Back rim in the tournament colour, low and behind, to lift the silhouette
  // off a near-black room without touching the upper shoulder.
  addUplight(theme.flare, 3.4, 2.0, 0.9, 0, rimY + 0.12, -2.2, footY + 0.4);

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
    const t = createText();
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
      const base = m === beamMats[0] ? 0.09 : 0.08;
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
    const s = opts.reduced ? 0 : elapsedMs / 1000;
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
    studioEnv.dispose();
    for (const l of cupLights) l.removeFromParent();
    const vd = vessel.userData.dispose as (() => void) | undefined;
    if (vd) vd();
    vessel.removeFromParent();
    group.removeFromParent();
  }

  return { group, setReveal, update, dispose };
}


/**
 * A tiny equirectangular studio, painted rather than loaded. Bottom-weighted:
 * the bright soft sources sit low, near and below the horizon, with only a
 * faint cool key overhead and a darkened zenith, so a near-mirror metal
 * reflects light on its underside curves and stays dark on the shoulder.
 */
function buildStudioEnv(theme: SlamTheme): THREE.Texture {
  const w = 512;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;

  g.fillStyle = '#0b0e14';
  g.fillRect(0, 0, w, h);

  const band = (cx: number, cy: number, rx: number, ry: number, colour: string, alpha: number) => {
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
    grd.addColorStop(0, colour);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.save();
    g.globalAlpha = alpha;
    g.globalCompositeOperation = 'lighter';
    g.translate(cx, cy);
    g.scale(1, ry / Math.max(rx, ry));
    g.translate(-cx, -cy);
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    g.restore();
  };

  // Bottom-weighted studio: dim overhead, brighter low, so a near-mirror metal
  // reflects light on its underside-facing curves and stays dark on the
  // shoulder — the reflection half of the uplight. A faint cool key overhead
  // keeps the top from going dead black without lifting it into the midtones.
  band(w * 0.32, h * 0.18, w * 0.34, h * 0.28, '#e9edf6', 0.32);
  // The bright sources live low, near the horizon and below, so upward-facing
  // reflections read light. Warm centre, cooler wings.
  band(w * 0.3, h * 0.82, w * 0.36, h * 0.34, '#fff2df', 0.95);
  band(w * 0.7, h * 0.8, w * 0.32, h * 0.3, '#e6eeff', 0.6);
  band(w * 0.95, h * 0.7, w * 0.2, h * 0.3, theme.flare, 0.5);
  band(w * 0.05, h * 0.7, w * 0.2, h * 0.3, theme.flare, 0.5);

  // Darken the very top (zenith) so the shoulder has something dark to reflect.
  const ceil = g.createLinearGradient(0, 0, 0, h * 0.4);
  ceil.addColorStop(0, 'rgba(0,0,0,0.6)');
  ceil.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = ceil;
  g.fillRect(0, 0, w, h);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
