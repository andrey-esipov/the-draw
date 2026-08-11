import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SlamId } from '../../data/types';
import { createAustralianVessel } from './australian';
import { createRolandVessel } from './roland';
import { createWimbledonVessel } from './wimbledon';
import { createUsOpenVessel } from './usopen';

export interface VesselOpts {
  metal: THREE.Color | string;
  accent: THREE.Color | string;
  envMap?: THREE.Texture;
}

export const VESSEL_HEIGHT = 1.0;

type Tournament = 'australian' | 'roland' | 'wimbledon' | 'usopen';

function tournamentOf(slam: SlamId): Tournament {
  if (slam.startsWith('australian-open')) return 'australian';
  if (slam.startsWith('french-open')) return 'roland';
  if (slam.startsWith('wimbledon')) return 'wimbledon';
  return 'usopen';
}

export function isWomens(slam: SlamId): boolean {
  return slam.endsWith('-women');
}

export function createVessel(slam: SlamId, opts: VesselOpts): THREE.Group {
  switch (tournamentOf(slam)) {
    case 'australian':
      return createAustralianVessel(slam, opts);
    case 'roland':
      return createRolandVessel(slam, opts);
    case 'wimbledon':
      return createWimbledonVessel(slam, opts);
    case 'usopen':
      return createUsOpenVessel(slam, opts);
  }
}

// ---------------------------------------------------------------------------
// Shared authoring helpers (pure functions — safe under circular import).
// ---------------------------------------------------------------------------

export function toColor(c: THREE.Color | string): THREE.Color {
  return c instanceof THREE.Color ? c.clone() : new THREE.Color(c);
}

type MetalTextureKind = 'silver' | 'gold';

interface MetalTexturePack {
  roughness: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
  ao: THREE.CanvasTexture;
  refs: number;
}

const metalTextures = new Map<MetalTextureKind, MetalTexturePack>();

function noise(x: number, y: number, seed: number): number {
  return (Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453) % 1;
}

function createMetalTexturePack(kind: MetalTextureKind): MetalTexturePack | null {
  if (typeof document === 'undefined') return null;
  const size = 512;
  const seed = kind === 'gold' ? 2.7 : 1.3;
  const baseRoughness = 54;
  const roughnessCeiling = 150;
  const roughCanvas = document.createElement('canvas');
  const normalCanvas = document.createElement('canvas');
  const aoCanvas = document.createElement('canvas');
  roughCanvas.width = roughCanvas.height = normalCanvas.width = normalCanvas.height = aoCanvas.width = aoCanvas.height = size;
  const roughCtx = roughCanvas.getContext('2d')!;
  const normalCtx = normalCanvas.getContext('2d')!;
  const aoCtx = aoCanvas.getContext('2d')!;
  const rough = roughCtx.createImageData(size, size);
  const normal = normalCtx.createImageData(size, size);
  const ao = aoCtx.createImageData(size, size);
  const TAU = Math.PI * 2;
  // The faint dimpled relief a silversmith's hammer leaves — a few incommensurate
  // scales overlaid so the planishing reads as hand-worked, never as a tiled waffle.
  // A height field sampled at neighbouring texels gives the surface slope that
  // becomes the normal, which is what actually catches a moving highlight.
  const planish = (uu: number, vv: number): number =>
    0.55 * Math.sin(uu * TAU * 7 + seed) * Math.sin(vv * TAU * 6.3) +
    0.3 * Math.sin(uu * TAU * 11 + 1.3) * Math.cos(vv * TAU * 11.7 + 0.7) +
    0.16 * Math.sin(uu * TAU * 18 + 2.1) * Math.sin(vv * TAU * 15.2 + seed);
  const e = 1 / size;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    const engravedBand = Math.exp(-Math.pow((v - 0.34) / 0.034, 2)) + 0.65 * Math.exp(-Math.pow((v - 0.72) / 0.026, 2));
    const rimShadow = Math.max(0, 1 - Math.min(v, 1 - v) / 0.055);
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const fine = noise(x, y, seed);
      const grain = noise(Math.floor(x / 3), Math.floor(y / 2), seed + 5);
      const scratch = Math.pow(Math.max(0, Math.sin((u * 126 + v * 17 + seed) * Math.PI)), 18);
      const hairline = Math.pow(Math.max(0, Math.sin((u * 44 - v * 92 + seed * 3) * Math.PI)), 30);
      const inscription = engravedBand * (0.35 + 0.65 * Math.pow(Math.max(0, Math.sin((u * 86 + seed) * Math.PI)), 12));
      // Broad, slow undulation of polish quality across the open faces so the
      // mirror ripples like worked metal rather than reflecting a perfect plane.
      const swirl = Math.sin((u * 3.4 + v * 2.1 + seed) * Math.PI) * Math.sin((u * 1.7 - v * 2.6) * Math.PI);
      const hC = planish(u, v);
      const dPu = planish(u + e, v) - hC;
      const dPv = planish(u, v + e) - hC;
      const planishRough = (Math.abs(dPu) + Math.abs(dPv)) * 260;
      const i = (y * size + x) * 4;
      const roughValue =
        baseRoughness + fine * 20 + grain * 15 + scratch * 56 + hairline * 36 + inscription * 44 + planishRough + swirl * 7;
      rough.data[i] = rough.data[i + 1] = rough.data[i + 2] = Math.max(30, Math.min(roughnessCeiling, roughValue));
      rough.data[i + 3] = 255;
      normal.data[i] = 128 - dPu * 540 + scratch * 16 - hairline * 9;
      normal.data[i + 1] = 128 - dPv * 540 + (noise(x, y + 9, seed) - 0.5) * 9 + inscription * 14;
      normal.data[i + 2] = 255;
      normal.data[i + 3] = 255;
      const aoValue = 255 - rimShadow * 28 - engravedBand * 36 - inscription * 28;
      ao.data[i] = ao.data[i + 1] = ao.data[i + 2] = Math.max(175, aoValue);
      ao.data[i + 3] = 255;
    }
  }
  roughCtx.putImageData(rough, 0, 0);
  normalCtx.putImageData(normal, 0, 0);
  aoCtx.putImageData(ao, 0, 0);
  const pack: MetalTexturePack = {
    roughness: new THREE.CanvasTexture(roughCanvas),
    normal: new THREE.CanvasTexture(normalCanvas),
    ao: new THREE.CanvasTexture(aoCanvas),
    refs: 0,
  };
  for (const tex of [pack.roughness, pack.normal, pack.ao]) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
  }
  return pack;
}

function acquireMetalTexturePack(kind: MetalTextureKind): MetalTexturePack | null {
  let pack = metalTextures.get(kind);
  if (!pack) {
    pack = createMetalTexturePack(kind) ?? undefined;
    if (!pack) return null;
    metalTextures.set(kind, pack);
  }
  pack.refs += 1;
  return pack;
}

function releaseMetalTexturePack(kind: MetalTextureKind): void {
  const pack = metalTextures.get(kind);
  if (!pack) return;
  pack.refs -= 1;
  if (pack.refs > 0) return;
  pack.roughness.dispose();
  pack.normal.dispose();
  pack.ao.dispose();
  metalTextures.delete(kind);
}

/** A profile control point in the meridian plane. x = radius, y = height. */
export function p(radius: number, height: number): THREE.Vector2 {
  return new THREE.Vector2(radius, height);
}

/**
 * Resample a coarse control polygon into a smooth Catmull-Rom meridian so the
 * turned silhouette reads as hand-authored rather than segmented.
 */
export function smoothProfile(control: THREE.Vector2[], perSpan = 10): THREE.Vector2[] {
  const v3 = control.map((c) => new THREE.Vector3(c.x, c.y, 0));
  const curve = new THREE.CatmullRomCurve3(v3, false, 'catmullrom', 0.5);
  const out: THREE.Vector2[] = [];
  const n = (control.length - 1) * perSpan;
  for (let i = 0; i <= n; i++) {
    const q = curve.getPoint(i / n);
    out.push(new THREE.Vector2(Math.max(q.x, 0), q.y));
  }
  return out;
}

/**
 * Apply radial fluting / lobing to a lathed geometry by modulating each ring's
 * radius as a function of azimuth. `envelope` optionally scales the amplitude by
 * normalized height (0 at base, 1 at top) so flutes can fade in or out.
 */
export function flute(
  geo: THREE.BufferGeometry,
  count: number,
  amp: number,
  phase = 0,
  envelope?: (t: number) => number,
): void {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const y0 = bb.min.y;
  const y1 = bb.max.y;
  const span = Math.max(y1 - y0, 1e-6);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const r = Math.hypot(v.x, v.z);
    if (r < 1e-4) continue;
    const a = Math.atan2(v.z, v.x);
    const t = (v.y - y0) / span;
    const e = envelope ? envelope(t) : 1;
    const f = 1 + amp * e * Math.sin(count * a + phase);
    const nr = r * f;
    v.x = Math.cos(a) * nr;
    v.z = Math.sin(a) * nr;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

/** Attach a texture as environment reflection when one is supplied. */
export function applyEnv(mat: THREE.MeshPhysicalMaterial, envMap: THREE.Texture | undefined): void {
  if (envMap) mat.envMap = envMap;
}

/**
 * Build a polished-metal physical material. Reflections from the scene PMREM do
 * the heavy lifting, so keep roughness low with a little clearcoat sheen.
 */
export function metalMat(
  color: THREE.Color | string,
  opts: {
    roughness?: number;
    envMap?: THREE.Texture;
    envMapIntensity?: number;
    clearcoat?: number;
    textureKind?: MetalTextureKind;
    normalScale?: number;
    aoIntensity?: number;
    contrast?: number;
    blackPoint?: number;
    doubleSide?: boolean;
  } = {},
): THREE.MeshPhysicalMaterial {
  const pack = opts.textureKind ? acquireMetalTexturePack(opts.textureKind) : null;
  const mat = new THREE.MeshPhysicalMaterial({
    color: toColor(color),
    metalness: 1.0,
    roughness: opts.roughness ?? 0.18,
    roughnessMap: pack?.roughness,
    normalMap: pack?.normal,
    normalScale: new THREE.Vector2(opts.normalScale ?? 0.026, opts.normalScale ?? 0.026),
    aoMap: pack?.ao,
    aoMapIntensity: opts.aoIntensity ?? 0.55,
    vertexColors: true,
    clearcoat: opts.clearcoat ?? 0,
    clearcoatRoughness: 0.04,
    envMapIntensity: opts.envMapIntensity ?? 1.4,
    side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
  // The curve is carried on uniforms rather than baked into the source, because
  // the same vessel is shown in two rooms lit very differently. Baked in, the
  // black point that gives the cups their depth on the bright title set crushed
  // the board's trophy to a silhouette, since almost nothing there clears it.
  const curve = {
    uContrast: { value: opts.contrast ?? 1.72 },
    uBlackPoint: { value: opts.blackPoint ?? 0.075 },
  };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uContrast = curve.uContrast;
    shader.uniforms.uBlackPoint = curve.uBlackPoint;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        'uniform float uContrast;\nuniform float uBlackPoint;\nvoid main() {',
      )
      .replace(
        '#include <opaque_fragment>',
        `outgoingLight = max(vec3(0.0), (outgoingLight - vec3(uBlackPoint)) * uContrast);
#include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => 'metal-contrast-uniform';
  mat.userData.metalCurve = curve;
  if (opts.textureKind) mat.userData.metalTextureKind = opts.textureKind;
  applyEnv(mat, opts.envMap);
  return mat;
}

export function prepareMetalGeometry(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  let uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const uvs: number[] = [];
    const sx = Math.max(bb.max.x - bb.min.x, 1e-6);
    const sy = Math.max(bb.max.y - bb.min.y, 1e-6);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      uvs.push((x - bb.min.x) / sx, (y - bb.min.y) / sy);
    }
    uv = new THREE.Float32BufferAttribute(uvs, 2);
    geo.setAttribute('uv', uv);
  }
  if (!geo.getAttribute('uv2')) geo.setAttribute('uv2', uv.clone());
  if (!geo.getAttribute('color')) {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const colors: number[] = [];
    for (let i = 0; i < pos.count; i++) colors.push(1, 1, 1);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  }
  return geo;
}

export function tarnishGeometry(
  geo: THREE.BufferGeometry,
  bands: { y: number; width: number; strength: number }[],
  fluteCount = 0,
): THREE.BufferGeometry {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const colors: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const t = (y - bb.min.y) / Math.max(bb.max.y - bb.min.y, 1e-6);
    let shade = 1;
    for (const band of bands) {
      shade -= band.strength * Math.exp(-Math.pow((t - band.y) / band.width, 2));
    }
    if (fluteCount > 0) {
      const a = Math.atan2(z, x);
      // A cloth polishes the flute crests bright but skips the valleys, so the
      // valleys hold a century of tarnish. Keep a little of it near the foot too,
      // where the envelope would otherwise wash the darkening out completely.
      const valley = Math.pow(0.5 + 0.5 * Math.sin(fluteCount * a + 0.5), 2);
      const reach = 0.35 + 0.65 * Math.sin(Math.PI * t);
      shade -= 0.16 * valley * reach;
    }
    // Faint irregular mottle so broad faces are never a flat machined tone.
    shade -= 0.028 * (0.5 + 0.5 * Math.sin(x * 41.3 + y * 27.7 + z * 33.1));
    shade = Math.max(0.4, Math.min(1, shade));
    colors.push(shade, shade, shade);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

/**
 * Sweep a round tube along a shaped meridian curve, then mirror it across the
 * YZ plane to produce a matched pair of handles. Points are given for the +x
 * side. `taper` optionally varies the tube radius along the curve (0..1).
 */
export function handlePair(
  points: THREE.Vector3[],
  radius: number,
  segments = 64,
  radial = 10,
  taper?: (t: number) => number,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [1, -1]) {
    const curve = new THREE.CatmullRomCurve3(
      points.map((v) => new THREE.Vector3(side * v.x, v.y, v.z)),
    );
    let geo: THREE.BufferGeometry;
    if (taper) {
      geo = tubeVariable(curve, segments, radius, radial, taper);
    } else {
      geo = new THREE.TubeGeometry(curve, segments, radius, radial, false);
    }
    parts.push(geo);
  }
  const merged = mergeGeometries(parts);
  merged.computeVertexNormals();
  return merged;
}

/** A tube whose radius varies along its length via `taper(t)` in [0,1]. */
export function tubeVariable(
  curve: THREE.Curve<THREE.Vector3>,
  tubular: number,
  radius: number,
  radial: number,
  taper: (t: number) => number,
): THREE.BufferGeometry {
  const frames = curve.computeFrenetFrames(tubular, false);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const P = new THREE.Vector3();
  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular;
    curve.getPointAt(t, P);
    const N = frames.normals[i];
    const B = frames.binormals[i];
    const r = radius * taper(t);
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * Math.PI * 2;
      const sin = Math.sin(v);
      const cos = -Math.cos(v);
      const x = P.x + r * (cos * N.x + sin * B.x);
      const y = P.y + r * (cos * N.y + sin * B.y);
      const z = P.z + r * (cos * N.z + sin * B.z);
      positions.push(x, y, z);
      uvs.push(j / radial, t);
    }
  }
  for (let i = 1; i <= tubular; i++) {
    for (let j = 1; j <= radial; j++) {
      const a = (radial + 1) * (i - 1) + (j - 1);
      const b = (radial + 1) * i + (j - 1);
      const c = (radial + 1) * i + j;
      const d = (radial + 1) * (i - 1) + j;
      indices.push(a, b, d, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** A ring of small beads (bead-and-reel border) circling a body at height y. */
export function beadedRing(radius: number, bead: number, count: number, y: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const b = new THREE.SphereGeometry(bead, 6, 4);
    const a = (i / count) * Math.PI * 2;
    b.translate(Math.cos(a) * radius, y, Math.sin(a) * radius);
    parts.push(b);
  }
  const merged = mergeGeometries(parts);
  merged.computeVertexNormals();
  return merged;
}

export function interiorLiner(radius: number, y: number, depth: number, throat = 0.22): THREE.BufferGeometry {
  const geo = new THREE.LatheGeometry(
    smoothProfile([
      p(radius, y),
      p(radius * 0.86, y - depth * 0.18),
      p(radius * 0.62, y - depth * 0.46),
      p(radius * throat, y - depth),
      p(0.06, y - depth * 0.96),
    ], 10),
    96,
  );
  geo.computeVertexNormals();
  return geo;
}

export function mergePrepared(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(geometries.map((g) => prepareMetalGeometry(g)));
  merged.computeVertexNormals();
  return merged;
}

export function finalizeVessel(root: THREE.Group, content: THREE.Object3D, targetHeight = VESSEL_HEIGHT): THREE.Group {
  content.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(content);
  const size = new THREE.Vector3();
  box.getSize(size);
  const scale = targetHeight / Math.max(size.y, 1e-6);
  content.scale.multiplyScalar(scale);
  content.updateMatrixWorld(true);

  const box2 = new THREE.Box3().setFromObject(content);
  content.position.x -= (box2.min.x + box2.max.x) / 2;
  content.position.z -= (box2.min.z + box2.max.z) / 2;
  content.position.y -= box2.min.y;

  root.add(content);

  root.userData.dispose = () => {
    const disposedMaterials = new Set<THREE.Material>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
      const disposeMaterial = (mm: THREE.Material) => {
        if (disposedMaterials.has(mm)) return;
        disposedMaterials.add(mm);
        const kind = mm.userData.metalTextureKind as MetalTextureKind | undefined;
        mm.dispose();
        if (kind) releaseMetalTexturePack(kind);
      };
      if (Array.isArray(m)) m.forEach(disposeMaterial);
      else if (m) disposeMaterial(m);
    });
  };
  return root;
}
