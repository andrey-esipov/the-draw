import * as THREE from 'three';
import { Text, configureTextBuilder } from 'troika-three-text';
import { createText } from './text';
import type { Draw, Player, SetScore, Side } from '../data/types';
import type { SlamTheme } from '../ui/theme';
import { type BracketLayout, type PlateNode } from './layout';
import { BLOOM_LAYER } from './stage';
import { buildMarkAtlas } from './marks';
import { createMatchCard, type MatchCard } from './matchcard';

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

function setsNeeded(bestOf: number): number {
  return Math.ceil(bestOf / 2);
}

function isWalkover(sides: Side[], winner: string | null): boolean {
  return !!winner && sides.length === 2 && sides.every((s) => s.sets.length === 0);
}

function isRetirement(side: Side, winner: string | null, bestOf: number): boolean {
  if (!winner || side.player === winner) return false;
  const wonSets = side.sets.filter((s) => s.won).length;
  return side.sets.length > 0 && wonSets < setsNeeded(bestOf);
}

function scoreOpacity(set: SetScore | undefined, playerWon: boolean): number {
  if (!set) return 0.18;
  if (playerWon) return set.won ? 0.84 : 0.66;
  return set.won ? 0.5 : 0.34;
}

/** Rounds 1 and 2 carry 96 of the 127 matches. They stay quiet until you come close. */

export interface PlateField {
  group: THREE.Group;
  /** The plate slabs alone, for building a floor reflection. */
  mesh: THREE.InstancedMesh;
  /** Repaint plate and label colour for the current hover / route selection. */
  setHighlight: (route: Set<string>, litPlayer: string | null) => void;
  /** 0 → 1 route draw progress, shared with route.setProgress(t). */
  setRouteProgress: (t: number) => void;
  /** Fade dense early rounds in as the camera approaches them. */
  updateDetail: (camera: THREE.PerspectiveCamera, viewportH: number) => void;
  setHover: (node: PlateNode | null) => void;
  setExpanded: (node: PlateNode | null) => void;
  closeExpanded: () => void;
  expanded: () => PlateNode | null;
  pickExpanded: (raycaster: THREE.Raycaster) => boolean;
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

function easeOutExpo(t: number): number {
  if (t >= 1) return 1;
  return 1 - 2 ** (-10 * t);
}

function roundedPerimeter(steps = 8): THREE.Vector2[] {
  const w = 0.5;
  const h = 0.5;
  const r = 0.07;
  const out: THREE.Vector2[] = [];
  const corner = (cx: number, cy: number, start: number, end: number) => {
    for (let i = 0; i <= steps; i++) {
      const a = start + ((end - start) * i) / steps;
      out.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
  };
  out.push(new THREE.Vector2(-w + r, h), new THREE.Vector2(w - r, h));
  corner(w - r, h - r, Math.PI / 2, 0);
  out.push(new THREE.Vector2(w, -h + r));
  corner(w - r, -h + r, 0, -Math.PI / 2);
  out.push(new THREE.Vector2(-w + r, -h));
  corner(-w + r, -h + r, -Math.PI / 2, -Math.PI);
  out.push(new THREE.Vector2(-w, h - r));
  corner(-w + r, h - r, Math.PI, Math.PI / 2);
  return out;
}

function createHoverStroke(theme: SlamTheme, reduced: boolean) {
  const pts = roundedPerimeter();
  const inner = 0.976;
  const positions: number[] = [];
  const along: number[] = [];
  const indices: number[] = [];
  const lengths = [0];
  let total = 0;
  for (let i = 1; i <= pts.length; i++) {
    total += pts[i % pts.length]!.distanceTo(pts[i - 1]!);
    lengths.push(total);
  }

  for (let i = 0; i <= pts.length; i++) {
    const p = pts[i % pts.length]!;
    const a = lengths[i]! / total;
    positions.push(p.x, p.y, 0, p.x * inner, p.y * inner, 0);
    along.push(a, a);
    if (i < pts.length) {
      const j = i * 2;
      indices.push(j, j + 1, j + 2, j + 1, j + 3, j + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
  geo.setIndex(indices);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      uColor: { value: new THREE.Color(theme.flare) },
      uProgress: { value: 0 },
      uOpacity: { value: 1 },
    },
    vertexShader: `
      attribute float aAlong;
      varying float vAlong;
      void main() {
        vAlong = aAlong;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uProgress;
      uniform float uOpacity;
      varying float vAlong;
      void main() {
        float head = smoothstep(uProgress, uProgress - 0.045, vAlong);
        float tail = smoothstep(0.998, 0.985, vAlong) + smoothstep(0.0, 0.018, vAlong);
        float a = min(head, tail) * uOpacity;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;
  mesh.renderOrder = 7;
  const group = new THREE.Group();
  group.add(mesh);
  let node: PlateNode | null = null;
  let start = 0;

  return {
    group,
    set: (next: PlateNode | null) => {
      if (node === next) return;
      node = next;
      if (!node) {
        mesh.visible = false;
        return;
      }
      start = performance.now();
      mesh.visible = true;
      group.position.set(node.x, node.y, node.z + 0.235);
      group.scale.set(node.w + Math.max(0.12, node.h * 0.12), node.h + Math.max(0.06, node.h * 0.09), 1);
      mat.uniforms.uProgress.value = reduced ? 1 : 0;
    },
    update: (now: number) => {
      if (!node || !mesh.visible) return;
      const raw = reduced ? 1 : Math.min(1, (now - start) / 210);
      mat.uniforms.uProgress.value = easeOutExpo(raw);
    },
    dispose: () => {
      geo.dispose();
      mat.dispose();
      group.removeFromParent();
    },
  };
}

export function createPlates(
  layout: BracketLayout,
  draw: Draw,
  theme: SlamTheme,
): PlateField {
  const group = new THREE.Group();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  const hoverStroke = createHoverStroke(theme, reduced);
  group.add(hoverStroke.group);
  const matchCard: MatchCard = createMatchCard(draw, theme, reduced);
  group.add(matchCard.group);

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
  const scores: { text: Text; node: PlateNode; base: number }[] = [];

  const atlas = buildMarkAtlas(
    Object.values(draw.players).map((p) => p.country ?? '').filter(Boolean),
    theme,
  );
  const marks: { node: PlateNode; player: string; won: boolean; x: number; y: number; size: number }[] = [];

  for (const n of layout.plates) {
    const showsScore = n.round >= 5;
    const scoreCount = showsScore ? Math.max(3, ...n.match.sides.map((s) => s.sets.length)) : 0;
    const scoreSize = Math.max(0.2, n.h * 0.165);
    const scoreStep = scoreSize * 1.35;
    const scoreRight = n.x + n.w / 2 - n.w * 0.055;
    const scoreStart = scoreRight - (Math.max(0, scoreCount - 1) * scoreStep);
    const seedRight = n.x + n.w / 2 - n.w * 0.05;
    n.match.sides.forEach((side, row) => {
      const p = side ? draw.players[side.player] : undefined;
      const rowY = n.y + (row === 0 ? n.h * 0.22 : -n.h * 0.22);

      const markSize = Math.min(n.h * 0.42, n.w * 0.13);
      const markX = n.x - n.w / 2 + n.w * 0.05 + markSize / 2;
      const nameX = markX + markSize / 2 + n.w * 0.04;
      const won = !!side && n.match.winner === side.player;

      const nameSize = Math.max(0.2, n.h * 0.3);
      const seedSize = nameSize * (showsScore ? 0.28 : 0.6);
      const seedW = side?.seed ? seedSize * (0.6 * side.seed.length + 0.9) : 0;
      const playerSeedX = showsScore ? n.x - n.w / 2 + n.w * 0.025 : seedRight;
      const maxW = showsScore
        ? Math.max(n.w * 0.24, scoreStart - scoreStep * 0.88 - nameX)
        : Math.max(n.w * 0.3, playerSeedX - seedW - n.w * 0.035 - nameX);

      const t = createText();
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
        const s = createText();
        s.text = side.seed;
        s.font = MONO;
        s.fontSize = seedSize;
        s.anchorX = showsScore ? 'left' : 'right';
        s.anchorY = 'middle';
        s.letterSpacing = 0.04;
        s.color = flare.getHex();
        s.fillOpacity = won ? 0.62 : 0.3;
        s.position.set(playerSeedX, rowY, n.z + 0.16);
        s.userData.isText = true;
        s.sync();
        group.add(s);
        labels.push({ text: s, node: n, player: side.player, row: row as 0 | 1, base: s.fillOpacity });
      }

      if (showsScore && side) {
        const playerWon = n.match.winner === side.player;
        const walkover = isWalkover(n.match.sides, n.match.winner);
        if (walkover || (!n.match.winner && side.sets.length === 0)) {
          const note = createText();
          note.text = walkover ? (playerWon ? 'W/O' : '—') : '—';
          note.font = MONO;
          note.fontSize = scoreSize * 0.82;
          note.anchorX = 'right';
          note.anchorY = 'middle';
          note.letterSpacing = 0.08;
          note.color = playerWon ? flare.getHex() : chalk.getHex();
          note.fillOpacity = playerWon ? 0.66 : 0.22;
          note.position.set(scoreRight, rowY, n.z + 0.165);
          note.userData.isText = true;
          note.sync();
          group.add(note);
          scores.push({ text: note, node: n, base: note.fillOpacity });
        } else {
          side.sets.forEach((set, i) => {
            const x = scoreStart + i * scoreStep;
            const g = createText();
            g.text = String(set.games);
            g.font = MONO;
            g.fontSize = scoreSize;
            g.anchorX = 'center';
            g.anchorY = 'middle';
            g.letterSpacing = 0.015;
            g.color = playerWon ? flare.getHex() : chalk.getHex();
            g.fillOpacity = scoreOpacity(set, playerWon);
            g.position.set(x, rowY, n.z + 0.165);
            g.userData.isText = true;
            g.sync();
            group.add(g);
            scores.push({ text: g, node: n, base: g.fillOpacity });

            if (set.tiebreak !== null) {
              const tb = createText();
              tb.text = String(set.tiebreak);
              tb.font = MONO;
              tb.fontSize = scoreSize * 0.48;
              tb.anchorX = 'left';
              tb.anchorY = 'middle';
              tb.letterSpacing = 0;
              tb.color = playerWon ? flare.getHex() : chalk.getHex();
              tb.fillOpacity = scoreOpacity(set, playerWon) * 0.92;
              tb.position.set(x + scoreSize * 0.36, rowY + scoreSize * 0.28, n.z + 0.168);
              tb.userData.isText = true;
              tb.sync();
              group.add(tb);
              scores.push({ text: tb, node: n, base: tb.fillOpacity });
            }
          });

          if (isRetirement(side, n.match.winner, draw.bestOf)) {
            const ret = createText();
            ret.text = 'RET';
            ret.font = MONO;
            ret.fontSize = scoreSize * 0.52;
            ret.anchorX = 'left';
            ret.anchorY = 'middle';
            ret.letterSpacing = 0.06;
            ret.color = chalk.getHex();
            ret.fillOpacity = 0.32;
            ret.position.set(scoreStart + scoreCount * scoreStep - scoreStep * 0.45, rowY, n.z + 0.165);
            ret.userData.isText = true;
            ret.sync();
            group.add(ret);
            scores.push({ text: ret, node: n, base: ret.fillOpacity });
          }
        }
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

    layout.plates.forEach((_, i) => seams.setColorAt(i, dim));
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
  function setRouteProgress(_t: number) {}

  function updateDetail(camera: THREE.PerspectiveCamera, viewportH: number) {
    const now = performance.now();
    hoverStroke.update(now);
    matchCard.update(now);
    const focal = viewportH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    for (const l of labels) {
      tmp.set(l.node.x, l.node.y, l.node.z);
      const px = (l.text.fontSize * focal) / Math.max(1, camera.position.distanceTo(tmp));
      const lod = Math.min(1, Math.max(0, (px - 3.2) / 3.2));
      const fade = lod * lod * (3 - 2 * lod);
      const vis = fade > 0.02;
      if (l.text.visible !== vis) l.text.visible = vis;
      l.text.fillOpacity = l.base * fade;
    }
    for (const s of scores) {
      tmp.set(s.node.x, s.node.y, s.node.z);
      const px = (s.text.fontSize * focal) / Math.max(1, camera.position.distanceTo(tmp));
      const lod = Math.min(1, Math.max(0, (px - 4.0) / 3.8));
      const fade = lod * lod * (3 - 2 * lod);
      const vis = fade > 0.025;
      if (s.text.visible !== vis) s.text.visible = vis;
      s.text.fillOpacity = s.base * fade;
    }
  }

  function pick(ray: THREE.Raycaster): PlateNode | null {
    const hits = ray.intersectObject(mesh, false);
    const id = hits[0]?.instanceId;
    return id === undefined ? null : (layout.plates[id] ?? null);
  }

  mesh.layers.enable(0);

  const debug = window as unknown as Record<string, unknown>;
  const debugOwner = Symbol('draw-card');
  debug.__drawCardOwner = debugOwner;
  debug.__drawCardHover = (matchId: string | null) => {
    hoverStroke.set(matchId ? (layout.byMatch.get(matchId) ?? null) : null);
  };
  debug.__drawCardOpen = (matchId: string | null) => {
    matchCard.set(matchId ? (layout.byMatch.get(matchId) ?? null) : null);
  };
  debug.__drawCardClose = () => matchCard.close();

  return {
    group,
    mesh,
    setHighlight,
    setRouteProgress,
    updateDetail,
    setHover: hoverStroke.set,
    setExpanded: matchCard.set,
    closeExpanded: matchCard.close,
    expanded: matchCard.current,
    pickExpanded: matchCard.pick,
    pick,
    dispose: () => {
      if (debug.__drawCardOwner === debugOwner) {
        delete debug.__drawCardHover;
        delete debug.__drawCardOpen;
        delete debug.__drawCardClose;
        delete debug.__drawRouteDividerProgress;
        delete debug.__drawCardOwner;
      }
      geo.dispose();
      mat.dispose();
      mesh.dispose();
      seamGeo.dispose();
      seamMat.dispose();
      seams.dispose();
      labels.forEach((l) => l.text.dispose());
      scores.forEach((s) => s.text.dispose());
      markGeo.dispose();
      markMat.dispose();
      markMesh.dispose();
      atlas.dispose();
      hoverStroke.dispose();
      matchCard.dispose();
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
