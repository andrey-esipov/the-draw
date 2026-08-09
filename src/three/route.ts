import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import type { SlamTheme } from '../ui/theme';
import type { PlateNode } from './layout';
import { BLOOM_LAYER } from './stage';

export interface Route {
  group: THREE.Group;
  curve: THREE.CatmullRomCurve3 | null;
  /** 0 → 1. Draws the thread on, then holds it lit. */
  setProgress: (t: number) => void;
  resize: (w: number, h: number) => void;
  dispose: () => void;
}

/**
 * The route rises slightly off the plates so it reads as a thread laid over the
 * board rather than a line drawn on it.
 */
export function routeCurve(path: PlateNode[]): THREE.CatmullRomCurve3 | null {
  if (path.length < 2) return null;
  const pts: THREE.Vector3[] = [];
  path.forEach((n, i) => {
    pts.push(new THREE.Vector3(n.x, n.y, n.z + 0.14));
    const next = path[i + 1];
    if (next) {
      pts.push(
        new THREE.Vector3(
          (n.x + next.x) / 2,
          (n.y + next.y) / 2 + 0.55,
          (n.z + next.z) / 2 + 0.14,
        ),
      );
    }
  });
  return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4);
}

export function createRoute(
  path: PlateNode[],
  theme: SlamTheme,
  champion: boolean,
  w: number,
  h: number,
): Route {
  const group = new THREE.Group();
  const curve = routeCurve(path);
  if (!curve) {
    return { group, curve: null, setProgress: () => {}, resize: () => {}, dispose: () => group.removeFromParent() };
  }

  const SEG = 420;
  const sampled = curve.getSpacedPoints(SEG);
  const flat: number[] = [];
  for (const p of sampled) flat.push(p.x, p.y, p.z);

  const colour = new THREE.Color(champion ? theme.flare : theme.trace);

  const make = (width: number, opacity: number) => {
    const geo = new LineGeometry();
    geo.setPositions(flat);
    const mat = new LineMaterial({
      color: colour.getHex(),
      linewidth: width,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    mat.resolution.set(w, h);
    const line = new Line2(geo, mat);
    line.computeLineDistances();
    line.layers.enable(BLOOM_LAYER);
    group.add(line);
    return { geo, mat, line };
  };

  const halo = make(5, champion ? 0.11 : 0.07);
  const core = make(2.1, champion ? 0.92 : 0.74);

  const headGeo = new THREE.SphereGeometry(0.13, 20, 14);
  const headMat = new THREE.MeshBasicMaterial({ color: colour.clone().lerp(new THREE.Color(0xffffff), 0.55) });
  const head = new THREE.Mesh(headGeo, headMat);
  head.layers.enable(BLOOM_LAYER);
  group.add(head);

  function setProgress(t: number) {
    const clamped = Math.max(0, Math.min(1, t));
    const count = Math.max(2, Math.round(clamped * SEG));
    halo.geo.instanceCount = count;
    core.geo.instanceCount = count;
    const drawing = clamped < 1;
    head.visible = drawing;
    if (drawing) {
      curve!.getPointAt(clamped, head.position);
      head.position.z += 0.14;
      const pulse = 1 + Math.sin(performance.now() * 0.012) * 0.18;
      head.scale.setScalar(pulse);
    }
  }
  setProgress(0);

  return {
    group,
    curve,
    setProgress,
    resize: (rw, rh) => {
      halo.mat.resolution.set(rw, rh);
      core.mat.resolution.set(rw, rh);
    },
    dispose: () => {
      halo.geo.dispose();
      halo.mat.dispose();
      core.geo.dispose();
      core.mat.dispose();
      headGeo.dispose();
      headMat.dispose();
      group.removeFromParent();
    },
  };
}
