import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SlamId } from '../../data/types';
import {
  VesselOpts,
  finalizeVessel,
  flute,
  handlePair,
  isWomens,
  metalMat,
  p,
  smoothProfile,
  toColor,
} from './index';

export function createWimbledonVessel(slam: SlamId, opts: VesselOpts): THREE.Group {
  return isWomens(slam) ? venusRosewaterDish(opts) : gentlemensCup(opts);
}

// ---------------------------------------------------------------------------
// Gentlemen's Singles Trophy — silver-gilt covered cup with pineapple finial.
// ---------------------------------------------------------------------------
function gentlemensCup(opts: VesselOpts): THREE.Group {
  const root = new THREE.Group();
  root.name = 'vessel-wimbledon-men';
  const content = new THREE.Group();

  const goldColor = toColor(opts.metal).lerp(new THREE.Color('#d8ad57'), 0.82);
  const gold = metalMat(goldColor, { envMap: opts.envMap, roughness: 0.22, envMapIntensity: 1.5, clearcoat: 0.5 });
  const goldBright = metalMat(goldColor.clone().lerp(new THREE.Color('#f2d489'), 0.35), {
    envMap: opts.envMap,
    roughness: 0.16,
    envMapIntensity: 1.7,
  });

  const control = [
    p(0.0, 0.0),
    p(0.29, 0.0),
    p(0.31, 0.02),
    p(0.3, 0.05),
    p(0.24, 0.06),
    p(0.12, 0.11),
    p(0.085, 0.17),
    p(0.13, 0.23),
    p(0.085, 0.29),
    p(0.1, 0.33),
    p(0.22, 0.43),
    p(0.33, 0.57),
    p(0.375, 0.71),
    p(0.36, 0.84),
    p(0.31, 0.98),
    p(0.285, 1.08),
    p(0.29, 1.13),
    p(0.26, 1.13),
    p(0.26, 1.09),
    p(0.1, 1.06),
    p(0.05, 1.06),
  ];
  const bodyGeo = new THREE.LatheGeometry(smoothProfile(control, 9), 80);
  flute(bodyGeo, 24, 0.009, 0, (t) => Math.max(0, Math.sin(Math.min(t / 0.66, 1) * Math.PI)) * 0.8);
  bodyGeo.computeVertexNormals();
  content.add(new THREE.Mesh(bodyGeo, gold));

  const collar = new THREE.TorusGeometry(0.288, 0.016, 8, 72);
  collar.rotateX(Math.PI / 2);
  collar.translate(0, 1.118, 0);
  const midBand = new THREE.TorusGeometry(0.377, 0.018, 8, 72);
  midBand.rotateX(Math.PI / 2);
  midBand.translate(0, 0.71, 0);
  const bands = mergeGeometries([collar, midBand]);
  bands.computeVertexNormals();
  content.add(new THREE.Mesh(bands, goldBright));

  const lidControl = [
    p(0.05, 1.13),
    p(0.285, 1.13),
    p(0.3, 1.15),
    p(0.298, 1.19),
    p(0.283, 1.235),
    p(0.248, 1.28),
    p(0.195, 1.32),
    p(0.13, 1.35),
    p(0.075, 1.368),
    p(0.05, 1.378),
    p(0.055, 1.4),
    p(0.03, 1.405),
    p(0.0, 1.405),
  ];
  const lidGeo = new THREE.LatheGeometry(smoothProfile(lidControl, 9), 80);
  flute(lidGeo, 24, 0.011, 0, (t) => Math.max(0, Math.sin(t * Math.PI)) * 0.7);
  lidGeo.computeVertexNormals();
  content.add(new THREE.Mesh(lidGeo, gold));

  content.add(new THREE.Mesh(pineapple(0.062, 1.405, 0.27), goldBright));

  const hp = handlePair(
    [
      new THREE.Vector3(0.3, 1.0, 0),
      new THREE.Vector3(0.5, 1.0, 0),
      new THREE.Vector3(0.6, 0.85, 0),
      new THREE.Vector3(0.6, 0.68, 0),
      new THREE.Vector3(0.44, 0.6, 0),
      new THREE.Vector3(0.36, 0.64, 0),
    ],
    0.024,
    80,
    14,
    (t) => 0.7 + 0.6 * Math.sin(t * Math.PI),
  );
  content.add(new THREE.Mesh(hp, gold));

  return finalizeVessel(root, content);
}

// A legible pineapple finial: quilted ovoid body + a crown of upright leaves.
function pineapple(radius: number, baseY: number, height: number): THREE.BufferGeometry {
  const bodyH = height * 0.66;
  const seg = 28;
  const rings = 16;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const y = baseY + t * bodyH;
    const ovoid = Math.sin(Math.PI * (0.12 + t * 0.76));
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const quilt = 0.12 * Math.sin(9 * a + t * Math.PI * 9) * Math.sin(t * Math.PI);
      const r = radius * ovoid * (1 + quilt);
      positions.push(Math.cos(a) * r, y, Math.sin(a) * r);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j;
      const b = (i + 1) * (seg + 1) + j;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  body.setIndex(indices);
  body.computeVertexNormals();

  const parts: THREE.BufferGeometry[] = [body];
  const crownY = baseY + bodyH;
  const outer = 9;
  for (let k = 0; k < outer; k++) {
    const len = height * 0.42;
    const leaf = new THREE.ConeGeometry(radius * 0.3, len, 5, 1);
    leaf.translate(0, len / 2, 0);
    leaf.rotateZ(-0.95);
    leaf.translate(radius * 0.55, crownY - height * 0.02, 0);
    leaf.applyMatrix4(new THREE.Matrix4().makeRotationY((k / outer) * Math.PI * 2));
    parts.push(leaf);
  }
  const inner = 6;
  for (let k = 0; k < inner; k++) {
    const len = height * 0.34;
    const leaf = new THREE.ConeGeometry(radius * 0.26, len, 5, 1);
    leaf.translate(0, len / 2, 0);
    leaf.rotateZ(-0.45);
    leaf.translate(radius * 0.3, crownY + height * 0.04, 0);
    leaf.applyMatrix4(new THREE.Matrix4().makeRotationY(((k + 0.5) / inner) * Math.PI * 2));
    parts.push(leaf);
  }
  const tip = new THREE.ConeGeometry(radius * 0.22, height * 0.38, 6, 1);
  tip.translate(0, crownY + height * 0.19, 0);
  parts.push(tip);

  parts.forEach((g) => g.deleteAttribute('uv'));
  const merged = mergeGeometries(parts);
  merged.computeVertexNormals();
  return merged;
}

// ---------------------------------------------------------------------------
// Venus Rosewater Dish — a large sterling salver displayed upright, tilted.
// ---------------------------------------------------------------------------
function venusRosewaterDish(opts: VesselOpts): THREE.Group {
  const root = new THREE.Group();
  root.name = 'vessel-wimbledon-women';
  const content = new THREE.Group();

  const silverColor = toColor(opts.metal).lerp(new THREE.Color('#e8ecf0'), 0.55);
  const silver = metalMat(silverColor, { envMap: opts.envMap, roughness: 0.28, envMapIntensity: 1.15, clearcoat: 0.3 });
  const silverBright = metalMat(silverColor.clone().lerp(new THREE.Color('#ffffff'), 0.25), {
    envMap: opts.envMap,
    roughness: 0.18,
    envMapIntensity: 1.5,
  });

  const dish = new THREE.Group();

  const R = 0.62;
  const plateControl = [
    p(0.0, 0.0),
    p(0.1, -0.004),
    p(0.32, -0.02),
    p(0.46, -0.024),
    p(R - 0.08, -0.012),
    p(R - 0.02, 0.03),
    p(R, 0.07),
    p(R - 0.006, 0.1),
    p(R - 0.05, 0.082),
    p(R - 0.06, 0.05),
    p(0.46, 0.006),
    p(0.12, 0.012),
    p(0.0, 0.014),
  ];
  const plate = new THREE.LatheGeometry(smoothProfile(plateControl, 10), 96);
  plate.computeVertexNormals();
  dish.add(new THREE.Mesh(plate, silver));

  // Gadrooned outer rim (generic ornament — no crest).
  dish.add(new THREE.Mesh(gadroonRing(R - 0.055, 0.085, 44, 0.03, 0.055), silverBright));

  // Repoussé figure frieze suggested by a ring of raised medallion bosses.
  dish.add(new THREE.Mesh(bossRing(0.42, 16, 0.05, 0.03, 0.03), silver));
  dish.add(new THREE.Mesh(gadroonRing(0.3, 0.06, 30, 0.022, 0.03), silverBright));

  // Radiating panel ribs in the mid-field, echoing the dish's segmented relief.
  dish.add(new THREE.Mesh(radialRibs(0.205, 0.285, 24, 0.014, 0.028), silver));

  for (const rad of [0.2, 0.36, 0.48, 0.56]) {
    const ring = new THREE.TorusGeometry(rad, 0.01, 8, 72);
    ring.rotateX(Math.PI / 2);
    ring.translate(0, 0.028, 0);
    dish.add(new THREE.Mesh(ring, silverBright));
  }

  // Raised central boss: domed gadrooned medallion with a crowning button.
  const bossControl = [
    p(0.0, 0.15),
    p(0.07, 0.146),
    p(0.14, 0.122),
    p(0.185, 0.08),
    p(0.2, 0.045),
    p(0.205, 0.028),
    p(0.205, 0.016),
    p(0.0, 0.016),
  ];
  const boss = new THREE.LatheGeometry(smoothProfile(bossControl, 12), 96);
  flute(boss, 20, 0.06, 0, (t) => Math.sin(t * Math.PI));
  boss.computeVertexNormals();
  dish.add(new THREE.Mesh(boss, silverBright));

  const button = new THREE.SphereGeometry(0.045, 16, 12);
  button.scale(1, 0.85, 1);
  button.translate(0, 0.152, 0);
  dish.add(new THREE.Mesh(button, silver));

  // Stand the salver upright and tilt it toward the camera.
  dish.rotation.x = Math.PI / 2 - 0.2;
  content.add(dish);

  // Discreet easel foot so the disc reads as displayed, not floating.
  const easel = new THREE.Group();
  for (const side of [-1, 1]) {
    const leg = new THREE.CylinderGeometry(0.012, 0.016, 0.5, 12);
    leg.translate(0, 0.24, 0);
    leg.rotateX(-0.34);
    leg.rotateZ(side * 0.12);
    leg.translate(side * 0.12, 0, -0.14);
    easel.add(new THREE.Mesh(leg, silver));
  }
  const crossbar = new THREE.CylinderGeometry(0.012, 0.012, 0.3, 12);
  crossbar.rotateZ(Math.PI / 2);
  crossbar.translate(0, 0.16, 0.02);
  easel.add(new THREE.Mesh(crossbar, silver));
  content.add(easel);

  return finalizeVessel(root, content);
}

// A raised annular gadroon ring: repeating radial ridges standing proud of the
// face. `count` lobes, `amp` height, sitting at height `baseY`.
function gadroonRing(radius: number, width: number, count: number, amp: number, baseY: number): THREE.BufferGeometry {
  const rings = 6;
  const seg = count * 5;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const rr = radius - width / 2 + (i / rings) * width;
    const across = Math.sin((i / rings) * Math.PI);
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const lobe = Math.pow(0.5 + 0.5 * Math.cos(count * a), 1.5);
      positions.push(Math.cos(a) * rr, baseY + amp * across * lobe, Math.sin(a) * rr);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j;
      const b = (i + 1) * (seg + 1) + j;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// A ring of raised medallion bosses evoking a repoussé figure frieze.
function bossRing(radius: number, count: number, size: number, rise: number, baseY: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < count; k++) {
    const dome = new THREE.SphereGeometry(size, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    dome.scale(1, rise / size, 1.5);
    const a = (k / count) * Math.PI * 2;
    dome.translate(Math.cos(a) * radius, baseY, Math.sin(a) * radius);
    parts.push(dome);
  }
  const merged = mergeGeometries(parts);
  merged.computeVertexNormals();
  return merged;
}

// Raised radial ribs across an annular field, evoking segmented relief panels.
function radialRibs(r0: number, r1: number, count: number, rise: number, baseY: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const len = r1 - r0;
  for (let k = 0; k < count; k++) {
    const rib = new THREE.BoxGeometry(0.012, rise, len);
    rib.translate(0, baseY + rise / 2, r0 + len / 2);
    rib.applyMatrix4(new THREE.Matrix4().makeRotationY((k / count) * Math.PI * 2));
    parts.push(rib);
  }
  const merged = mergeGeometries(parts);
  merged.computeVertexNormals();
  return merged;
}
