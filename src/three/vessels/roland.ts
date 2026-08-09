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

  const control = [
    p(0.0, 0.0),
    p(0.38, 0.0),
    p(0.4, 0.03),
    p(0.34, 0.07),
    p(0.2, 0.11),
    p(0.12, 0.16),
    p(0.16, 0.22),
    p(0.12, 0.27),
    p(0.2, 0.31),
    p(0.42, 0.44),
    p(0.54, 0.6),
    p(0.575, 0.78),
    p(0.59, 0.95),
    p(0.61, 1.06),
    p(0.625, 1.12),
    p(0.6, 1.13),
    p(0.52, 1.06),
    p(0.46, 0.98),
    p(0.14, 0.92),
    p(0.05, 0.92),
  ];
  const bodyGeo = new THREE.LatheGeometry(smoothProfile(control, 9), 96);
  flute(bodyGeo, 22, 0.022, 0, (t) => Math.pow(Math.max(0, 1 - t / 0.5), 1.3));
  flute(bodyGeo, 60, 0.0032, 0, (t) => Math.max(0, Math.sin(Math.min(t / 0.6, 1) * Math.PI)));
  flute(bodyGeo, 32, 0.006, 0, (t) => Math.max(0, Math.sin(Math.max(0, (t - 0.55) / 0.4) * Math.PI)));
  bodyGeo.computeVertexNormals();
  content.add(new THREE.Mesh(bodyGeo, silver));

  const beadBand = beadedRing(0.6, 0.02, 52, 1.0);
  content.add(new THREE.Mesh(beadBand, bright));
  const bellyBand = new THREE.TorusGeometry(0.542, 0.014, 8, 72);
  bellyBand.rotateX(Math.PI / 2);
  bellyBand.translate(0, 0.6, 0);
  bellyBand.computeVertexNormals();
  content.add(new THREE.Mesh(bellyBand, bright));

  const hp = handlePair(
    [
      new THREE.Vector3(0.52, 0.62, 0),
      new THREE.Vector3(0.74, 0.64, 0),
      new THREE.Vector3(0.82, 0.82, 0),
      new THREE.Vector3(0.74, 1.0, 0),
      new THREE.Vector3(0.56, 1.05, 0),
    ],
    0.032,
    72,
    16,
    (t) => 0.75 + 0.5 * Math.sin(t * Math.PI),
  );
  content.add(new THREE.Mesh(hp, silver));

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

  const control = [
    p(0.0, 0.0),
    p(0.28, 0.0),
    p(0.29, 0.03),
    p(0.23, 0.06),
    p(0.12, 0.1),
    p(0.08, 0.17),
    p(0.12, 0.23),
    p(0.08, 0.29),
    p(0.14, 0.33),
    p(0.3, 0.46),
    p(0.38, 0.62),
    p(0.37, 0.78),
    p(0.33, 0.9),
    p(0.34, 1.0),
    p(0.4, 1.09),
    p(0.44, 1.15),
    p(0.42, 1.16),
    p(0.35, 1.1),
    p(0.31, 1.02),
    p(0.1, 0.97),
    p(0.05, 0.97),
  ];
  const bodyGeo = new THREE.LatheGeometry(smoothProfile(control, 9), 96);
  flute(bodyGeo, 18, 0.02, 0, (t) => Math.pow(Math.max(0, 1 - t / 0.5), 1.3));
  flute(bodyGeo, 48, 0.003, 0, (t) => Math.max(0, Math.sin(Math.min(t / 0.62, 1) * Math.PI)));
  bodyGeo.computeVertexNormals();
  content.add(new THREE.Mesh(bodyGeo, silver));

  content.add(new THREE.Mesh(beadedRing(0.435, 0.015, 48, 1.11), bright));
  const bellyBand = new THREE.TorusGeometry(0.38, 0.012, 8, 72);
  bellyBand.rotateX(Math.PI / 2);
  bellyBand.translate(0, 0.62, 0);
  bellyBand.computeVertexNormals();
  content.add(new THREE.Mesh(bellyBand, bright));

  const knopBand = new THREE.TorusGeometry(0.12, 0.02, 8, 48);
  knopBand.rotateX(Math.PI / 2);
  knopBand.translate(0, 0.2, 0);
  knopBand.computeVertexNormals();
  content.add(new THREE.Mesh(knopBand, bright));

  const hp = handlePair(
    [
      new THREE.Vector3(0.36, 0.64, 0),
      new THREE.Vector3(0.55, 0.68, 0),
      new THREE.Vector3(0.61, 0.85, 0),
      new THREE.Vector3(0.54, 1.04, 0),
      new THREE.Vector3(0.37, 1.08, 0),
    ],
    0.024,
    72,
    14,
    (t) => 0.75 + 0.5 * Math.sin(t * Math.PI),
  );
  content.add(new THREE.Mesh(hp, silver));

  return finalizeVessel(root, content);
}

