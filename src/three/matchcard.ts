import * as THREE from 'three';
import type { Draw, Match, Player, SetScore, Side } from '../data/types';
import type { SlamTheme } from '../ui/theme';
import type { PlateNode } from './layout';

const TEX_W = 2400;
const TEX_H = 620;
export const CARD_ASPECT = TEX_W / TEX_H;
/** Floor height in world units, so a first-round card reads like a final's. */
const CARD_H = 1.86;
const EASE_MS = 460;
const CLOSE_MS = 260;
const ROW_Y = [300, 470];
const COL_STEP = 172;
const COL_RIGHT = TEX_W - 200;

type Phase = 'closed' | 'opening' | 'open' | 'closing';

interface CardState {
  node: PlateNode;
  texture: THREE.CanvasTexture;
  started: number;
  phase: Phase;
  from: number;
}

export interface MatchCard {
  group: THREE.Group;
  set: (node: PlateNode | null) => void;
  close: () => void;
  current: () => PlateNode | null;
  update: (now: number) => void;
  pick: (ray: THREE.Raycaster) => boolean;
  dispose: () => void;
}

function easeOutExpo(t: number): number {
  if (t >= 1) return 1;
  return 1 - 2 ** (-10 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function alpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const IOC_TO_ISO2: Record<string, string> = {
  AND: 'AD', ARG: 'AR', AUS: 'AU', AUT: 'AT', BEL: 'BE', BIH: 'BA', BOL: 'BO', BRA: 'BR',
  BUL: 'BG', CAN: 'CA', CHI: 'CL', CHN: 'CN', COL: 'CO', CRO: 'HR', CZE: 'CZ', DEN: 'DK',
  EGY: 'EG', ESP: 'ES', FIN: 'FI', FRA: 'FR', GBR: 'GB', GEO: 'GE', GER: 'DE', GRE: 'GR',
  HKG: 'HK', HUN: 'HU', INA: 'ID', ITA: 'IT', JPN: 'JP', KAZ: 'KZ', KOR: 'KR', LAT: 'LV',
  LTU: 'LT', MEX: 'MX', MKD: 'MK', MNE: 'ME', MON: 'MC', NED: 'NL', NOR: 'NO', NZL: 'NZ',
  PAR: 'PY', PER: 'PE', PHI: 'PH', POL: 'PL', POR: 'PT', ROU: 'RO', SRB: 'RS', SLO: 'SI',
  SUI: 'CH', SVK: 'SK', SWE: 'SE', THA: 'TH', TUR: 'TR', UKR: 'UA', USA: 'US', UZB: 'UZ',
};

function flagEmoji(country: string | null | undefined): string {
  const iso = IOC_TO_ISO2[country?.toUpperCase() ?? ''];
  if (!iso) return '◼';
  return [...iso].map((c) => String.fromCodePoint(127397 + c.charCodeAt(0))).join('');
}

function setFont(ctx: CanvasRenderingContext2D, weight: number, px: number, family = 'Geist, Inter, system-ui, sans-serif'): void {
  ctx.font = `${weight} ${px}px ${family}`;
}

function roundName(draw: Draw, match: Match): string {
  return draw.rounds.find((r) => r.round === match.round)?.name ?? `Round ${match.round}`;
}

function seedLabel(seed: string | null): string {
  return seed ? `(${seed})` : '';
}

function setsNeeded(draw: Draw): number {
  return Math.ceil(draw.bestOf / 2);
}

function isRetirement(draw: Draw, match: Match): boolean {
  if (!match.winner) return false;
  const winner = match.sides.find((s) => s.player === match.winner);
  return !!winner && winner.sets.filter((s) => s.won).length < setsNeeded(draw) && winner.sets.length > 0;
}

function isWalkover(match: Match): boolean {
  return !!match.winner && match.sides.every((s) => s.sets.length === 0);
}

function scoreNote(draw: Draw, match: Match): string {
  if (!match.winner) return 'Not played';
  if (isWalkover(match)) return 'Walkover';
  if (isRetirement(draw, match)) return 'Retirement';
  if (match.sides.every((s) => s.sets.length === 0)) return 'Score unavailable';
  return '';
}

function drawSetScore(
  ctx: CanvasRenderingContext2D,
  set: SetScore | undefined,
  x: number,
  y: number,
  color: string,
  muted: boolean,
): void {
  ctx.textAlign = 'center';
  if (!set) {
    setFont(ctx, 500, 54, 'Geist Mono, ui-monospace, SFMono-Regular, monospace');
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillText('\u2013', x, y);
    return;
  }
  setFont(ctx, set.won ? 700 : 480, 74, 'Geist Mono, ui-monospace, SFMono-Regular, monospace');
  ctx.fillStyle = muted ? 'rgba(255,255,255,0.46)' : color;
  ctx.fillText(String(set.games), x, y);
  if (set.tiebreak !== null) {
    const w = ctx.measureText(String(set.games)).width;
    setFont(ctx, 620, 30, 'Geist Mono, ui-monospace, SFMono-Regular, monospace');
    ctx.fillStyle = muted ? 'rgba(255,255,255,0.34)' : color;
    ctx.textAlign = 'left';
    ctx.fillText(String(set.tiebreak), x + w / 2 + 8, y - 40);
  }
  ctx.textAlign = 'left';
}

function drawFlagPill(ctx: CanvasRenderingContext2D, player: Player | undefined, x: number, cy: number, theme: SlamTheme): void {
  roundRect(ctx, x, cy - 32, 104, 64, 20);
  ctx.fillStyle = alpha(theme.chalk, 0.09);
  ctx.fill();
  ctx.strokeStyle = alpha(theme.chalk, 0.18);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  setFont(ctx, 600, 34, 'Apple Color Emoji, Segoe UI Emoji, sans-serif');
  ctx.fillStyle = theme.chalk;
  ctx.textAlign = 'center';
  ctx.fillText(flagEmoji(player?.country), x + 52, cy + 12);
  ctx.textAlign = 'left';
}

function colX(i: number, maxSets: number): number {
  return COL_RIGHT - (maxSets - 1 - i) * COL_STEP;
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  draw: Draw,
  side: Side | undefined,
  match: Match,
  cy: number,
  theme: SlamTheme,
): void {
  const player = side ? draw.players[side.player] : undefined;
  const won = !!side && side.player === match.winner;
  const nameColor = won ? theme.chalk : alpha(theme.chalk, 0.62);
  const scoreColor = won ? theme.flare : alpha(theme.chalk, 0.62);

  if (won) {
    const g = ctx.createLinearGradient(56, cy, TEX_W - 56, cy);
    g.addColorStop(0, alpha(theme.flare, 0.2));
    g.addColorStop(0.55, alpha(theme.flare, 0.07));
    g.addColorStop(1, 'rgba(255,255,255,0)');
    roundRect(ctx, 56, cy - 74, TEX_W - 112, 148, 38);
    ctx.fillStyle = g;
    ctx.fill();
  }

  drawFlagPill(ctx, player, 88, cy, theme);

  const name = player?.short ?? 'TBD';
  setFont(ctx, won ? 720 : 500, 78);
  ctx.fillStyle = nameColor;
  ctx.textAlign = 'left';
  ctx.fillText(name, 228, cy + 27);

  if (side?.seed) {
    setFont(ctx, 620, 32, 'Geist Mono, ui-monospace, SFMono-Regular, monospace');
    ctx.fillStyle = won ? alpha(theme.flare, 0.9) : alpha(theme.chalk, 0.4);
    setFont(ctx, won ? 720 : 500, 78);
    const w = ctx.measureText(name).width;
    setFont(ctx, 620, 32, 'Geist Mono, ui-monospace, SFMono-Regular, monospace');
    ctx.fillText(seedLabel(side.seed), 228 + w + 22, cy + 24);
  }

  const maxSets = Math.max(3, ...match.sides.map((s) => s.sets.length));
  for (let i = 0; i < maxSets; i++) {
    drawSetScore(ctx, side?.sets[i], colX(i, maxSets), cy + 27, scoreColor, !won);
  }
}

function paintTexture(draw: Draw, node: PlateNode, theme: SlamTheme): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, TEX_W, TEX_H);

  const bg = ctx.createLinearGradient(0, 0, TEX_W, TEX_H);
  bg.addColorStop(0, theme.ground);
  bg.addColorStop(0.5, theme.groundDeep);
  bg.addColorStop(1, '#080b10');
  roundRect(ctx, 16, 16, TEX_W - 32, TEX_H - 32, 44);
  ctx.fillStyle = bg;
  ctx.fill();

  const wash = ctx.createRadialGradient(TEX_W * 0.12, 0, 20, TEX_W * 0.12, 0, TEX_W * 0.72);
  wash.addColorStop(0, alpha(theme.flare, 0.2));
  wash.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = wash;
  ctx.fill();

  roundRect(ctx, 16, 16, TEX_W - 32, TEX_H - 32, 44);
  ctx.strokeStyle = alpha(theme.flare, 0.5);
  ctx.lineWidth = 3;
  ctx.stroke();

  const maxSets = Math.max(3, ...node.match.sides.map((s) => s.sets.length));
  const note = scoreNote(draw, node.match);

  setFont(ctx, 660, 34, 'Geist Mono, ui-monospace, SFMono-Regular, monospace');
  ctx.textAlign = 'left';
  ctx.fillStyle = alpha(theme.flare, 0.92);
  const head = roundName(draw, node.match).toUpperCase();
  ctx.fillText(head, 88, 108);
  const headW = ctx.measureText(head).width;
  setFont(ctx, 520, 30);
  ctx.fillStyle = alpha(theme.chalk, 0.5);
  ctx.fillText(note ? `\u00b7 ${draw.tournament} \u00b7 ${note}` : `\u00b7 ${draw.tournament}`, 88 + headW + 20, 107);

  setFont(ctx, 620, 26, 'Geist Mono, ui-monospace, SFMono-Regular, monospace');
  ctx.fillStyle = alpha(theme.chalk, 0.42);
  ctx.textAlign = 'center';
  for (let i = 0; i < maxSets; i++) ctx.fillText(`S${i + 1}`, colX(i, maxSets), 106);
  ctx.textAlign = 'left';

  drawPlayer(ctx, draw, node.match.sides[0], node.match, ROW_Y[0]!, theme);
  drawPlayer(ctx, draw, node.match.sides[1], node.match, ROW_Y[1]!, theme);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function createMatchCard(draw: Draw, theme: SlamTheme, reduced: boolean): MatchCard {
  const group = new THREE.Group();
  group.visible = false;
  group.renderOrder = 8;

  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 8;
  group.add(mesh);

  // The bright edge that sweeps the score into view.
  const edgeMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(theme.flare),
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
  });
  const edge = new THREE.Mesh(geo, edgeMat);
  edge.renderOrder = 9;
  edge.visible = false;
  group.add(edge);

  let state: CardState | null = null;
  const tmpHits: THREE.Intersection[] = [];

  // The card opens by uncovering the texture, never by stretching it: the crop
  // widens while the pixel scale holds, so the names stay the size they will
  // end at and the score simply arrives.
  function apply(p: number): void {
    if (!state) return;
    const n = state.node;
    const targetH = Math.max(CARD_H, n.h * 1.12);
    const targetW = targetH * CARD_ASPECT;
    const w = mix(Math.min(n.w, targetW), targetW, p);
    const h = mix(Math.min(n.h, targetH), targetH, p);

    const tex = state.texture;
    tex.repeat.set(w / targetW, h / targetH);
    tex.offset.set(0, (1 - h / targetH) / 2);

    const left = n.x - n.w / 2;
    const z = n.z + mix(0.18, 0.82, p);
    mesh.position.set(left + w / 2, n.y, z);
    mesh.scale.set(w, h, 1);
    mat.opacity = mix(0.1, 1, Math.min(1, p * 1.3));
    group.visible = p > 0.001;

    edge.visible = p > 0.004 && p < 0.996;
    if (edge.visible) {
      edge.position.set(left + w, n.y, z + 0.01);
      edge.scale.set(0.04, h * 1.04, 1);
      edgeMat.opacity = Math.sin(p * Math.PI) * 0.85;
    }
  }

  function set(node: PlateNode | null): void {
    if (!node) {
      close();
      return;
    }
    if (state?.node.match.id === node.match.id && state.phase !== 'closing') return;
    state?.texture.dispose();
    const texture = paintTexture(draw, node, theme);
    mat.map = texture;
    mat.needsUpdate = true;
    state = {
      node,
      texture,
      phase: reduced ? 'open' : 'opening',
      started: performance.now(),
      from: 0,
    };
    apply(reduced ? 1 : 0);
  }

  function close(): void {
    if (!state || state.phase === 'closed' || state.phase === 'closing') return;
    if (reduced) {
      state.texture.dispose();
      state = null;
      mat.map = null;
      mat.opacity = 0;
      group.visible = false;
      edge.visible = false;
      return;
    }
    const current = state.phase === 'open' ? 1 : Math.min(1, (performance.now() - state.started) / EASE_MS);
    state.from = easeOutExpo(current);
    state.phase = 'closing';
    state.started = performance.now();
  }

  function update(now: number): void {
    if (!state) return;
    if (state.phase === 'open') {
      apply(1);
      return;
    }
    const dur = state.phase === 'closing' ? CLOSE_MS : EASE_MS;
    const raw = Math.min(1, (now - state.started) / dur);
    const e = easeOutExpo(raw);
    const p = state.phase === 'closing' ? mix(state.from, 0, e) : e;
    apply(p);
    if (raw < 1) return;
    if (state.phase === 'closing') {
      state.texture.dispose();
      state = null;
      mat.map = null;
      mat.opacity = 0;
      group.visible = false;
      edge.visible = false;
    } else {
      state.phase = 'open';
      apply(1);
    }
  }

  return {
    group,
    set,
    close,
    current: () => state?.node ?? null,
    update,
    pick: (ray) => {
      if (!state || !group.visible) return false;
      tmpHits.length = 0;
      ray.intersectObject(mesh, false, tmpHits);
      return tmpHits.length > 0;
    },
    dispose: () => {
      state?.texture.dispose();
      geo.dispose();
      mat.dispose();
      edgeMat.dispose();
      group.removeFromParent();
    },
  };
}
