import * as THREE from 'three';
import type { SlamId } from '../data/types';
import type { SlamTheme } from '../ui/theme';
import { COURT_Z, FLOOR_Y } from './layout';

export interface Court {
  group: THREE.Group;
  setSlam: (slam: SlamId, theme: SlamTheme) => void;
  warm: (slam: SlamId, theme: SlamTheme) => void;
  dispose: () => void;
}

const COURT_MARKER = 'THE_DRAW_COURT_REAL_SURFACES_NET_V3';
void COURT_MARKER;


const COURT_LENGTH = 23.77;
const DOUBLES_WIDTH = 10.97;
const SINGLES_WIDTH = 8.23;
const SERVICE_FROM_NET = 6.4;
const BASELINE_HALF = COURT_LENGTH / 2;
const DOUBLES_HALF = DOUBLES_WIDTH / 2;
const SINGLES_HALF = SINGLES_WIDTH / 2;
const LINE = 0.052;
const BASELINE = 0.095;
const CENTRE_MARK = 0.1;
const SCALE = 2.55;
const TEXTURE_W = 3072;
const TEXTURE_H = 4608;
const MAP_W = 1024;
const MAP_H = 1536;
const PLANE_W_M = 42;
const PLANE_L_M = 66;
const NET_POST_HALF = DOUBLES_HALF + 0.92;
const NET_CENTRE_H = 0.914;
const NET_POST_H = 1.07;
// Real ITF headband is 5–6.3cm doubled canvas; the mesh openings are ~4.5cm.
const NET_BAND_H = 0.062;
const NET_MESH_GAP = 0.006;
const NET_OPENING = 0.045;
const NET_STRAP_W = 0.05;

interface SurfacePalette {
  playing: string;
  surround: string;
  deep: string;
  line: string;
  lineAlpha: number;
  grain: number;
  bump: number;
  roughness: number;
  stripe?: string;
}

interface SurfaceTextures {
  color: THREE.CanvasTexture;
  bump: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
}

const PALETTES: Record<string, SurfacePalette> = {
  'australian-open': {
    playing: '#1673b7',
    surround: '#073845',
    deep: '#03151f',
    line: '#f5fbff',
    lineAlpha: 0.8,
    grain: 0.06,
    bump: 0.018,
    roughness: 0.86,
  },
  'roland-garros': {
    playing: '#b65a2d',
    surround: '#7a3318',
    deep: '#241007',
    line: '#fff0dd',
    lineAlpha: 0.72,
    grain: 0.2,
    bump: 0.075,
    roughness: 0.96,
  },
  wimbledon: {
    playing: '#2f6936',
    surround: '#173f27',
    deep: '#06180e',
    line: '#f5f5e9',
    lineAlpha: 0.76,
    grain: 0.1,
    bump: 0.035,
    roughness: 0.91,
    stripe: '#3f7a43',
  },
  'us-open': {
    playing: '#17599e',
    surround: '#356b39',
    deep: '#041722',
    line: '#f4f8f3',
    lineAlpha: 0.8,
    grain: 0.06,
    bump: 0.02,
    roughness: 0.84,
  },
};

function surfaceKey(slam: SlamId): string {
  if (slam.startsWith('australian')) return 'australian-open';
  if (slam.startsWith('french')) return 'roland-garros';
  if (slam.startsWith('wimbledon')) return 'wimbledon';
  return 'us-open';
}

function hexToRgb(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function mixColor(a: string, b: string, t: number): THREE.Color {
  return new THREE.Color(a).lerp(new THREE.Color(b), t);
}

function mixHex(a: string, b: string, t: number): string {
  return `#${mixColor(a, b, t).getHexString()}`;
}

function rand(seed: number): () => number {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  };
}

function softEllipse(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: string,
  alpha: number,
  rotate = 0,
): void {
  const grd = g.createRadialGradient(cx, cy, 0, cx, cy, 1);
  grd.addColorStop(0, color);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.save();
  g.globalAlpha = alpha;
  g.translate(cx, cy);
  g.rotate(rotate);
  g.scale(rx, ry);
  g.translate(-cx, -cy);
  g.fillStyle = grd;
  g.fillRect(cx - 1, cy - 1, 2, 2);
  g.restore();
}

function drawSoftLine(
  g: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  color: string,
  alpha: number,
): void {
  g.save();
  g.lineCap = 'round';
  g.strokeStyle = color;
  g.globalAlpha = alpha;
  g.lineWidth = width;
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
  g.restore();
}

function lineNoise(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: () => number, alpha: number): void {
  g.save();
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = `rgba(0,0,0,${alpha})`;
  for (let i = 0; i < 260; i++) {
    g.fillRect(x + r() * w, y + r() * h, 1 + r() * 2, 1 + r() * 2);
  }
  g.restore();
}

function buildSurfaceTextures(key: string, theme: SlamTheme): SurfaceTextures {
  const p = PALETTES[key] ?? PALETTES.wimbledon!;
  const c = document.createElement('canvas');
  c.width = TEXTURE_W;
  c.height = TEXTURE_H;
  const g = c.getContext('2d')!;
  const px = TEXTURE_W / PLANE_W_M;
  const cx = TEXTURE_W / 2;
  const cy = TEXTURE_H * 0.52;
  const x = (m: number) => cx + m * px;
  const y = (m: number) => cy - m * px;
  const w = (m: number) => Math.max(1, m * px);
  const r = rand(key.length * 9173);

  const base = g.createLinearGradient(0, 0, 0, TEXTURE_H);
  base.addColorStop(0, p.deep);
  base.addColorStop(0.35, mixHex(p.surround, theme.groundDeep, 0.18));
  base.addColorStop(0.56, p.surround);
  base.addColorStop(1, p.deep);
  g.fillStyle = base;
  g.fillRect(0, 0, TEXTURE_W, TEXTURE_H);

  g.fillStyle = p.playing;
  g.fillRect(x(-DOUBLES_HALF), y(BASELINE_HALF), w(DOUBLES_WIDTH), w(COURT_LENGTH));

  for (let i = 0; i < 38; i++) {
    softEllipse(
      g,
      x((r() - 0.5) * 18),
      y((r() - 0.5) * 34),
      w(2.2 + r() * 7.5),
      w(1.4 + r() * 6.5),
      r() > 0.5 ? '#ffffff' : '#000000',
      r() * 0.025,
      (r() - 0.5) * 0.9,
    );
  }

  if (key === 'wimbledon') {
    for (let i = -8; i < 9; i++) {
      const stripeX = x(i * 1.36);
      const stripeW = w(1.36);
      const grd = g.createLinearGradient(stripeX, 0, stripeX + stripeW, 0);
      const even = i % 2 === 0;
      grd.addColorStop(0, 'rgba(255,255,255,0)');
      grd.addColorStop(0.22, even ? rgba(p.stripe!, 0.38) : 'rgba(0,0,0,0.11)');
      grd.addColorStop(0.78, even ? rgba(p.stripe!, 0.28) : 'rgba(255,255,255,0.035)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(stripeX, y(BASELINE_HALF), stripeW, w(COURT_LENGTH));
    }
    const worn = rgba('#d7c895', 0.28);
    softEllipse(g, x(0), y(BASELINE_HALF - 1.3), w(3.9), w(1.0), worn, 0.9);
    softEllipse(g, x(0), y(-BASELINE_HALF + 1.3), w(3.9), w(1.0), worn, 0.78);
    softEllipse(g, x(-1.9), y(SERVICE_FROM_NET), w(1.4), w(0.55), worn, 0.34);
    softEllipse(g, x(1.9), y(-SERVICE_FROM_NET), w(1.4), w(0.55), worn, 0.34);
  }

  if (key === 'roland-garros') {
    for (let i = 0; i < 110; i++) {
      const zz = (r() > 0.5 ? 1 : -1) * (BASELINE_HALF - 1.4 + (r() - 0.5) * 1.4);
      softEllipse(g, x((r() - 0.5) * 7.2), y(zz), w(0.55 + r() * 1.6), w(0.12 + r() * 0.34), '#f3b077', 0.09 + r() * 0.1, (r() - 0.5) * 0.55);
    }
    for (let i = 0; i < 42; i++) {
      const sx = (r() - 0.5) * SINGLES_WIDTH;
      const sz = (r() > 0.5 ? SERVICE_FROM_NET : -SERVICE_FROM_NET) + (r() - 0.5) * 1.8;
      drawSoftLine(g, x(sx), y(sz), x(sx + (r() - 0.5) * 3.2), y(sz + (r() - 0.5) * 0.72), w(0.035 + r() * 0.04), '#ffd0a2', 0.11 + r() * 0.09);
    }
    softEllipse(g, x(0), y(BASELINE_HALF - 1.2), w(4.3), w(1.15), '#f2a166', 0.22);
    softEllipse(g, x(0), y(-BASELINE_HALF + 1.2), w(4.3), w(1.15), '#f2a166', 0.18);
    softEllipse(g, x(0), y(0), w(2.8), w(1.1), '#e07c45', 0.08);
  }

  if (key === 'australian-open' || key === 'us-open') {
    for (let i = 0; i < 46; i++) {
      softEllipse(g, x((r() - 0.5) * 16), y((r() - 0.5) * 28), w(2.2 + r() * 5.8), w(0.8 + r() * 3.2), r() > 0.52 ? '#ffffff' : '#000000', r() * 0.018, (r() - 0.5) * 1.2);
    }
    g.save();
    g.globalCompositeOperation = 'overlay';
    for (let i = 0; i < 9000; i++) {
      const a = 0.018 + r() * 0.035;
      g.fillStyle = r() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
      g.fillRect(r() * TEXTURE_W, r() * TEXTURE_H, 1, 1);
    }
    g.restore();
  }

  if (key === 'roland-garros') {
    g.save();
    g.globalCompositeOperation = 'overlay';
    for (let i = 0; i < 26000; i++) {
      const size = r() > 0.94 ? 1.8 + r() * 1.5 : 1;
      const a = 0.028 + r() * 0.09;
      g.fillStyle = r() > 0.48 ? `rgba(255,218,176,${a})` : `rgba(80,31,14,${a * 0.8})`;
      g.fillRect(r() * TEXTURE_W, r() * TEXTURE_H, size, size);
    }
    g.restore();
  }

  if (key === 'wimbledon') {
    g.save();
    g.globalCompositeOperation = 'overlay';
    for (let i = 0; i < 13000; i++) {
      const a = 0.016 + r() * 0.06;
      g.fillStyle = r() > 0.44 ? `rgba(207,224,166,${a})` : `rgba(0,44,18,${a})`;
      g.fillRect(r() * TEXTURE_W, r() * TEXTURE_H, 1 + r() * 2, 1);
    }
    g.restore();
  }

  g.save();
  g.lineCap = key === 'roland-garros' ? 'round' : 'square';
  g.lineJoin = 'round';
  g.strokeStyle = rgba(p.line, p.lineAlpha);
  g.shadowColor = key === 'roland-garros' ? rgba('#d77b45', 0.3) : rgba(theme.flare, 0.18);
  g.shadowBlur = key === 'roland-garros' ? 4.5 : 2.8;

  const lineH = (x1: number, x2: number, zm: number, width = LINE) => {
    g.lineWidth = w(width);
    g.beginPath();
    g.moveTo(x(x1), y(zm));
    g.lineTo(x(x2), y(zm));
    g.stroke();
    if (key === 'roland-garros') lineNoise(g, x(x1), y(zm) - w(width) * 1.2, w(x2 - x1), w(width) * 2.4, r, 0.12);
    if (key === 'wimbledon') lineNoise(g, x(x1), y(zm) - w(width) * 0.9, w(x2 - x1), w(width) * 1.8, r, 0.06);
  };
  const lineV = (xm: number, z1: number, z2: number, width = LINE) => {
    g.lineWidth = w(width);
    g.beginPath();
    g.moveTo(x(xm), y(z1));
    g.lineTo(x(xm), y(z2));
    g.stroke();
    if (key === 'roland-garros') lineNoise(g, x(xm) - w(width) * 1.2, y(z1), w(width) * 2.4, w(z1 - z2), r, 0.12);
    if (key === 'wimbledon') lineNoise(g, x(xm) - w(width) * 0.9, y(z1), w(width) * 1.8, w(z1 - z2), r, 0.06);
  };

  lineV(-DOUBLES_HALF, -BASELINE_HALF, BASELINE_HALF);
  lineV(DOUBLES_HALF, -BASELINE_HALF, BASELINE_HALF);
  lineV(-SINGLES_HALF, -BASELINE_HALF, BASELINE_HALF);
  lineV(SINGLES_HALF, -BASELINE_HALF, BASELINE_HALF);
  lineH(-DOUBLES_HALF, DOUBLES_HALF, -BASELINE_HALF, BASELINE);
  lineH(-DOUBLES_HALF, DOUBLES_HALF, BASELINE_HALF, BASELINE);
  lineH(-SINGLES_HALF, SINGLES_HALF, -SERVICE_FROM_NET);
  lineH(-SINGLES_HALF, SINGLES_HALF, SERVICE_FROM_NET);
  lineV(0, -SERVICE_FROM_NET, SERVICE_FROM_NET);
  // Nothing is painted under the net. The net is the only thing on that line.
  lineV(0, BASELINE_HALF, BASELINE_HALF - CENTRE_MARK, LINE);
  lineV(0, -BASELINE_HALF, -BASELINE_HALF + CENTRE_MARK, LINE);
  g.restore();

  const vignette = g.createRadialGradient(cx, cy, TEXTURE_W * 0.18, cx, cy, TEXTURE_H * 0.58);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(0.5, 'rgba(0,0,0,0.08)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.94)');
  g.fillStyle = vignette;
  g.fillRect(0, 0, TEXTURE_W, TEXTURE_H);

  const far = g.createLinearGradient(0, 0, 0, TEXTURE_H);
  far.addColorStop(0, 'rgba(0,0,0,0.82)');
  far.addColorStop(0.28, 'rgba(0,0,0,0.06)');
  far.addColorStop(0.78, 'rgba(0,0,0,0.03)');
  far.addColorStop(1, 'rgba(0,0,0,0.68)');
  g.fillStyle = far;
  g.fillRect(0, 0, TEXTURE_W, TEXTURE_H);

  g.save();
  g.globalCompositeOperation = 'destination-in';
  const alphaRadial = g.createRadialGradient(cx, cy, TEXTURE_W * 0.14, cx, cy, TEXTURE_H * 0.57);
  alphaRadial.addColorStop(0, 'rgba(0,0,0,0.94)');
  alphaRadial.addColorStop(0.5, 'rgba(0,0,0,0.86)');
  alphaRadial.addColorStop(0.8, 'rgba(0,0,0,0.34)');
  alphaRadial.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = alphaRadial;
  g.fillRect(0, 0, TEXTURE_W, TEXTURE_H);
  const alphaDepth = g.createLinearGradient(0, 0, 0, TEXTURE_H);
  alphaDepth.addColorStop(0, 'rgba(0,0,0,0)');
  alphaDepth.addColorStop(0.2, 'rgba(0,0,0,0.9)');
  alphaDepth.addColorStop(0.78, 'rgba(0,0,0,0.9)');
  alphaDepth.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = alphaDepth;
  g.fillRect(0, 0, TEXTURE_W, TEXTURE_H);
  g.restore();

  const bump = buildUtilityMap(key, 'bump');
  const roughness = buildUtilityMap(key, 'roughness');
  const color = new THREE.CanvasTexture(c);
  color.colorSpace = THREE.SRGBColorSpace;
  color.anisotropy = 8;
  color.needsUpdate = true;
  return { color, bump, roughness };
}

function buildUtilityMap(key: string, kind: 'bump' | 'roughness'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = MAP_W;
  c.height = MAP_H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(MAP_W, MAP_H);
  const r = rand((kind === 'bump' ? 45017 : 71693) + key.length * 97);
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const u = x / MAP_W;
      const v = y / MAP_H;
      const slow = Math.sin(u * 24 + Math.sin(v * 7) * 1.7) * 0.5 + Math.sin(v * 19 + u * 4.5) * 0.5;
      const fine = r() - 0.5;
      let value = 128;
      if (key === 'roland-garros') value = kind === 'bump' ? 128 + slow * 18 + fine * 74 : 225 + slow * 8 + fine * 20;
      else if (key === 'wimbledon') value = kind === 'bump' ? 122 + slow * 10 + fine * 34 : 206 + slow * 8 + fine * 16;
      else value = kind === 'bump' ? 126 + slow * 5 + fine * 24 : 188 + slow * 12 + fine * 20;
      const i = (y * MAP_W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, value));
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function netTop(x: number): number {
  const u = Math.min(1, Math.abs(x) / NET_POST_HALF);
  const k = 1.55;
  const c = (Math.cosh(k * u) - 1) / (Math.cosh(k) - 1);
  return NET_CENTRE_H + (NET_POST_H - NET_CENTRE_H) * c;
}

function makeSagStrip(topOffset: number, bottomOffset: number, zOffset: number): THREE.BufferGeometry {
  const segs = 64;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const x = -NET_POST_HALF + t * NET_POST_HALF * 2;
    const top = netTop(x) + topOffset;
    const bottom = netTop(x) + bottomOffset;
    pos.push(x, top, zOffset, x, bottom, zOffset);
    uv.push(t, 1, t, 0);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * The mesh hangs from the sagging cord but its bottom tape rests along the
 * court, so the top follows the catenary while the bottom stays near flat —
 * the fabric is tallest at the posts and shortest at the pulled-down centre.
 */
function makeNetMeshStrip(topOffset: number, bottomY: number): THREE.BufferGeometry {
  const segs = 96;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const x = -NET_POST_HALF + t * NET_POST_HALF * 2;
    const top = netTop(x) + topOffset;
    // A slight settle in the bottom tape toward the centre reads as slack.
    const bottom = bottomY + (1 - Math.min(1, Math.abs(x) / NET_POST_HALF)) * -0.004;
    pos.push(x, top, 0, x, bottom, 0);
    // v runs 0 at the bottom tape to 1 just under the headband; the fabric
    // height changes across x, so squares stretch a touch near the posts.
    uv.push(t, 1, t, 0);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function makeCordGeometry(offset: number, radius: number): THREE.TubeGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const x = -NET_POST_HALF + t * NET_POST_HALF * 2;
    pts.push(new THREE.Vector3(x, netTop(x) + offset, -0.018));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 96, radius, 8, false);
}

/**
 * A woven net: square openings of ~4.5cm knotted from pale cord with real
 * thickness. The tile repeats horizontally; vertically it spans the whole
 * fabric so the weave can thicken and darken toward the bottom tape. Returns a
 * colour+alpha canvas and a matching normal map so the raking key catches the
 * round of each cord.
 */
function buildNetMeshTextures(): { color: THREE.CanvasTexture; normal: THREE.CanvasTexture } {
  const W = 256;
  const H = 1024;
  const cols = 6; // openings per horizontal tile
  const rows = 26; // openings over the full fabric height
  const cw = W / cols;
  const rh = H / rows;
  const cord = 3.7; // cord half-thickness in px

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const r = rand(80231);

  // Height field of the cord, used for both alpha and the normal map.
  const hf = new Float32Array(W * H);
  const put = (x: number, y: number, v: number) => {
    const xi = ((x % W) + W) % W;
    const yi = Math.max(0, Math.min(H - 1, y));
    const i = (yi | 0) * W + (xi | 0);
    if (v > hf[i]!) hf[i] = v;
  };
  const stamp = (cx: number, cy: number, half: number) => {
    const h0 = Math.ceil(half + 1);
    for (let dy = -h0; dy <= h0; dy++) {
      for (let dx = -h0; dx <= h0; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > half + 0.75) continue;
        // Rounded cross-section: full at centre, feathered at the edge.
        const v = Math.max(0, 1 - (d / (half + 0.75)) ** 1.6);
        put(cx + dx, cy + dy, v);
      }
    }
  };

  // Vertical cords.
  for (let cx = 0; cx <= cols; cx++) {
    const bx = cx * cw;
    for (let y = 0; y < H; y++) {
      const jitter = Math.sin(y * 0.09 + cx) * 0.6 + (r() - 0.5) * 0.5;
      stamp(bx + jitter, y, cord);
    }
  }
  // Horizontal cords.
  for (let ry = 0; ry <= rows; ry++) {
    const by = ry * rh;
    for (let x = 0; x < W; x++) {
      const jitter = Math.sin(x * 0.11 + ry) * 0.6 + (r() - 0.5) * 0.5;
      stamp(x, by + jitter, cord);
    }
  }
  // Knots where cords cross.
  for (let cx = 0; cx <= cols; cx++) {
    for (let ry = 0; ry <= rows; ry++) {
      stamp(cx * cw, ry * rh, cord + 1.9);
    }
  }

  // Bottom tape/hem: a solid darker band the fabric ends into.
  const hemTop = H - rh * 0.9;
  for (let y = Math.floor(hemTop); y < H; y++) {
    for (let x = 0; x < W; x++) hf[y * W + x] = 1;
  }

  // Paint colour + alpha from the height field, densifying toward the bottom.
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const v = y / H; // 0 top → 1 bottom
    const dens = 0.72 + v * 0.28; // lower mesh reads denser
    const shade = 1 - v * 0.32; // and a touch darker near the ground
    const inHem = y >= hemTop;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const h = hf[i]!;
      const o = i * 4;
      const lum = inHem ? 150 : Math.round(224 * shade);
      img.data[o] = lum;
      img.data[o + 1] = lum + 4;
      img.data[o + 2] = lum;
      img.data[o + 3] = Math.round(Math.min(1, h * (inHem ? 1 : 1.2)) * 255 * (inHem ? 1 : dens));
    }
  }
  g.putImageData(img, 0, 0);

  const color = new THREE.CanvasTexture(c);
  color.colorSpace = THREE.SRGBColorSpace;
  color.anisotropy = 8;
  color.wrapS = THREE.RepeatWrapping;
  color.wrapT = THREE.ClampToEdgeWrapping;
  color.needsUpdate = true;

  // Normal map from the height gradient — cords become rounded ridges.
  const nc = document.createElement('canvas');
  nc.width = W;
  nc.height = H;
  const ng = nc.getContext('2d')!;
  const nimg = ng.createImageData(W, H);
  const at = (x: number, y: number) => hf[((y + H) % H) * W + ((x + W) % W)]!;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dzdx = (at(x + 1, y) - at(x - 1, y)) * 2.2;
      const dzdy = (at(x, y + 1) - at(x, y - 1)) * 2.2;
      let nx = -dzdx;
      let ny = -dzdy;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      const o = (y * W + x) * 4;
      nimg.data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      nimg.data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      nimg.data[o + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      nimg.data[o + 3] = 255;
    }
  }
  ng.putImageData(nimg, 0, 0);
  const normal = new THREE.CanvasTexture(nc);
  normal.colorSpace = THREE.NoColorSpace;
  normal.anisotropy = 8;
  normal.wrapS = THREE.RepeatWrapping;
  normal.wrapT = THREE.ClampToEdgeWrapping;
  normal.needsUpdate = true;

  return { color, normal };
}

/** White canvas headband texture: doubled tape with a soft top fold shadow. */
function buildBandTexture(): THREE.CanvasTexture {
  const W = 512;
  const H = 32;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const r = rand(4451);
  g.fillStyle = '#eef1ec';
  g.fillRect(0, 0, W, H);
  // The fold: brighter along the top lip, a soft core shadow under it.
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.28, 'rgba(255,255,255,0)');
  grd.addColorStop(0.52, 'rgba(0,0,0,0.14)');
  grd.addColorStop(0.62, 'rgba(0,0,0,0)');
  grd.addColorStop(1, 'rgba(0,0,0,0.10)');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  // Faint weave along the length so it isn't a dead flat white.
  g.globalAlpha = 0.05;
  for (let i = 0; i < 700; i++) {
    g.fillStyle = r() > 0.5 ? '#ffffff' : '#000000';
    g.fillRect(r() * W, r() * H, 1, 1);
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(48, 1);
  tex.needsUpdate = true;
  return tex;
}

function createNet(theme: SlamTheme): { group: THREE.Group; dispose: () => void; setTheme: (theme: SlamTheme) => void } {
  const group = new THREE.Group();
  const disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const openingsAcross = Math.round((NET_POST_HALF * 2) / NET_OPENING);
  const meshRepeatX = Math.max(1, Math.round(openingsAcross / 6));

  const { color: meshColor, normal: meshNormal } = buildNetMeshTextures();
  track(meshColor);
  track(meshNormal);
  meshColor.repeat.set(meshRepeatX, 1);
  meshNormal.repeat.set(meshRepeatX, 1);

  const meshMat = track(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(theme.chalkDim).lerp(new THREE.Color('#ffffff'), 0.46),
    map: meshColor,
    alphaMap: meshColor,
    normalMap: meshNormal,
    normalScale: new THREE.Vector2(0.5, 0.5),
    transparent: true,
    opacity: 1,
    alphaTest: 0.14,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
    roughness: 0.8,
    metalness: 0,
    emissive: new THREE.Color(theme.chalkDim).multiplyScalar(0.16),
    emissiveIntensity: 0.42,
    fog: false,
  }));
  const netMesh = new THREE.Mesh(track(makeNetMeshStrip(-NET_BAND_H, NET_MESH_GAP)), meshMat);
  netMesh.renderOrder = -3;
  group.add(netMesh);

  const bandTexture = track(buildBandTexture());
  const bandMat = track(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(theme.chalk).lerp(new THREE.Color('#ffffff'), 0.2),
    map: bandTexture,
    transparent: true,
    opacity: 0.98,
    roughness: 0.7,
    metalness: 0,
    emissive: new THREE.Color(theme.chalk).multiplyScalar(0.1),
    emissiveIntensity: 0.28,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  }));
  // The band is a shallow forward-tilted box so it reads as doubled canvas, not
  // a decal: a front face the camera sees and a thin top the light rides.
  const bandFront = new THREE.Mesh(track(makeSagStrip(0.006, -NET_BAND_H, 0.02)), bandMat);
  bandFront.renderOrder = -1;
  group.add(bandFront);
  const bandBack = new THREE.Mesh(track(makeSagStrip(0.006, -NET_BAND_H, -0.02)), bandMat);
  bandBack.renderOrder = -1;
  group.add(bandBack);
  const bandTop = new THREE.Mesh(track(makeCordGeometry(0.006, 0.02)), bandMat);
  bandTop.renderOrder = -1;
  group.add(bandTop);

  // The steel cable the net hangs from, peeking along the very top of the band.
  const cordMat = track(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(theme.chalk).lerp(new THREE.Color(theme.groundDeep), 0.5),
    roughness: 0.35,
    metalness: 0.8,
    emissive: new THREE.Color(theme.chalk).multiplyScalar(0.06),
    emissiveIntensity: 0.2,
    fog: false,
  }));
  const topCord = new THREE.Mesh(track(makeCordGeometry(0.028, 0.006)), cordMat);
  topCord.renderOrder = 0;
  group.add(topCord);

  // Square metal posts, 1.07m, set 0.914m outside the doubles line.
  const postMat = track(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(theme.groundDeep).lerp(new THREE.Color(theme.chalk), 0.34),
    roughness: 0.34,
    metalness: 0.72,
    envMapIntensity: 0.6,
    emissive: new THREE.Color(theme.groundDeep).multiplyScalar(0.4),
    emissiveIntensity: 0.4,
    fog: false,
  }));
  const postGeo = track(new THREE.BoxGeometry(0.1, NET_POST_H, 0.1));
  const capGeo = track(new THREE.BoxGeometry(0.13, 0.05, 0.13));
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(side * NET_POST_HALF, NET_POST_H / 2, 0);
    group.add(post);
    const cap = new THREE.Mesh(capGeo, postMat);
    cap.position.set(side * NET_POST_HALF, NET_POST_H + 0.02, 0);
    group.add(cap);
  }

  // The centre strap: a white band pulling the middle down to 0.914m. One of
  // the most recognisable details on a real court.
  const strapMat = track(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(theme.chalk).lerp(new THREE.Color('#ffffff'), 0.28),
    transparent: true,
    opacity: 0.98,
    roughness: 0.78,
    metalness: 0,
    emissive: new THREE.Color(theme.chalk).multiplyScalar(0.12),
    emissiveIntensity: 0.32,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  }));
  const strapH = NET_CENTRE_H + 0.03;
  const strapGeo = track(new THREE.PlaneGeometry(NET_STRAP_W, strapH));
  for (const z of [0.026, -0.026]) {
    const strap = new THREE.Mesh(strapGeo, strapMat);
    strap.position.set(0, strapH / 2, z);
    strap.renderOrder = 1;
    group.add(strap);
  }

  function setTheme(next: SlamTheme): void {
    meshMat.color.copy(new THREE.Color(next.chalkDim).lerp(new THREE.Color('#ffffff'), 0.46));
    meshMat.emissive.copy(new THREE.Color(next.chalkDim).multiplyScalar(0.16));
    bandMat.color.copy(new THREE.Color(next.chalk).lerp(new THREE.Color('#ffffff'), 0.2));
    bandMat.emissive.copy(new THREE.Color(next.chalk).multiplyScalar(0.1));
    cordMat.color.copy(new THREE.Color(next.chalk).lerp(new THREE.Color(next.groundDeep), 0.5));
    cordMat.emissive.copy(new THREE.Color(next.chalk).multiplyScalar(0.06));
    postMat.color.copy(new THREE.Color(next.groundDeep).lerp(new THREE.Color(next.chalk), 0.34));
    postMat.emissive.copy(new THREE.Color(next.groundDeep).multiplyScalar(0.4));
    strapMat.color.copy(new THREE.Color(next.chalk).lerp(new THREE.Color('#ffffff'), 0.28));
    strapMat.emissive.copy(new THREE.Color(next.chalk).multiplyScalar(0.12));
  }

  return { group, setTheme, dispose: () => disposables.forEach((d) => d.dispose()) };
}

export function createCourt(scene: THREE.Scene, renderer: THREE.WebGLRenderer): Court {
  const group = new THREE.Group();
  group.name = 'court';
  scene.add(group);

  const geo = new THREE.PlaneGeometry(PLANE_W_M, PLANE_L_M, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0,
    transparent: true,
    opacity: 0.84,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    envMapIntensity: 0.12,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'court-atmosphere';
  mesh.position.set(0, FLOOR_Y + 0.025, COURT_Z);
  mesh.scale.setScalar(SCALE);
  mesh.renderOrder = -5;
  group.add(mesh);

  const net = createNet({
    id: 'wimbledon-men',
    ground: '#154430',
    groundDeep: '#061c12',
    chalk: '#f3f5ea',
    chalkDim: '#89a893',
    flare: '#d8c56a',
    flareGlow: '#bfa53f',
    trace: '#bda6d6',
    surface: 'Grass',
    label: 'Wimbledon',
    city: 'London',
    heritage: '#5a2a82',
    rim: '#6d3a9a',
    fog: '#08130d',
  });
  net.group.position.set(0, FLOOR_Y + 0.045, COURT_Z);
  net.group.scale.setScalar(SCALE);
  group.add(net.group);

  const textures = new Map<string, SurfaceTextures>();

  function surfaceFor(key: string, theme: SlamTheme): SurfaceTextures {
    let tex = textures.get(key);
    if (!tex) {
      tex = buildSurfaceTextures(key, theme);
      const aniso = renderer.capabilities.getMaxAnisotropy();
      for (const t of [tex.color, tex.bump, tex.roughness]) t.anisotropy = aniso;
      textures.set(key, tex);
    }
    return tex;
  }

  function setSlam(slam: SlamId, theme: SlamTheme): void {
    const key = surfaceKey(slam);
    const palette = PALETTES[key] ?? PALETTES.wimbledon!;
    const tex = surfaceFor(key, theme);
    mat.map = tex.color;
    mat.bumpMap = tex.bump;
    mat.roughnessMap = tex.roughness;
    mat.bumpScale = palette.bump;
    mat.roughness = palette.roughness;
    mat.color.set(theme.chalk).lerp(new THREE.Color(theme.groundDeep), 0.08);
    mat.emissive = new THREE.Color(theme.groundDeep).multiplyScalar(0.08);
    mat.needsUpdate = true;
    net.setTheme(theme);
  }

  return {
    group,
    setSlam,
    warm: (slam, theme) => {
      surfaceFor(surfaceKey(slam), theme);
    },
    dispose: () => {
      textures.forEach((t) => {
        t.color.dispose();
        t.bump.dispose();
        t.roughness.dispose();
      });
      net.dispose();
      geo.dispose();
      mat.dispose();
      group.removeFromParent();
    },
  };
}
