import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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

export function createAustralianVessel(slam: SlamId, opts: VesselOpts): THREE.Group {
  return isWomens(slam) ? daphneAkhurst(opts) : normanBrookes(opts);
}

function silverMaterials(opts: VesselOpts) {
  const base = toColor(opts.metal).lerp(new THREE.Color('#e4e8ec'), 0.55);
  const silver = metalMat(base, { envMap: opts.envMap, roughness: 0.19, envMapIntensity: 1.5, clearcoat: 0.45 });
  const bright = metalMat(base.clone().lerp(new THREE.Color('#ffffff'), 0.24), {
    envMap: opts.envMap,
    roughness: 0.13,
    envMapIntensity: 1.75,
  });
  return { silver, bright };
}

// ---------------------------------------------------------------------------
// Norman Brookes Challenge Cup — wide krater, scroll handles above the rim.
// ---------------------------------------------------------------------------
function normanBrookes(opts: VesselOpts): THREE.Group {
  const root = new THREE.Group();
  root.name = 'vessel-australian-men';
  const content = new THREE.Group();
  const { silver, bright } = silverMaterials(opts);

  const control = [
    p(0.0, 0.0),
    p(0.36, 0.0),
    p(0.38, 0.03),
    p(0.32, 0.06),
    p(0.26, 0.09),
    p(0.28, 0.11),
    p(0.16, 0.15),
    p(0.11, 0.21),
    p(0.15, 0.26),
    p(0.11, 0.31),
    p(0.2, 0.35),
    p(0.42, 0.48),
    p(0.53, 0.64),
    p(0.56, 0.8),
    p(0.575, 0.94),
    p(0.6, 1.04),
    p(0.64, 1.12),
    p(0.66, 1.16),
    p(0.62, 1.16),
    p(0.54, 1.08),
    p(0.46, 0.98),
    p(0.14, 0.9),
    p(0.05, 0.9),
  ];
  const bodyGeo = new THREE.LatheGeometry(smoothProfile(control, 9), 96);
  flute(bodyGeo, 22, 0.018, 0, (t) => Math.pow(Math.max(0, 1 - t / 0.45), 1.4));
  flute(bodyGeo, 60, 0.0028, 0, (t) => Math.max(0, Math.sin(Math.min(t / 0.62, 1) * Math.PI)));
  bodyGeo.computeVertexNormals();
  content.add(new THREE.Mesh(bodyGeo, silver));

  const band = beadedRing(0.57, 0.016, 54, 0.82);
  content.add(new THREE.Mesh(band, bright));

  // Volute scroll handles springing from the belly and curling above the rim.
  const hp = handlePair(
    [
      new THREE.Vector3(0.52, 0.66, 0),
      new THREE.Vector3(0.78, 0.7, 0),
      new THREE.Vector3(0.88, 0.9, 0),
      new THREE.Vector3(0.84, 1.08, 0),
      new THREE.Vector3(0.66, 1.18, 0),
      new THREE.Vector3(0.55, 1.11, 0),
      new THREE.Vector3(0.58, 1.02, 0),
    ],
    0.036,
    80,
    16,
    (t) => 0.7 + 0.6 * Math.sin(t * Math.PI),
  );
  content.add(new THREE.Mesh(hp, silver));

  // Scroll curls where the handles spring from the belly.
  for (const side of [-1, 1]) {
    const curl = new THREE.TorusGeometry(0.045, 0.02, 8, 24);
    curl.rotateY(Math.PI / 2);
    curl.translate(side * 0.53, 0.66, 0);
    content.add(new THREE.Mesh(curl, bright));
  }

  return finalizeVessel(root, content);
}

// ---------------------------------------------------------------------------
// Daphne Akhurst Memorial Cup — smaller covered loving cup with finial.
// ---------------------------------------------------------------------------
function daphneAkhurst(opts: VesselOpts): THREE.Group {
  const root = new THREE.Group();
  root.name = 'vessel-australian-women';
  const content = new THREE.Group();
  const { silver, bright } = silverMaterials(opts);

  const control = [
    p(0.0, 0.0),
    p(0.28, 0.0),
    p(0.3, 0.03),
    p(0.24, 0.06),
    p(0.12, 0.1),
    p(0.08, 0.16),
    p(0.11, 0.21),
    p(0.08, 0.26),
    p(0.14, 0.3),
    p(0.33, 0.44),
    p(0.39, 0.6),
    p(0.37, 0.74),
    p(0.35, 0.85),
    p(0.36, 0.9),
    p(0.34, 0.9),
    p(0.3, 0.86),
    p(0.12, 0.82),
    p(0.05, 0.82),
  ];
  const bodyGeo = new THREE.LatheGeometry(smoothProfile(control, 9), 96);
  flute(bodyGeo, 40, 0.006, 0, (t) => Math.max(0, Math.sin(Math.min(t / 0.7, 1) * Math.PI)));
  bodyGeo.computeVertexNormals();
  content.add(new THREE.Mesh(bodyGeo, silver));

  const rimBand = new THREE.TorusGeometry(0.36, 0.012, 8, 72);
  rimBand.rotateX(Math.PI / 2);
  rimBand.translate(0, 0.895, 0);
  rimBand.computeVertexNormals();
  content.add(new THREE.Mesh(rimBand, bright));

  const lidControl = [
    p(0.05, 0.9),
    p(0.36, 0.9),
    p(0.35, 0.925),
    p(0.31, 0.96),
    p(0.24, 1.0),
    p(0.14, 1.04),
    p(0.07, 1.07),
    p(0.05, 1.085),
    p(0.0, 1.09),
  ];
  const lidGeo = new THREE.LatheGeometry(smoothProfile(lidControl, 9), 96);
  flute(lidGeo, 40, 0.008, 0, (t) => Math.max(0, Math.sin(t * Math.PI)));
  lidGeo.computeVertexNormals();
  content.add(new THREE.Mesh(lidGeo, silver));

  // Turned finial: bud on a slender neck.
  const neck = new THREE.CylinderGeometry(0.018, 0.026, 0.05, 16);
  neck.translate(0, 1.11, 0);
  const bud = new THREE.SphereGeometry(0.045, 16, 12);
  bud.scale(1, 1.35, 1);
  bud.translate(0, 1.17, 0);
  const spike = new THREE.ConeGeometry(0.02, 0.06, 12);
  spike.translate(0, 1.24, 0);
  const finial = mergeGeometries([neck, bud, spike]);
  finial.computeVertexNormals();
  content.add(new THREE.Mesh(finial, bright));

  const hp = handlePair(
    [
      new THREE.Vector3(0.36, 0.56, 0),
      new THREE.Vector3(0.54, 0.62, 0),
      new THREE.Vector3(0.59, 0.76, 0),
      new THREE.Vector3(0.52, 0.88, 0),
      new THREE.Vector3(0.35, 0.88, 0),
    ],
    0.024,
    72,
    14,
    (t) => 0.75 + 0.5 * Math.sin(t * Math.PI),
  );
  content.add(new THREE.Mesh(hp, silver));

  return finalizeVessel(root, content);
}
