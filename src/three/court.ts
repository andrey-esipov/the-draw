import * as THREE from 'three';
import type { SlamId } from '../data/types';
import type { SlamTheme } from '../ui/theme';

export interface Court {
  group: THREE.Group;
  setSlam: (slam: SlamId, theme: SlamTheme) => void;
  dispose: () => void;
}

const COURT_MARKER = 'THE_DRAW_COURT_REAL_SURFACES_NET_V3';
void COURT_MARKER;

const FLOOR_Y = -14.4;
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
const NET_BAND_H = 0.12;

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

function makeCordGeometry(offset: number, radius: number): THREE.TubeGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const x = -NET_POST_HALF + t * NET_POST_HALF * 2;
    pts.push(new THREE.Vector3(x, netTop(x) + offset, -0.018));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 96, radius, 8, false);
}

function buildNetMeshTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(235,241,238,0.42)';
  g.lineWidth = 1.1;
  for (let x = 0; x < c.width; x += 20) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 28, c.height);
    g.stroke();
    g.beginPath();
    g.moveTo(x + 28, 0);
    g.lineTo(x, c.height);
    g.stroke();
  }
  g.strokeStyle = 'rgba(235,241,238,0.22)';
  g.lineWidth = 1;
  for (let y = 8; y < c.height; y += 22) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(c.width, y + Math.sin(y * 0.05) * 1.4);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(1, 1);
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

  const meshTexture = track(buildNetMeshTexture());
  const meshMat = track(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(theme.chalkDim).lerp(new THREE.Color('#ffffff'), 0.16),
    map: meshTexture,
    alphaMap: meshTexture,
    transparent: true,
    opacity: 0.42,
    alphaTest: 0.06,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
    roughness: 0.82,
    metalness: 0,
    emissive: new THREE.Color(theme.chalkDim).multiplyScalar(0.18),
    emissiveIntensity: 0.34,
    fog: false,
  }));
  const netMesh = new THREE.Mesh(track(makeSagStrip(-NET_BAND_H, -NET_CENTRE_H + 0.07, 0)), meshMat);
  netMesh.renderOrder = -2;
  group.add(netMesh);

  const bandMat = track(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(theme.chalk).lerp(new THREE.Color(theme.groundDeep), 0.55),
    transparent: true,
    opacity: 0.68,
    roughness: 0.76,
    metalness: 0,
    emissive: new THREE.Color(theme.chalk).multiplyScalar(0.16),
    emissiveIntensity: 0.38,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  }));
  const band = new THREE.Mesh(track(makeSagStrip(0.012, -NET_BAND_H, -0.006)), bandMat);
  band.renderOrder = -1;
  group.add(band);

  const cordMat = track(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(theme.chalk).lerp(new THREE.Color(theme.groundDeep), 0.42),
    transparent: true,
    opacity: 0.72,
    roughness: 0.62,
    metalness: 0,
    depthWrite: false,
    depthTest: false,
    emissive: new THREE.Color(theme.chalk).multiplyScalar(0.18),
    emissiveIntensity: 0.42,
    fog: false,
  }));
  const topCord = new THREE.Mesh(track(makeCordGeometry(0.02, 0.012)), cordMat);
  topCord.renderOrder = 0;
  group.add(topCord);

  const postMat = track(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(theme.groundDeep).lerp(new THREE.Color(theme.chalk), 0.22),
    roughness: 0.45,
    metalness: 0.55,
    transparent: true,
    opacity: 0.58,
    fog: false,
  }));
  const postGeo = track(new THREE.CylinderGeometry(0.045, 0.052, NET_POST_H + 0.08, 12, 1));
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(side * NET_POST_HALF, (NET_POST_H + 0.08) / 2 - 0.02, 0);
    group.add(post);
  }

  const strapMat = track(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(theme.chalk).lerp(new THREE.Color(theme.groundDeep), 0.68),
    transparent: true,
    opacity: 0.64,
    roughness: 0.82,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  }));
  const strapGeo = track(new THREE.PlaneGeometry(0.065, NET_CENTRE_H - 0.04));
  const strap = new THREE.Mesh(strapGeo, strapMat);
  strap.position.set(0, (NET_CENTRE_H - 0.04) / 2 + 0.035, -0.012);
  group.add(strap);

  function setTheme(next: SlamTheme): void {
    meshMat.color.copy(new THREE.Color(next.chalkDim).lerp(new THREE.Color('#ffffff'), 0.16));
    meshMat.emissive.copy(new THREE.Color(next.chalkDim).multiplyScalar(0.18));
    bandMat.color.copy(new THREE.Color(next.chalk).lerp(new THREE.Color(next.groundDeep), 0.55));
    bandMat.emissive.copy(new THREE.Color(next.chalk).multiplyScalar(0.16));
    cordMat.color.copy(new THREE.Color(next.chalk).lerp(new THREE.Color(next.groundDeep), 0.42));
    cordMat.emissive.copy(new THREE.Color(next.chalk).multiplyScalar(0.18));
    postMat.color.copy(new THREE.Color(next.groundDeep).lerp(new THREE.Color(next.chalk), 0.22));
    strapMat.color.copy(new THREE.Color(next.chalk).lerp(new THREE.Color(next.groundDeep), 0.68));
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
  mesh.position.set(0, FLOOR_Y + 0.025, -42);
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
  net.group.position.set(0, FLOOR_Y + 0.045, -42);
  net.group.scale.setScalar(SCALE);
  group.add(net.group);

  const textures = new Map<string, SurfaceTextures>();

  function setSlam(slam: SlamId, theme: SlamTheme): void {
    const key = surfaceKey(slam);
    const palette = PALETTES[key] ?? PALETTES.wimbledon!;
    let tex = textures.get(key);
    if (!tex) {
      tex = buildSurfaceTextures(key, theme);
      for (const t of [tex.color, tex.bump, tex.roughness]) t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      textures.set(key, tex);
    }
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
