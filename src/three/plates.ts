import * as THREE from 'three';
import { Text, configureTextBuilder } from 'troika-three-text';
import type { Draw, Player } from '../data/types';
import type { SlamTheme } from '../ui/theme';
import type { BracketLayout, PlateNode } from './layout';
import { BLOOM_LAYER } from './stage';
import { buildMarkAtlas } from './marks';

const BASE = import.meta.env.BASE_URL;
const MONO = `${BASE}fonts/mono-latin.woff`;
const NAME_ADVANCING = `${BASE}fonts/sans-latin-600.woff`;
const NAME_OUT = `${BASE}fonts/sans-latin.woff`;

/** Troika takes one font per Text; the global default covers the rest of Latin. */
configureTextBuilder({ defaultFontURL: `${BASE}fonts/mono-latin-ext.woff` });

/** Names tighten as they grow; small type on a dark field wants a little air. */
function tracking(size: number): number {
  return THREE.MathUtils.clamp(0.024 - size * 0.05, -0.018, 0.012);
}

/** Troika reports real advance widths only after a sync, so fit against those. */
function fitToWidth(t: Text, maxW: number, floor: number): void {
  t.sync(() => {
    const info = (t as unknown as { textRenderInfo?: { blockBounds: number[] } }).textRenderInfo;
    if (!info) return;
    const w = info.blockBounds[2] - info.blockBounds[0];
    if (w <= maxW) return;
    t.fontSize *= Math.max(floor, maxW / w);
    t.letterSpacing = tracking(t.fontSize);
    t.sync();
  });
}

/** Rounds 1 and 2 carry 96 of the 127 matches. They stay quiet until you come close. */

export interface PlateField {
  group: THREE.Group;
  /** The plate slabs alone, for building a floor reflection. */
  mesh: THREE.InstancedMesh;
  /** Repaint plate and label colour for the current hover / route selection. */
  setHighlight: (route: Set<string>, litPlayer: string | null) => void;
  /** Fade dense early rounds in as the camera approaches them. */
  updateDetail: (camera: THREE.PerspectiveCamera, viewportH: number) => void;
  pick: (raycaster: THREE.Raycaster) => PlateNode | null;
  dispose: () => void;
}

function shortName(p: Player | undefined): string {
  if (!p) return '';
  return p.short ?? p.name;
}

/** A plate is a thin bevelled slab: two player rows, a hairline between them. */
function plateGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const w = 0.5;
  const h = 0.5;
  const r = 0.055;
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.quadraticCurveTo(w, -h, w, -h + r);
  shape.lineTo(w, h - r);
  shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h);
  shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, -h + r);
  shape.quadraticCurveTo(-w, -h, -w + r, -h);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.09,
    bevelEnabled: true,
    bevelThickness: 0.022,
    bevelSize: 0.02,
    bevelSegments: 2,
    curveSegments: 3,
  });
  geo.translate(0, 0, -0.045);
  return geo;
}

export function createPlates(
  layout: BracketLayout,
  draw: Draw,
  theme: SlamTheme,
): PlateField {
  const group = new THREE.Group();

  const geo = plateGeometry();
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(theme.groundDeep).multiplyScalar(5.2),
    roughness: 0.28,
    metalness: 0.78,
    clearcoat: 0.9,
    clearcoatRoughness: 0.22,
    envMapIntensity: 1.6,
    emissive: new THREE.Color(theme.ground),
    emissiveIntensity: 0.34,
  });

  const mesh = new THREE.InstancedMesh(geo, mat, layout.plates.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(layout.plates.length * 3),
    3,
  );

  const dummy = new THREE.Object3D();
  const base = new THREE.Color(theme.groundDeep).multiplyScalar(5.2);
  const chalk = new THREE.Color(theme.chalk);
  const seamLit = new THREE.Color(theme.flare);
  const flare = new THREE.Color(theme.flare);
  const trace = new THREE.Color(theme.trace);

  layout.plates.forEach((n, i) => {
    dummy.position.set(n.x, n.y, n.z);
    dummy.scale.set(n.w, n.h, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, base);
  });
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);

  const seamGeo = new THREE.PlaneGeometry(1, 1);
  const seamMat = new THREE.MeshBasicMaterial({
    color: chalk,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const seams = new THREE.InstancedMesh(seamGeo, seamMat, layout.plates.length);
  seams.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(layout.plates.length * 3),
    3,
  );
  const dim = chalk.clone().multiplyScalar(0.9);
  layout.plates.forEach((n, i) => {
    dummy.position.set(n.x, n.y, n.z + 0.12);
    dummy.scale.set(n.w * 0.94, Math.max(0.018, n.h * 0.016), 1);
    dummy.updateMatrix();
    seams.setMatrixAt(i, dummy.matrix);
    seams.setColorAt(i, dim);
  });
  seams.instanceMatrix.needsUpdate = true;
  seams.layers.enable(BLOOM_LAYER);
  group.add(seams);

  /** Two rows of type per plate, plus the score, laid on the slab face. */
  const labels: { text: Text; node: PlateNode; player: string | null; row: 0 | 1; base: number }[] = [];

  const atlas = buildMarkAtlas(
    Object.values(draw.players).map((p) => p.country ?? '').filter(Boolean),
    theme,
  );
  const marks: { node: PlateNode; player: string; won: boolean; x: number; y: number; size: number }[] = [];

  for (const n of layout.plates) {
    n.match.sides.forEach((side, row) => {
      const p = side ? draw.players[side.player] : undefined;
      const rowY = n.y + (row === 0 ? n.h * 0.22 : -n.h * 0.22);

      const markSize = Math.min(n.h * 0.42, n.w * 0.13);
      const markX = n.x - n.w / 2 + n.w * 0.05 + markSize / 2;
      const nameX = markX + markSize / 2 + n.w * 0.04;
      const won = !!side && n.match.winner === side.player;

      const nameSize = Math.max(0.2, n.h * 0.3);
      const seedSize = nameSize * 0.6;
      const seedW = side?.seed ? seedSize * (0.6 * side.seed.length + 0.9) : 0;
      const maxW = Math.max(n.w * 0.3, n.x + n.w / 2 - n.w * 0.05 - seedW - nameX);

      const t = new Text();
      t.text = shortName(p);
      t.font = won ? NAME_ADVANCING : NAME_OUT;
      t.fontSize = nameSize;
      t.anchorX = 'left';
      t.anchorY = 'middle';
      t.letterSpacing = tracking(nameSize);
      t.color = chalk.getHex();
      t.fillOpacity = won ? 1 : 0.38;
      t.position.set(nameX, rowY, n.z + 0.16);
      t.maxWidth = maxW;
      t.whiteSpace = 'nowrap';
      t.overflowWrap = 'normal';
      t.userData.isText = true;
      fitToWidth(t, maxW, 0.68);
      group.add(t);
      labels.push({ text: t, node: n, player: side?.player ?? null, row: row as 0 | 1, base: t.fillOpacity });

      if (p) {
        marks.push({
          node: n,
          player: side!.player,
          won: n.match.winner === side!.player,
          x: markX,
          y: rowY,
          size: markSize,
        });
      }

      if (side?.seed) {
        const s = new Text();
        s.text = side.seed;
        s.font = MONO;
        s.fontSize = seedSize;
        s.anchorX = 'right';
        s.anchorY = 'middle';
        s.letterSpacing = 0.04;
        s.color = flare.getHex();
        s.fillOpacity = won ? 0.62 : 0.3;
        s.position.set(n.x + n.w / 2 - n.w * 0.05, rowY, n.z + 0.16);
        s.userData.isText = true;
        s.sync();
        group.add(s);
        labels.push({ text: s, node: n, player: side.player, row: row as 0 | 1, base: s.fillOpacity });
      }
    });
  }

  const markGeo = new THREE.PlaneGeometry(1, 1);
  const markUv = new Float32Array(marks.length * 4);
  const markFade = new Float32Array(marks.length);
  markGeo.setAttribute('aUvRect', new THREE.InstancedBufferAttribute(markUv, 4));
  markGeo.setAttribute('aFade', new THREE.InstancedBufferAttribute(markFade, 1));

  const markMat = new THREE.MeshBasicMaterial({
    map: atlas.texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  markMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec4 aUvRect;\nattribute float aFade;\nvarying float vFade;',
      )
      .replace(
        '#include <uv_vertex>',
        '#include <uv_vertex>\nvMapUv = mix(aUvRect.xy, aUvRect.zw, uv);\nvFade = aFade;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFade;')
      .replace(
        '#include <opaque_fragment>',
        'gl_FragColor.a *= vFade;\n#include <opaque_fragment>',
      );
  };

  const markMesh = new THREE.InstancedMesh(markGeo, markMat, Math.max(1, marks.length));
  markMesh.count = marks.length;
  markMesh.frustumCulled = false;
  markMesh.renderOrder = 2;
  marks.forEach((m, i) => {
    const rect = atlas.uv(draw.players[m.player]?.country ?? '');
    markUv.set(rect, i * 4);
    markFade[i] = m.won ? 0.95 : 0.45;
    dummy.position.set(m.x, m.y, m.node.z + 0.15);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(m.size, m.size, 1);
    dummy.updateMatrix();
    markMesh.setMatrixAt(i, dummy.matrix);
  });
  markMesh.instanceMatrix.needsUpdate = true;
  group.add(markMesh);

  function setHighlight(route: Set<string>, litPlayer: string | null) {
    layout.plates.forEach((n, i) => {
      const on = route.has(n.match.id);
      const c = on ? (litPlayer && litPlayer === n.match.winner ? flare : trace) : base;
      mesh.setColorAt(i, on ? c.clone().multiplyScalar(0.55) : base);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    layout.plates.forEach((n, i) => {
      const on = route.has(n.match.id);
      seams.setColorAt(i, on ? seamLit : dim);
    });
    if (seams.instanceColor) seams.instanceColor.needsUpdate = true;

    marks.forEach((m, i) => {
      const mine = m.player === litPlayer;
      const onRoute = route.has(m.node.match.id);
      markFade[i] = mine ? 1 : onRoute ? (m.won ? 0.9 : 0.5) : m.won ? 0.5 : 0.22;
    });
    (markGeo.getAttribute('aFade') as THREE.InstancedBufferAttribute).needsUpdate = true;

    for (const l of labels) {
      const mine = l.player !== null && l.player === litPlayer;
      const onRoute = route.has(l.node.match.id);
      l.text.color = mine ? flare.getHex() : chalk.getHex();
      const won = l.node.match.winner === l.player;
      l.base = mine ? 1 : onRoute ? (won ? 0.9 : 0.5) : won ? 0.9 : 0.36;
      l.text.sync();
    }
  }

  const tmp = new THREE.Vector3();
  function updateDetail(camera: THREE.PerspectiveCamera, viewportH: number) {
    const focal = viewportH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    for (const l of labels) {
      tmp.set(l.node.x, l.node.y, l.node.z);
      const px = (l.text.fontSize * focal) / Math.max(1, camera.position.distanceTo(tmp));
      const lod = Math.min(1, Math.max(0, (px - 4.6) / 4));
      const fade = lod * lod * (3 - 2 * lod);
      const vis = fade > 0.02;
      if (l.text.visible !== vis) l.text.visible = vis;
      l.text.fillOpacity = l.base * fade;
    }
  }

  function pick(ray: THREE.Raycaster): PlateNode | null {
    const hits = ray.intersectObject(mesh, false);
    const id = hits[0]?.instanceId;
    return id === undefined ? null : (layout.plates[id] ?? null);
  }

  mesh.layers.enable(0);


  return {
    group,
    mesh,
    setHighlight,
    updateDetail,
    pick,
    dispose: () => {
      geo.dispose();
      mat.dispose();
      mesh.dispose();
      seamGeo.dispose();
      seamMat.dispose();
      seams.dispose();
      labels.forEach((l) => l.text.dispose());
      markGeo.dispose();
      markMat.dispose();
      markMesh.dispose();
      atlas.dispose();
      group.removeFromParent();
    },
  };
}

/** The connectors: the elbows that make a bracket look like a bracket. */
export function createConnectors(layout: BracketLayout, theme: SlamTheme): THREE.LineSegments {
  const pts: number[] = [];
  for (const c of layout.connectors) {
    const { from, to } = c;
    const outX = from.x + (to.x - from.x) * 0.38;
    const a = new THREE.Vector3(from.x + (from.side || 1) * (from.w / 2) * -1, from.y, from.z);
    const start = new THREE.Vector3(from.x + Math.sign(to.x - from.x) * (from.w / 2), from.y, from.z);
    const knee = new THREE.Vector3(outX, from.y, from.z + (to.z - from.z) * 0.45);
    const rise = new THREE.Vector3(outX, to.y, from.z + (to.z - from.z) * 0.55);
    const end = new THREE.Vector3(to.x - Math.sign(to.x - from.x) * (to.w / 2), to.y, to.z);
    void a;
    const chain = [start, knee, rise, end];
    for (let i = 0; i < chain.length - 1; i++) {
      pts.push(chain[i]!.x, chain[i]!.y, chain[i]!.z);
      pts.push(chain[i + 1]!.x, chain[i + 1]!.y, chain[i + 1]!.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color(theme.chalk),
    transparent: true,
    opacity: 0.36,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.layers.disable(BLOOM_LAYER);
  return lines;
}
