import * as THREE from 'three';
import type { SlamId } from '../../data/types';
import {
  VesselOpts,
  beadedRing,
  finalizeVessel,
  flute,
  handlePair,
  isWomens,
  metalMat,
  p,
  smoothProfile,
  toColor,
} from './index';

export function createRolandVessel(slam: SlamId, opts: VesselOpts): THREE.Group {
  return isWomens(slam) ? suzanneLenglen(opts) : mousquetaires(opts);
}

function silverMaterials(opts: VesselOpts) {
  const base = toColor(opts.metal).lerp(new THREE.Color('#e2e6ea'), 0.5);
  const silver = metalMat(base, { envMap: opts.envMap, roughness: 0.21, envMapIntensity: 1.45, clearcoat: 0.45 });
  const bright = metalMat(base.clone().lerp(new THREE.Color('#ffffff'), 0.22), {
    envMap: opts.envMap,
    roughness: 0.14,
    envMapIntensity: 1.7,
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

  // A tall goblet: spreading decorated foot, knopped stem, deep rounded bowl,
  // and a wide everted mouth. Proportion is taller than wide (real cup is
  // 40cm x 19cm) — a chalice, not a squat coupe.
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
  const bodyGeo = new THREE.LatheGeometry(smoothProfile(control, 9), 96);
  flute(bodyGeo, 20, 0.014, 0, (t) => Math.max(0, Math.sin(Math.max(0, (t - 0.28) / 0.46) * Math.PI)));
  flute(bodyGeo, 22, 0.02, 0, (t) => Math.pow(Math.max(0, 1 - t / 0.22), 1.4));
  flute(bodyGeo, 60, 0.003, 0, (t) => Math.max(0, Math.sin(Math.min(t / 0.6, 1) * Math.PI)));
  bodyGeo.computeVertexNormals();
  content.add(new THREE.Mesh(bodyGeo, silver));

  // Vine-leaf border at the wide aperture (generic gadroon, no wordmark).
  const rimBead = beadedRing(0.475, 0.02, 56, 1.05);
  content.add(new THREE.Mesh(rimBead, bright));
  const bellyBead = beadedRing(0.478, 0.014, 60, 0.6);
  content.add(new THREE.Mesh(bellyBead, bright));
  const neckBand = new THREE.TorusGeometry(0.408, 0.014, 8, 84);
  neckBand.rotateX(Math.PI / 2);
  neckBand.translate(0, 0.885, 0);
  neckBand.computeVertexNormals();
  content.add(new THREE.Mesh(neckBand, bright));

  // Swan-shaped handles: an upright loop hugging the body, rising from the
  // belly to a swan-neck curl at the rim — the cup's signature. Kept compact
  // so it never droops below its lower root.
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
  content.add(new THREE.Mesh(hp, silver));

  // Swan-head scroll where each neck meets the rim.
  for (const side of [-1, 1]) {
    const head = new THREE.SphereGeometry(0.028, 12, 10);
    head.scale(1.3, 1, 0.7);
    head.translate(side * 0.56, 1.02, 0);
    content.add(new THREE.Mesh(head, bright));
  }

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

  const steps = [
    { r: 0.35, h: 0.05, y: 0.025 },
    { r: 0.29, h: 0.042, y: 0.071 },
    { r: 0.235, h: 0.04, y: 0.112 },
  ];
  for (const s of steps) {
    const disc = new THREE.CylinderGeometry(s.r, s.r * 1.02, s.h, 64);
    disc.translate(0, s.y, 0);
    content.add(new THREE.Mesh(disc, s === steps[2] ? bright : silver));
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
  const bodyGeo = new THREE.LatheGeometry(smoothProfile(control, 9), 96);
  flute(bodyGeo, 24, 0.01, 0, (t) => Math.max(0, Math.sin(Math.max(0, (t - 0.2) / 0.5) * Math.PI)));
  flute(bodyGeo, 16, 0.014, 0, (t) => Math.pow(Math.max(0, 1 - (t - 0.12) / 0.18), 1.3));
  bodyGeo.computeVertexNormals();
  content.add(new THREE.Mesh(bodyGeo, silver));

  content.add(new THREE.Mesh(beadedRing(0.4, 0.012, 52, 0.56), bright));
  const neckBand = new THREE.TorusGeometry(0.323, 0.01, 8, 72);
  neckBand.rotateX(Math.PI / 2);
  neckBand.translate(0, 0.83, 0);
  neckBand.computeVertexNormals();
  content.add(new THREE.Mesh(neckBand, bright));

  // Compact art-deco handles: a squared loop from belly shoulder to neck.
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
  content.add(new THREE.Mesh(hp, silver));

  return finalizeVessel(root, content);
}

