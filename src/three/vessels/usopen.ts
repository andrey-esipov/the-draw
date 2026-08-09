import * as THREE from 'three';
import type { SlamId } from '../../data/types';
import {
  VesselOpts,
  finalizeVessel,
  handlePair,
  isWomens,
  metalMat,
  p,
  smoothProfile,
  toColor,
} from './index';

export function createUsOpenVessel(slam: SlamId, opts: VesselOpts): THREE.Group {
  return isWomens(slam) ? womensCup(opts) : mensCup(opts);
}

function silverMaterials(opts: VesselOpts) {
  const base = toColor(opts.metal).lerp(new THREE.Color('#eef1f4'), 0.5);
  const silver = metalMat(base, { envMap: opts.envMap, roughness: 0.12, envMapIntensity: 1.6, clearcoat: 0.55 });
  const bright = metalMat(base.clone().lerp(new THREE.Color('#ffffff'), 0.2), {
    envMap: opts.envMap,
    roughness: 0.09,
    envMapIntensity: 1.8,
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
  const bodyGeo = new THREE.LatheGeometry(smoothProfile(control, 10), 96);
  bodyGeo.computeVertexNormals();
  content.add(new THREE.Mesh(bodyGeo, silver));

  const rim = new THREE.TorusGeometry(0.462, 0.016, 8, 72);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 1.075, 0);
  rim.computeVertexNormals();
  content.add(new THREE.Mesh(rim, bright));

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
  content.add(new THREE.Mesh(hp, silver));

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
  const bodyGeo = new THREE.LatheGeometry(smoothProfile(control, 10), 96);
  bodyGeo.computeVertexNormals();
  content.add(new THREE.Mesh(bodyGeo, silver));

  const rim = new THREE.TorusGeometry(0.362, 0.013, 8, 72);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, 1.1, 0);
  rim.computeVertexNormals();
  content.add(new THREE.Mesh(rim, bright));

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
  content.add(new THREE.Mesh(hp, silver));

  return finalizeVessel(root, content);
}
