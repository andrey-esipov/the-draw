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
    p(0.37, 0.03),
    p(0.32, 0.06),
    p(0.22, 0.085),
    p(0.14, 0.11),
    p(0.115, 0.14),
    p(0.16, 0.17),
    p(0.11, 0.2),
    p(0.12, 0.235),
    p(0.22, 0.3),
    p(0.36, 0.4),
    p(0.47, 0.52),
    p(0.52, 0.66),
    p(0.515, 0.8),
    p(0.485, 0.91),
    p(0.49, 0.99),
    p(0.55, 1.08),
    p(0.565, 1.14),
    p(0.535, 1.14),
    p(0.5, 1.07),
    p(0.3, 1.02),
    p(0.06, 1.01),
    p(0.05, 1.01),
  ];
  const bodyGeo = new THREE.LatheGeometry(smoothProfile(control, 9), 96);
  flute(bodyGeo, 22, 0.02, 0, (t) => Math.pow(Math.max(0, 1 - t / 0.2), 1.4));
  flute(bodyGeo, 24, 0.014, 0, (t) => Math.max(0, Math.sin(Math.max(0, (t - 0.28) / 0.42) * Math.PI)));
  flute(bodyGeo, 60, 0.0028, 0, (t) => Math.max(0, Math.sin(Math.min(t / 0.62, 1) * Math.PI)));
  bodyGeo.computeVertexNormals();
  content.add(new THREE.Mesh(bodyGeo, silver));

  const band = beadedRing(0.53, 0.016, 58, 0.7);
  content.add(new THREE.Mesh(band, bright));
  const rimBead = beadedRing(0.5, 0.015, 60, 1.05);
  content.add(new THREE.Mesh(rimBead, bright));

  // Large scroll handles springing from the shoulder and curling above the rim.
  const hp = handlePair(
    [
      new THREE.Vector3(0.5, 0.79, 0),
      new THREE.Vector3(0.67, 0.85, 0),
      new THREE.Vector3(0.74, 0.99, 0),
      new THREE.Vector3(0.71, 1.14, 0),
      new THREE.Vector3(0.6, 1.23, 0),
      new THREE.Vector3(0.51, 1.18, 0),
      new THREE.Vector3(0.5, 1.09, 0),
    ],
    0.032,
    88,
    16,
    (t) => 0.7 + 0.6 * Math.sin(t * Math.PI),
  );
  hp.scale(1, 1, 0.6);
  content.add(new THREE.Mesh(hp, silver));

  // Scroll curls where the handles spring from the shoulder.
  for (const side of [-1, 1]) {
    const curl = new THREE.TorusGeometry(0.04, 0.018, 8, 24);
    curl.rotateY(Math.PI / 2);
    curl.translate(side * 0.51, 0.79, 0);
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
  const bodyGeo = new THREE.LatheGeometry(smoothProfile(control, 9), 80);
  flute(bodyGeo, 24, 0.013, 0, (t) => Math.pow(Math.max(0, 1 - (t - 0.3) / 0.4), 1.3) * (t > 0.3 ? 1 : 0));
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
    p(0.37, 0.9),
    p(0.375, 0.925),
    p(0.36, 0.955),
    p(0.335, 0.99),
    p(0.29, 1.04),
    p(0.235, 1.09),
    p(0.175, 1.135),
    p(0.115, 1.17),
    p(0.075, 1.195),
    p(0.05, 1.21),
    p(0.0, 1.215),
  ];
  const lidGeo = new THREE.LatheGeometry(smoothProfile(lidControl, 9), 80);
  flute(lidGeo, 28, 0.008, 0, (t) => Math.max(0, Math.sin(t * Math.PI)));
  lidGeo.computeVertexNormals();
  content.add(new THREE.Mesh(lidGeo, silver));

  const collar = new THREE.TorusGeometry(0.235, 0.012, 8, 64);
  collar.rotateX(Math.PI / 2);
  collar.translate(0, 1.085, 0);
  collar.computeVertexNormals();
  content.add(new THREE.Mesh(collar, bright));

  const neck = new THREE.CylinderGeometry(0.018, 0.028, 0.06, 16);
  neck.translate(0, 1.24, 0);
  const bud = new THREE.SphereGeometry(0.045, 16, 12);
  bud.scale(1, 1.4, 1);
  bud.translate(0, 1.31, 0);
  const spike = new THREE.ConeGeometry(0.02, 0.07, 12);
  spike.translate(0, 1.39, 0);
  const finial = mergeGeometries([neck, bud, spike]);
  finial.computeVertexNormals();
  content.add(new THREE.Mesh(finial, bright));

  const hp = handlePair(
    [
      new THREE.Vector3(0.35, 0.56, 0),
      new THREE.Vector3(0.56, 0.55, 0),
      new THREE.Vector3(0.64, 0.68, 0),
      new THREE.Vector3(0.6, 0.83, 0),
      new THREE.Vector3(0.46, 0.89, 0),
      new THREE.Vector3(0.35, 0.87, 0),
    ],
    0.023,
    72,
    14,
    (t) => 0.7 + 0.6 * Math.sin(t * Math.PI),
  );
  hp.scale(1, 1, 0.58);
  content.add(new THREE.Mesh(hp, silver));

  return finalizeVessel(root, content);
}
