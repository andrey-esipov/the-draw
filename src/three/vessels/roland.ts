import * as THREE from 'three';
import type { SlamId } from '../../data/types';
import {
  VesselOpts,
  beadedRing,
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

export function createRolandVessel(slam: SlamId, opts: VesselOpts): THREE.Group {
  return isWomens(slam) ? suzanneLenglen(opts) : mousquetaires(opts);
}

function silverMaterials(opts: VesselOpts) {
  const base = new THREE.Color('#c6d0d8').lerp(toColor(opts.metal), 0.025);
  const silver = metalMat(base, {
    envMap: opts.envMap,
    roughness: 0.05,
    envMapIntensity: 0.72,
    clearcoat: 0,
    textureKind: 'silver',
    normalScale: 0.06,
    doubleSide: true,
  });
  const bright = metalMat(base.clone().lerp(new THREE.Color('#ffffff'), 0.4), {
    envMap: opts.envMap,
    roughness: 0.036,
    envMapIntensity: 0.98,
    clearcoat: 0,
    textureKind: 'silver',
    normalScale: 0.045,
    aoIntensity: 0.48,
    doubleSide: true,
  });
  return { silver, bright };
}

// ---------------------------------------------------------------------------
// Coupe des Mousquetaires — broad, squat, heavily chased two-handled cup.
// ---------------------------------------------------------------------------
function mousquetaires(opts: VesselOpts): THREE.Group {
  const root = new THREE.Group();
  root.name = 'vessel-roland-men';
  const content = new THREE.Group();
  const { silver, bright } = silverMaterials(opts);
  const silverParts: THREE.BufferGeometry[] = [];
  const brightParts: THREE.BufferGeometry[] = [];

  const control = [
    p(0.0, 0.0),
    p(0.34, 0.0),
    p(0.35, 0.028),
    p(0.31, 0.058),
    p(0.21, 0.088),
    p(0.13, 0.115),
    p(0.105, 0.15),
    p(0.15, 0.178),
    p(0.105, 0.208),
    p(0.115, 0.238),
    p(0.19, 0.29),
    p(0.32, 0.38),
    p(0.43, 0.49),
    p(0.475, 0.61),
    p(0.47, 0.72),
    p(0.43, 0.815),
    p(0.405, 0.885),
    p(0.44, 0.965),
    p(0.475, 1.05),
    p(0.482, 1.1),
    p(0.458, 1.1),
    p(0.44, 1.05),
    p(0.3, 1.0),
    p(0.06, 0.99),
    p(0.05, 0.99),
  ];
  const bodyGeo = new THREE.LatheGeometry(smoothProfile(control, 13), 128);
  flute(bodyGeo, 20, 0.014, 0, (t) => Math.max(0, Math.sin(Math.max(0, (t - 0.28) / 0.46) * Math.PI)));
  flute(bodyGeo, 22, 0.02, 0, (t) => Math.pow(Math.max(0, 1 - t / 0.22), 1.4));
  flute(bodyGeo, 60, 0.003, 0, (t) => Math.max(0, Math.sin(Math.min(t / 0.6, 1) * Math.PI)));
  tarnishGeometry(bodyGeo, [
    { y: 0.055, width: 0.03, strength: 0.1 },
    { y: 0.53, width: 0.045, strength: 0.14 },
    { y: 0.72, width: 0.035, strength: 0.12 },
    { y: 0.94, width: 0.022, strength: 0.08 },
  ], 20);
  bodyGeo.computeVertexNormals();
  silverParts.push(bodyGeo);

  const rimBead = beadedRing(0.475, 0.02, 56, 1.05);
  brightParts.push(rimBead);
  const bellyBead = beadedRing(0.478, 0.014, 60, 0.6);
  brightParts.push(bellyBead);
  const neckBand = new THREE.TorusGeometry(0.408, 0.014, 8, 84);
  neckBand.rotateX(Math.PI / 2);
  neckBand.translate(0, 0.885, 0);
  neckBand.computeVertexNormals();
  brightParts.push(neckBand);
  brightParts.push(interiorLiner(0.44, 1.045, 0.11, 0.38));
  silverParts.push(chasedLeafBand(0.455, 0.68, 42, 0.03), chasedLeafBand(0.43, 0.79, 36, 0.024));

  const hp = handlePair(
    [
      new THREE.Vector3(0.43, 0.99, 0),
      new THREE.Vector3(0.54, 1.02, 0),
      new THREE.Vector3(0.62, 0.94, 0),
      new THREE.Vector3(0.645, 0.82, 0),
      new THREE.Vector3(0.6, 0.71, 0),
      new THREE.Vector3(0.5, 0.65, 0),
      new THREE.Vector3(0.44, 0.66, 0),
    ],
    0.028,
    88,
    16,
    (t) => 0.6 + 0.8 * Math.sin(t * Math.PI),
  );
  hp.scale(1, 1, 0.62);
  silverParts.push(hp);

  for (const side of [-1, 1]) {
    const head = new THREE.SphereGeometry(0.028, 12, 10);
    head.scale(1.3, 1, 0.7);
    head.translate(side * 0.56, 1.02, 0);
    brightParts.push(head);
  }

  content.add(new THREE.Mesh(mergePrepared(silverParts), silver));
  content.add(new THREE.Mesh(mergePrepared(brightParts), bright));

  return finalizeVessel(root, content);
}

// ---------------------------------------------------------------------------
// Coupe Suzanne Lenglen — smaller, slimmer, ornate two-handled cup.
// ---------------------------------------------------------------------------
function suzanneLenglen(opts: VesselOpts): THREE.Group {
  const root = new THREE.Group();
  root.name = 'vessel-roland-women';
  const content = new THREE.Group();
  const { silver, bright } = silverMaterials(opts);
  const silverParts: THREE.BufferGeometry[] = [];
  const brightParts: THREE.BufferGeometry[] = [];

  const steps = [
    { r: 0.35, h: 0.05, y: 0.025 },
    { r: 0.29, h: 0.042, y: 0.071 },
    { r: 0.235, h: 0.04, y: 0.112 },
  ];
  for (const s of steps) {
    const disc = new THREE.CylinderGeometry(s.r, s.r * 1.02, s.h, 64);
    disc.translate(0, s.y, 0);
    (s === steps[2] ? brightParts : silverParts).push(disc);
  }

  const control = [
    p(0.0, 0.132),
    p(0.19, 0.132),
    p(0.15, 0.162),
    p(0.12, 0.2),
    p(0.16, 0.25),
    p(0.28, 0.34),
    p(0.36, 0.45),
    p(0.395, 0.56),
    p(0.385, 0.66),
    p(0.35, 0.75),
    p(0.325, 0.83),
    p(0.33, 0.9),
    p(0.355, 0.98),
    p(0.375, 1.05),
    p(0.38, 1.09),
    p(0.358, 1.09),
    p(0.345, 1.04),
    p(0.3, 0.99),
    p(0.1, 0.96),
    p(0.05, 0.96),
  ];
  const bodyGeo = new THREE.LatheGeometry(smoothProfile(control, 12), 120);
  flute(bodyGeo, 24, 0.01, 0, (t) => Math.max(0, Math.sin(Math.max(0, (t - 0.2) / 0.5) * Math.PI)));
  flute(bodyGeo, 16, 0.014, 0, (t) => Math.pow(Math.max(0, 1 - (t - 0.12) / 0.18), 1.3));
  tarnishGeometry(bodyGeo, [
    { y: 0.1, width: 0.03, strength: 0.08 },
    { y: 0.52, width: 0.04, strength: 0.12 },
    { y: 0.76, width: 0.03, strength: 0.09 },
  ], 24);
  bodyGeo.computeVertexNormals();
  silverParts.push(bodyGeo);

  brightParts.push(beadedRing(0.4, 0.012, 52, 0.56));
  const neckBand = new THREE.TorusGeometry(0.323, 0.01, 8, 72);
  neckBand.rotateX(Math.PI / 2);
  neckBand.translate(0, 0.83, 0);
  neckBand.computeVertexNormals();
  brightParts.push(neckBand);
  silverParts.push(chasedLeafBand(0.36, 0.68, 34, 0.018));

  const hp = handlePair(
    [
      new THREE.Vector3(0.33, 0.85, 0),
      new THREE.Vector3(0.47, 0.87, 0),
      new THREE.Vector3(0.52, 0.79, 0),
      new THREE.Vector3(0.52, 0.67, 0),
      new THREE.Vector3(0.46, 0.61, 0),
      new THREE.Vector3(0.38, 0.62, 0),
    ],
    0.02,
    72,
    14,
    (t) => 0.7 + 0.6 * Math.sin(t * Math.PI),
  );
  hp.scale(1, 1, 0.55);
  silverParts.push(hp);

  content.add(new THREE.Mesh(mergePrepared(silverParts), silver));
  content.add(new THREE.Mesh(mergePrepared(brightParts), bright));

  return finalizeVessel(root, content);
}

function chasedLeafBand(radius: number, y: number, count: number, size: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    // A repeating pair of laurel leaves canted into a continuous ribbon, rather
    // than isolated specks that catch the key light as scattered white dots.
    for (const off of [-0.35, 0.35]) {
      const leaf = new THREE.SphereGeometry(size, 6, 4);
      leaf.scale(2.1, 0.26, 0.5);
      leaf.rotateZ(off > 0 ? 0.6 : -0.6);
      leaf.rotateY(a);
      leaf.translate(Math.cos(a) * radius, y + off * size, Math.sin(a) * radius);
      parts.push(leaf);
    }
  }
  const merged = mergePrepared(parts);
  // Chasing sits proud of the surface but holds tarnish in its relief, so read it
  // as slightly darkened silver, not a bright applied bead.
  const pos = merged.getAttribute('position') as THREE.BufferAttribute;
  const colors: number[] = [];
  for (let i = 0; i < pos.count; i++) colors.push(0.82, 0.82, 0.82);
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return merged;
}
