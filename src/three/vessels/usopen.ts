import * as THREE from 'three';
import type { SlamId } from '../../data/types';
import {
  VesselOpts,
  finalizeVessel,
  flute,
  handlePair,
  interiorLiner,
  isWomens,
  metalMat,
  mergePrepared,
  p,
  smoothProfile,
  tarnishGeometry,
  toColor,
} from './index';

export function createUsOpenVessel(slam: SlamId, opts: VesselOpts): THREE.Group {
  return isWomens(slam) ? womensCup(opts) : mensCup(opts);
}

function silverMaterials(opts: VesselOpts) {
  const base = new THREE.Color('#cbd5dc').lerp(toColor(opts.metal), 0.02);
  const silver = metalMat(base, {
    envMap: opts.envMap,
    roughness: 0.11,
    envMapIntensity: 0.66,
    clearcoat: 0,
    textureKind: 'silver',
    normalScale: 0.055,
    aoIntensity: 0.42,
    doubleSide: true,
  });
  const bright = metalMat(base.clone().lerp(new THREE.Color('#ffffff'), 0.42), {
    envMap: opts.envMap,
    roughness: 0.04,
    envMapIntensity: 0.88,
    clearcoat: 0,
    textureKind: 'silver',
    normalScale: 0.045,
    aoIntensity: 0.36,
    doubleSide: true,
  });
  return { silver, bright };
}

// ---------------------------------------------------------------------------
// US Open men's — a larger, clean modern two-handled loving cup.
// ---------------------------------------------------------------------------
function mensCup(opts: VesselOpts): THREE.Group {
  const root = new THREE.Group();
  root.name = 'vessel-usopen-men';
  const content = new THREE.Group();
  const { silver, bright } = silverMaterials(opts);
  const silverParts: THREE.BufferGeometry[] = [];
  const brightParts: THREE.BufferGeometry[] = [];

  const control = [
    p(0.0, 0.0),
    p(0.32, 0.0),
    p(0.34, 0.03),
    p(0.28, 0.06),
    p(0.15, 0.1),
    p(0.1, 0.16),
    p(0.11, 0.21),
    p(0.1, 0.25),
    p(0.16, 0.3),
    p(0.34, 0.46),
    p(0.44, 0.68),
    p(0.46, 0.9),
    p(0.46, 1.04),
    p(0.48, 1.12),
    p(0.46, 1.13),
    p(0.42, 1.06),
    p(0.4, 0.98),
    p(0.12, 0.94),
    p(0.05, 0.94),
  ];
  const bodyGeo = new THREE.LatheGeometry(smoothProfile(control, 13), 128);
  flute(bodyGeo, 9, 0.0035, 0.8, (t) => Math.max(0, Math.sin(Math.min(Math.max((t - 0.42) / 0.42, 0), 1) * Math.PI)));
  tarnishGeometry(bodyGeo, [
    { y: 0.055, width: 0.032, strength: 0.13 },
    { y: 0.72, width: 0.05, strength: 0.09 },
    { y: 0.86, width: 0.035, strength: 0.12 },
    { y: 0.95, width: 0.025, strength: 0.11 },
  ]);
  bodyGeo.computeVertexNormals();
  silverParts.push(bodyGeo);

  const rim = new THREE.TorusGeometry(0.462, 0.016, 8, 72);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 1.075, 0);
  rim.computeVertexNormals();
  brightParts.push(rim);
  brightParts.push(interiorLiner(0.42, 1.06, 0.11, 0.36));
  const footLip = new THREE.TorusGeometry(0.29, 0.01, 8, 72);
  footLip.rotateX(Math.PI / 2);
  footLip.translate(0, 0.055, 0);
  brightParts.push(footLip);
  for (const side of [-1, 1]) {
    const upperBoss = new THREE.SphereGeometry(0.035, 16, 10);
    upperBoss.scale(1.4, 0.8, 0.6);
    upperBoss.translate(side * 0.435, 1.045, 0);
    const lowerBoss = new THREE.SphereGeometry(0.03, 16, 10);
    lowerBoss.scale(1.35, 0.75, 0.55);
    lowerBoss.translate(side * 0.445, 0.705, 0);
    brightParts.push(upperBoss, lowerBoss);
  }

  const hp = handlePair(
    [
      new THREE.Vector3(0.44, 0.7, 0),
      new THREE.Vector3(0.62, 0.76, 0),
      new THREE.Vector3(0.66, 0.92, 0),
      new THREE.Vector3(0.57, 1.04, 0),
      new THREE.Vector3(0.43, 1.05, 0),
    ],
    0.028,
    72,
    16,
    (t) => 0.85 + 0.3 * Math.sin(t * Math.PI),
  );
  silverParts.push(hp);

  content.add(new THREE.Mesh(mergePrepared(silverParts), silver));
  content.add(new THREE.Mesh(mergePrepared(brightParts), bright));

  return finalizeVessel(root, content);
}

// ---------------------------------------------------------------------------
// US Open women's — a slimmer, restrained modern loving cup.
// ---------------------------------------------------------------------------
function womensCup(opts: VesselOpts): THREE.Group {
  const root = new THREE.Group();
  root.name = 'vessel-usopen-women';
  const content = new THREE.Group();
  const { silver, bright } = silverMaterials(opts);
  const silverParts: THREE.BufferGeometry[] = [];
  const brightParts: THREE.BufferGeometry[] = [];

  const control = [
    p(0.0, 0.0),
    p(0.26, 0.0),
    p(0.28, 0.03),
    p(0.22, 0.06),
    p(0.12, 0.1),
    p(0.08, 0.17),
    p(0.09, 0.22),
    p(0.08, 0.27),
    p(0.13, 0.32),
    p(0.26, 0.5),
    p(0.33, 0.72),
    p(0.35, 0.94),
    p(0.36, 1.06),
    p(0.38, 1.14),
    p(0.36, 1.15),
    p(0.33, 1.08),
    p(0.31, 1.0),
    p(0.1, 0.96),
    p(0.05, 0.96),
  ];
  const bodyGeo = new THREE.LatheGeometry(smoothProfile(control, 13), 128);
  flute(bodyGeo, 9, 0.003, 0.8, (t) => Math.max(0, Math.sin(Math.min(Math.max((t - 0.42) / 0.42, 0), 1) * Math.PI)));
  tarnishGeometry(bodyGeo, [
    { y: 0.055, width: 0.032, strength: 0.12 },
    { y: 0.72, width: 0.05, strength: 0.09 },
    { y: 0.86, width: 0.035, strength: 0.11 },
    { y: 0.95, width: 0.025, strength: 0.1 },
  ]);
  bodyGeo.computeVertexNormals();
  silverParts.push(bodyGeo);

  const rim = new THREE.TorusGeometry(0.362, 0.013, 8, 72);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 1.1, 0);
  rim.computeVertexNormals();
  brightParts.push(rim);
  brightParts.push(interiorLiner(0.33, 1.08, 0.1, 0.36));
  const footLip = new THREE.TorusGeometry(0.235, 0.008, 8, 64);
  footLip.rotateX(Math.PI / 2);
  footLip.translate(0, 0.055, 0);
  brightParts.push(footLip);
  for (const side of [-1, 1]) {
    const upperBoss = new THREE.SphereGeometry(0.028, 14, 10);
    upperBoss.scale(1.35, 0.78, 0.55);
    upperBoss.translate(side * 0.335, 1.055, 0);
    const lowerBoss = new THREE.SphereGeometry(0.025, 14, 10);
    lowerBoss.scale(1.3, 0.72, 0.5);
    lowerBoss.translate(side * 0.345, 0.745, 0);
    brightParts.push(upperBoss, lowerBoss);
  }

  const hp = handlePair(
    [
      new THREE.Vector3(0.34, 0.74, 0),
      new THREE.Vector3(0.5, 0.8, 0),
      new THREE.Vector3(0.53, 0.94, 0),
      new THREE.Vector3(0.45, 1.05, 0),
      new THREE.Vector3(0.33, 1.06, 0),
    ],
    0.022,
    72,
    14,
    (t) => 0.85 + 0.3 * Math.sin(t * Math.PI),
  );
  silverParts.push(hp);

  content.add(new THREE.Mesh(mergePrepared(silverParts), silver));
  content.add(new THREE.Mesh(mergePrepared(brightParts), bright));

  return finalizeVessel(root, content);
}
