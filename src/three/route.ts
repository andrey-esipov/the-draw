import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import type { SlamTheme } from '../ui/theme';
import type { PlateNode } from './layout';
import { BLOOM_LAYER } from './stage';

export interface Route {
  group: THREE.Group;
  curve: THREE.Curve<THREE.Vector3> | null;
  /** 0 → 1. Draws the thread on, then holds it lit. */
  setProgress: (t: number) => void;
  resize: (w: number, h: number) => void;
  dispose: () => void;
}

const CORNER_RADIUS = 0.15;
const EPS = 0.0001;
/** Sits the thread on the plate face so it reads as one printed line. */
const FACE_LIFT = 0.142;

function connectorChain(from: PlateNode, to: PlateNode): THREE.Vector3[] {
  const outX = from.x + (to.x - from.x) * 0.38;
  const direction = Math.sign(to.x - from.x) || 1;
  const fz = from.z + FACE_LIFT;
  const tz = to.z + FACE_LIFT;
  return [
    new THREE.Vector3(from.x + direction * (from.w / 2), from.y, fz),
    new THREE.Vector3(outX, from.y, fz + (tz - fz) * 0.45),
    new THREE.Vector3(outX, to.y, fz + (tz - fz) * 0.55),
    new THREE.Vector3(to.x - direction * (to.w / 2), to.y, tz),
  ];
}

function dividerExit(n: PlateNode, direction: number): THREE.Vector3 {
  return new THREE.Vector3(n.x + direction * (n.w / 2), n.y, n.z + FACE_LIFT);
}

function terminalStroke(n: PlateNode): THREE.Vector3[] {
  const direction = n.side === -1 ? 1 : n.side === 1 ? -1 : 1;
  const edge = dividerExit(n, direction);
  const outside = edge.clone().addScaledVector(new THREE.Vector3(direction, 0, 0), Math.min(n.w * 0.22, 0.62));
  return [outside, edge];
}

function finalExit(path: PlateNode[]): THREE.Vector3 | null {
  const last = path[path.length - 1];
  const prev = path[path.length - 2];
  if (!last || !prev) return null;
  const entryDirection = Math.sign(last.x - prev.x) || (prev.side === -1 ? 1 : -1);
  return dividerExit(last, entryDirection);
}

function dividerBridge(from: PlateNode, to: PlateNode): THREE.Vector3[] {
  const direction = Math.sign(to.x - from.x) || 1;
  return [
    dividerExit(from, -direction),
    dividerExit(from, direction),
  ];
}

function pushPoint(out: THREE.Vector3[], point: THREE.Vector3) {
  const last = out[out.length - 1];
  if (!last || last.distanceToSquared(point) > EPS) out.push(point);
}

function routePolyline(path: PlateNode[], apex?: { x: number; y: number; z: number }): THREE.Vector3[] {
  if (path.length === 0) return [];
  if (path.length === 1) return terminalStroke(path[0]!);

  const pts: THREE.Vector3[] = [];
  const firstDirection = Math.sign(path[1]!.x - path[0]!.x) || 1;
  pushPoint(pts, dividerExit(path[0]!, -firstDirection));

  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i]!;
    const to = path[i + 1]!;
    if (i > 0) {
      for (const point of dividerBridge(from, to)) pushPoint(pts, point);
    }
    const chain = connectorChain(from, to);
    for (const point of chain) pushPoint(pts, point);
  }

  const last = pts[pts.length - 1];
  if (apex && last) {
    const exit = finalExit(path);
    const crown = new THREE.Vector3(apex.x, apex.y, apex.z);
    if (exit) pushPoint(pts, exit);
    const lift = new THREE.Vector3(
      (exit ?? last).x + (crown.x - (exit ?? last).x) * 0.18,
      (exit ?? last).y + (crown.y - (exit ?? last).y) * 0.2,
      (exit ?? last).z + 0.42,
    );
    pushPoint(pts, lift);
    pushPoint(pts, crown);
  }

  return pts;
}

function roundedPath(points: THREE.Vector3[], apex?: { x: number; y: number; z: number }): THREE.CurvePath<THREE.Vector3> | null {
  if (points.length < 2) return null;
  const path = new THREE.CurvePath<THREE.Vector3>();
  let cursor = points[0]!.clone();
  const flightStarts = apex ? points.length - 2 : -1;

  for (let i = 1; i < points.length - 1; i++) {
    if (i === flightStarts) {
      const end = points[points.length - 1]!;
      const c1 = points[i]!;
      const c2 = new THREE.Vector3(
        c1.x + (end.x - c1.x) * 0.66,
        c1.y + (end.y - c1.y) * 0.72,
        Math.max(c1.z, end.z) + 1.08,
      );
      path.add(new THREE.CubicBezierCurve3(cursor.clone(), c1.clone(), c2, end.clone()));
      return path;
    }

    const prev = points[i - 1]!;
    const corner = points[i]!;
    const next = points[i + 1]!;
    const inLen = corner.distanceTo(prev);
    const outLen = next.distanceTo(corner);
    if (inLen < EPS || outLen < EPS) continue;

    const into = corner.clone().sub(prev).normalize();
    const out = next.clone().sub(corner).normalize();
    if (Math.abs(into.dot(out)) > 0.996) {
      path.add(new THREE.LineCurve3(cursor.clone(), corner.clone()));
      cursor = corner.clone();
      continue;
    }

    const r = Math.min(CORNER_RADIUS, inLen * 0.42, outLen * 0.42);
    const before = corner.clone().addScaledVector(into, -r);
    const after = corner.clone().addScaledVector(out, r);
    path.add(new THREE.LineCurve3(cursor.clone(), before));
    path.add(new THREE.QuadraticBezierCurve3(before, corner.clone(), after));
    cursor = after;
  }

  const end = points[points.length - 1]!;
  path.add(new THREE.LineCurve3(cursor, end.clone()));
  return path;
}

export function routeCurve(
  path: PlateNode[],
  apex?: { x: number; y: number; z: number },
): THREE.Curve<THREE.Vector3> | null {
  return roundedPath(routePolyline(path, apex), apex);
}

function articulatedProgress(t: number, beats: number): number {
  if (t <= 0 || t >= 1 || beats <= 1) return t;
  const scaled = t * beats;
  const step = Math.min(beats - 1, Math.floor(scaled));
  const local = scaled - step;
  const eased = local < 0.84
    ? 0.94 * (1 - Math.pow(1 - local / 0.84, 3))
    : local < 0.93
      ? 0.94
      : 0.94 + 0.06 * (1 - Math.pow(1 - (local - 0.93) / 0.07, 2));
  return Math.min(1, (step + eased) / beats);
}

export function createRoute(
  path: PlateNode[],
  theme: SlamTheme,
  champion: boolean,
  w: number,
  h: number,
  apex?: { x: number; y: number; z: number },
): Route {
  const group = new THREE.Group();
  const curve = routeCurve(path, apex);
  if (!curve) {
    return { group, curve: null, setProgress: () => {}, resize: () => {}, dispose: () => group.removeFromParent() };
  }

  const colour = new THREE.Color(champion ? theme.flare : theme.trace);

  // One unbroken polyline: the thread crosses the plates and the gaps between
  // them at exactly the same width, so there is no seam to see.
  const totalLength = Math.max(EPS, curve.getLength());
  const sampleCount = Math.max(96, Math.ceil(totalLength * 22));
  const lines: { geo: LineGeometry; mat: LineMaterial }[] = [];

  const make = (width: number, opacity: number) => {
    const sampled = curve.getSpacedPoints(sampleCount);
    const flat: number[] = [];
    for (const p of sampled) flat.push(p.x, p.y, p.z);
    const geo = new LineGeometry();
    geo.setPositions(flat);
    const mat = new LineMaterial({
      color: colour.getHex(),
      linewidth: width,
      worldUnits: false,
      transparent: true,
      opacity,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    mat.resolution.set(w, h);
    const line = new Line2(geo, mat);
    line.computeLineDistances();
    line.renderOrder = 8;
    line.layers.enable(BLOOM_LAYER);
    group.add(line);
    const out = { geo, mat };
    lines.push(out);
    return out;
  };

  const auraWidth = champion ? 7 : 5.5;
  const haloWidth = champion ? 3.5 : 3;
  const coreWidth = champion ? 1.5 : 1.25;

  make(auraWidth, champion ? 0.08 : 0.06);
  make(haloWidth, champion ? 0.18 : 0.14);
  make(coreWidth, champion ? 0.82 : 0.72).mat.blending = THREE.NormalBlending;

  const headGeo = new THREE.SphereGeometry(champion ? 0.17 : 0.145, 20, 14);
  const headMat = new THREE.MeshBasicMaterial({ color: colour.clone().lerp(new THREE.Color(0xffffff), 0.55) });
  const head = new THREE.Mesh(headGeo, headMat);
  head.renderOrder = 9;
  head.layers.enable(BLOOM_LAYER);
  group.add(head);

  const capGeo = new THREE.SphereGeometry(champion ? 0.12 : 0.105, 18, 12);
  const capMat = new THREE.MeshBasicMaterial({
    color: colour.clone().lerp(new THREE.Color(0xffffff), 0.28),
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const cap = new THREE.Mesh(capGeo, capMat);
  curve.getPointAt(1, cap.position);
  cap.visible = false;
  cap.renderOrder = 9;
  cap.layers.enable(BLOOM_LAYER);
  group.add(cap);

  const beats = Math.max(1, path.length + (apex ? 1 : 0));

  function setProgress(t: number) {
    const clamped = Math.max(0, Math.min(1, t));
    const drawn = articulatedProgress(clamped, beats);
    const count = drawn <= 0 ? 0 : Math.max(2, Math.round(drawn * sampleCount));
    lines.forEach((line) => {
      line.geo.instanceCount = count;
    });
    const drawing = clamped > 0 && clamped < 1;
    head.visible = drawing;
    cap.visible = champion && clamped >= 0.998;
    if (drawing) {
      curve!.getPointAt(drawn, head.position);
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
      lines.forEach((line) => line.mat.resolution.set(rw, rh));
    },
    dispose: () => {
      lines.forEach((line) => {
        line.geo.dispose();
        line.mat.dispose();
      });
      headGeo.dispose();
      headMat.dispose();
      capGeo.dispose();
      capMat.dispose();
      group.removeFromParent();
    },
  };
}
