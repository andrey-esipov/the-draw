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
  opts: { roughness?: number; envMap?: THREE.Texture; envMapIntensity?: number; clearcoat?: number } = {},
): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: toColor(color),
    metalness: 1.0,
    roughness: opts.roughness ?? 0.18,
    clearcoat: opts.clearcoat ?? 0.5,
    clearcoatRoughness: 0.16,
    envMapIntensity: opts.envMapIntensity ?? 1.4,
  });
  applyEnv(mat, opts.envMap);
  return mat;
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
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
      else if (m) m.dispose();
    });
  };
  return root;
}
