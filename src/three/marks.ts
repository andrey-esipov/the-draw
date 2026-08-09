import * as THREE from 'three';
import type { SlamTheme } from '../ui/theme';

export interface MarkAtlas {
  texture: THREE.Texture;
  /** UV rect for a country code: [u0, v0, u1, v1]. */
  uv: (country: string) => [number, number, number, number];
  dispose: () => void;
}

type Rect = { x: number; y: number; w: number; h: number };
type Shape = 'disc' | 'diamond' | 'sun' | 'crescent' | 'ring';

type Flag =
  | { k: 'v'; c: string[] }
  | { k: 'h'; c: string[] }
  | { k: 'cross'; field: string; cross: string; inner?: string }
  | { k: 'saltire'; field: string; cross: string; inner?: string }
  | { k: 'canton'; base: Flag; block: string; blockAccent?: string }
  | { k: 'wedge'; field: string; wedge: string }
  | { k: 'triangle'; base: Flag; tri: string }
  | { k: 'union' }
  | { k: 'device'; base: Flag; shape: Shape; color: string; color2?: string; scale?: number };

const FALLBACK = '#5b636f';

const FLAGS: Record<string, Flag> = {
  FRA: { k: 'v', c: ['#0055a4', '#ffffff', '#ef4135'] },
  ITA: { k: 'v', c: ['#008c45', '#f4f5f0', '#cd212a'] },
  ROU: { k: 'v', c: ['#002b7f', '#fcd116', '#ce1126'] },
  BEL: { k: 'v', c: ['#000000', '#fae042', '#ed2939'] },
  PER: { k: 'v', c: ['#d91023', '#ffffff', '#d91023'] },
  AND: { k: 'device', base: { k: 'v', c: ['#10069f', '#fedf00', '#d0103a'] }, shape: 'ring', color: '#9a3b1b', scale: 0.42 },
  POR: { k: 'device', base: { k: 'v', c: ['#006600', '#006600', '#ff0000', '#ff0000', '#ff0000'] }, shape: 'ring', color: '#ffd700', scale: 0.5 },
  MEX: { k: 'device', base: { k: 'v', c: ['#006847', '#ffffff', '#ce1126'] }, shape: 'ring', color: '#7a5a2e', scale: 0.4 },
  CAN: { k: 'device', base: { k: 'v', c: ['#d52b1e', '#ffffff', '#ffffff', '#ffffff', '#d52b1e'] }, shape: 'diamond', color: '#d52b1e', scale: 0.5 },

  GER: { k: 'h', c: ['#000000', '#dd0000', '#ffce00'] },
  NED: { k: 'h', c: ['#ae1c28', '#ffffff', '#21468b'] },
  HUN: { k: 'h', c: ['#ce2939', '#ffffff', '#477050'] },
  BUL: { k: 'h', c: ['#ffffff', '#00966e', '#d62612'] },
  LTU: { k: 'h', c: ['#fdb913', '#006a44', '#c1272d'] },
  COL: { k: 'h', c: ['#fcd116', '#fcd116', '#003893', '#ce1126'] },
  BOL: { k: 'h', c: ['#d52b1e', '#f9e300', '#007934'] },
  EGY: { k: 'h', c: ['#ce1126', '#ffffff', '#000000'] },
  AUT: { k: 'h', c: ['#ed2939', '#ffffff', '#ed2939'] },
  LAT: { k: 'h', c: ['#9e3039', '#9e3039', '#ffffff', '#9e3039', '#9e3039'] },
  POL: { k: 'h', c: ['#ffffff', '#dc143c'] },
  INA: { k: 'h', c: ['#ce1126', '#ffffff'] },
  MON: { k: 'h', c: ['#ce1126', '#ffffff'] },
  PAR: { k: 'h', c: ['#d52b1e', '#ffffff', '#0038a8'] },
  UKR: { k: 'h', c: ['#0057b7', '#ffd700'] },
  UZB: { k: 'h', c: ['#0099b5', '#ffffff', '#1eb53a'] },
  SRB: { k: 'h', c: ['#c6363c', '#0c4076', '#ffffff'] },
  THA: { k: 'h', c: ['#a51931', '#f4f5f8', '#2d2a4a', '#2d2a4a', '#f4f5f8', '#a51931'] },
  ARG: { k: 'device', base: { k: 'h', c: ['#74acdf', '#ffffff', '#74acdf'] }, shape: 'sun', color: '#f6b40e', scale: 0.34 },
  CRO: { k: 'device', base: { k: 'h', c: ['#ff0000', '#ffffff', '#171796'] }, shape: 'diamond', color: '#ff0000', color2: '#ffffff', scale: 0.42 },
  SLO: { k: 'device', base: { k: 'h', c: ['#ffffff', '#005da4', '#ed1c24'] }, shape: 'ring', color: '#005da4', scale: 0.4 },
  SVK: { k: 'device', base: { k: 'h', c: ['#ffffff', '#0b4ea2', '#ee1c25'] }, shape: 'diamond', color: '#ee1c25', color2: '#ffffff', scale: 0.4 },

  DEN: { k: 'cross', field: '#c8102e', cross: '#ffffff' },
  NOR: { k: 'cross', field: '#ba0c2f', cross: '#ffffff', inner: '#00205b' },
  SWE: { k: 'cross', field: '#006aa7', cross: '#fecc00' },
  FIN: { k: 'cross', field: '#ffffff', cross: '#003580' },

  SUI: { k: 'device', base: { k: 'v', c: ['#da291c'] }, shape: 'ring', color: '#ffffff', scale: 0.0 },
  GEO: { k: 'saltire', field: '#ffffff', cross: '#ff0000' },
  GRE: { k: 'canton', base: { k: 'h', c: ['#0d5eaf', '#ffffff', '#0d5eaf', '#ffffff', '#0d5eaf'] }, block: '#0d5eaf', blockAccent: '#ffffff' },

  USA: { k: 'canton', base: { k: 'h', c: ['#b31942', '#ffffff', '#b31942', '#ffffff', '#b31942'] }, block: '#0a3161' },
  AUS: { k: 'canton', base: { k: 'v', c: ['#00247d'] }, block: '#ffffff', blockAccent: '#c8102e' },
  NZL: { k: 'canton', base: { k: 'v', c: ['#00247d'] }, block: '#ffffff', blockAccent: '#c8102e' },
  CHI: { k: 'canton', base: { k: 'h', c: ['#ffffff', '#da291c'] }, block: '#0032a0', blockAccent: '#ffffff' },
  CHN: { k: 'canton', base: { k: 'v', c: ['#ee1c25'] }, block: '#ee1c25', blockAccent: '#ffde00' },

  GBR: { k: 'union' },

  JPN: { k: 'device', base: { k: 'v', c: ['#ffffff'] }, shape: 'disc', color: '#bc002d', scale: 0.42 },
  KOR: { k: 'device', base: { k: 'v', c: ['#ffffff'] }, shape: 'crescent', color: '#cd2e3a', color2: '#0047a0', scale: 0.44 },
  TUR: { k: 'device', base: { k: 'v', c: ['#e30a17'] }, shape: 'crescent', color: '#ffffff', color2: '#ffffff', scale: 0.5 },
  HKG: { k: 'device', base: { k: 'v', c: ['#de2910'] }, shape: 'sun', color: '#ffffff', scale: 0.42 },
  MKD: { k: 'device', base: { k: 'v', c: ['#d20000'] }, shape: 'sun', color: '#ffe600', scale: 0.5 },
  MNE: { k: 'device', base: { k: 'v', c: ['#c40308'] }, shape: 'ring', color: '#d4af37', scale: 0.5 },
  KAZ: { k: 'device', base: { k: 'v', c: ['#00afca'] }, shape: 'sun', color: '#fec50c', scale: 0.46 },
  BRA: { k: 'device', base: { k: 'v', c: ['#009739'] }, shape: 'diamond', color: '#fedd00', color2: '#012169', scale: 0.62 },

  CZE: { k: 'triangle', base: { k: 'h', c: ['#ffffff', '#d7141a'] }, tri: '#11457e' },
  PHI: { k: 'triangle', base: { k: 'h', c: ['#0038a8', '#ce1126'] }, tri: '#ffffff' },
  BIH: { k: 'wedge', field: '#002395', wedge: '#fecb00' },

  ESP: { k: 'device', base: { k: 'h', c: ['#aa151b', '#f1bf00', '#f1bf00', '#aa151b'] }, shape: 'ring', color: '#aa151b', scale: 0.36 },
};

const CELL = 256;
const MARGIN = 16;
const PLATE = CELL - MARGIN * 2;
const FALLBACK_KEY = '\u0000fallback';

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
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

function bandsV(ctx: CanvasRenderingContext2D, rc: Rect, colors: string[]): void {
  const bw = rc.w / colors.length;
  colors.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(rc.x + i * bw, rc.y, Math.ceil(bw) + 1, rc.h);
  });
}

function bandsH(ctx: CanvasRenderingContext2D, rc: Rect, colors: string[]): void {
  const bh = rc.h / colors.length;
  colors.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(rc.x, rc.y + i * bh, rc.w, Math.ceil(bh) + 1);
  });
}

function nordicCross(ctx: CanvasRenderingContext2D, rc: Rect, field: string, cross: string, inner?: string): void {
  ctx.fillStyle = field;
  ctx.fillRect(rc.x, rc.y, rc.w, rc.h);
  const arm = rc.h * 0.2;
  const vx = rc.x + rc.w * 0.34 - arm / 2;
  const hy = rc.y + rc.h * 0.5 - arm / 2;
  ctx.fillStyle = cross;
  ctx.fillRect(vx, rc.y, arm, rc.h);
  ctx.fillRect(rc.x, hy, rc.w, arm);
  if (inner) {
    const iarm = arm * 0.42;
    const ivx = rc.x + rc.w * 0.34 - iarm / 2;
    const ihy = rc.y + rc.h * 0.5 - iarm / 2;
    ctx.fillStyle = inner;
    ctx.fillRect(ivx, rc.y, iarm, rc.h);
    ctx.fillRect(rc.x, ihy, rc.w, iarm);
  }
}

function saltire(ctx: CanvasRenderingContext2D, rc: Rect, field: string, cross: string): void {
  ctx.fillStyle = field;
  ctx.fillRect(rc.x, rc.y, rc.w, rc.h);
  const arm = rc.h * 0.2;
  ctx.fillStyle = cross;
  ctx.fillRect(rc.x, rc.y + rc.h * 0.5 - arm / 2, rc.w, arm);
  ctx.fillRect(rc.x + rc.w * 0.5 - arm / 2, rc.y, arm, rc.h);
}

function union(ctx: CanvasRenderingContext2D, rc: Rect): void {
  const navy = '#012169';
  const white = '#ffffff';
  const red = '#c8102e';
  ctx.fillStyle = navy;
  ctx.fillRect(rc.x, rc.y, rc.w, rc.h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(rc.x, rc.y, rc.w, rc.h);
  ctx.clip();
  const cx = rc.x + rc.w / 2;
  const cy = rc.y + rc.h / 2;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = white;
  ctx.lineWidth = rc.h * 0.22;
  ctx.beginPath();
  ctx.moveTo(rc.x, rc.y); ctx.lineTo(rc.x + rc.w, rc.y + rc.h);
  ctx.moveTo(rc.x + rc.w, rc.y); ctx.lineTo(rc.x, rc.y + rc.h);
  ctx.stroke();
  ctx.strokeStyle = red;
  ctx.lineWidth = rc.h * 0.1;
  ctx.beginPath();
  ctx.moveTo(rc.x, rc.y); ctx.lineTo(rc.x + rc.w, rc.y + rc.h);
  ctx.moveTo(rc.x + rc.w, rc.y); ctx.lineTo(rc.x, rc.y + rc.h);
  ctx.stroke();
  ctx.strokeStyle = white;
  ctx.lineWidth = rc.h * 0.34;
  ctx.beginPath();
  ctx.moveTo(cx, rc.y); ctx.lineTo(cx, rc.y + rc.h);
  ctx.moveTo(rc.x, cy); ctx.lineTo(rc.x + rc.w, cy);
  ctx.stroke();
  ctx.strokeStyle = red;
  ctx.lineWidth = rc.h * 0.2;
  ctx.beginPath();
  ctx.moveTo(cx, rc.y); ctx.lineTo(cx, rc.y + rc.h);
  ctx.moveTo(rc.x, cy); ctx.lineTo(rc.x + rc.w, cy);
  ctx.stroke();
  ctx.restore();
}

function device(ctx: CanvasRenderingContext2D, rc: Rect, shape: Shape, color: string, color2: string | undefined, scale: number): void {
  const cx = rc.x + rc.w / 2;
  const cy = rc.y + rc.h / 2;
  const r = rc.h * 0.5 * scale;
  if (scale <= 0) {
    const arm = rc.h * 0.22;
    const len = rc.h * 0.62;
    ctx.fillStyle = color;
    ctx.fillRect(cx - arm / 2, cy - len / 2, arm, len);
    ctx.fillRect(cx - len / 2, cy - arm / 2, len, arm);
    return;
  }
  if (shape === 'disc') {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  } else if (shape === 'ring') {
    ctx.strokeStyle = color;
    ctx.lineWidth = r * 0.4;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
    ctx.stroke();
  } else if (shape === 'diamond') {
    if (color2) {
      ctx.fillStyle = color;
      diamondPath(ctx, cx, cy, r * 1.16);
      ctx.fill();
      ctx.fillStyle = color2;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.52, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = color;
      diamondPath(ctx, cx, cy, r);
      ctx.fill();
    }
  } else if (shape === 'sun') {
    ctx.fillStyle = color;
    const rays = 12;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a - 0.13) * r, cy + Math.sin(a - 0.13) * r);
      ctx.lineTo(cx + Math.cos(a + 0.13) * r, cy + Math.sin(a + 0.13) * r);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
  } else if (shape === 'crescent') {
    if (color2 && color === '#ffffff') {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx - r * 0.1, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,1)';
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(cx + r * 0.2, cy, r * 0.82, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, r, Math.PI * 0.5, Math.PI * 1.5);
      ctx.fill();
      if (color2) {
        ctx.fillStyle = color2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, Math.PI * 1.5, Math.PI * 0.5);
        ctx.fill();
      }
    }
  }
}

function diamondPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
}

function drawFlag(ctx: CanvasRenderingContext2D, rc: Rect, flag: Flag): void {
  switch (flag.k) {
    case 'v':
      bandsV(ctx, rc, flag.c);
      break;
    case 'h':
      bandsH(ctx, rc, flag.c);
      break;
    case 'cross':
      nordicCross(ctx, rc, flag.field, flag.cross, flag.inner);
      break;
    case 'saltire':
      saltire(ctx, rc, flag.field, flag.cross);
      break;
    case 'union':
      union(ctx, rc);
      break;
    case 'wedge': {
      ctx.fillStyle = flag.field;
      ctx.fillRect(rc.x, rc.y, rc.w, rc.h);
      ctx.fillStyle = flag.wedge;
      ctx.beginPath();
      ctx.moveTo(rc.x + rc.w * 0.28, rc.y);
      ctx.lineTo(rc.x + rc.w * 0.78, rc.y);
      ctx.lineTo(rc.x + rc.w * 0.28, rc.y + rc.h);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'canton': {
      drawFlag(ctx, rc, flag.base);
      const bw = rc.w * 0.44;
      const bh = rc.h * 0.5;
      ctx.fillStyle = flag.block;
      ctx.fillRect(rc.x, rc.y, bw, bh);
      if (flag.blockAccent) {
        if (flag.block === '#ee1c25') {
          device(ctx, { x: rc.x, y: rc.y, w: bw, h: bh }, 'sun', flag.blockAccent, undefined, 0.5);
        } else {
          const arm = bh * 0.26;
          ctx.fillStyle = flag.blockAccent;
          ctx.fillRect(rc.x + bw * 0.5 - arm / 2, rc.y, arm, bh);
          ctx.fillRect(rc.x, rc.y + bh * 0.5 - arm / 2, bw, arm);
        }
      }
      break;
    }
    case 'triangle': {
      drawFlag(ctx, rc, flag.base);
      ctx.fillStyle = flag.tri;
      ctx.beginPath();
      ctx.moveTo(rc.x, rc.y);
      ctx.lineTo(rc.x + rc.w * 0.56, rc.y + rc.h * 0.5);
      ctx.lineTo(rc.x, rc.y + rc.h);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'device':
      drawFlag(ctx, rc, flag.base);
      device(ctx, rc, flag.shape, flag.color, flag.color2, flag.scale ?? 0.44);
      break;
  }
}

function drawCell(ctx: CanvasRenderingContext2D, ox: number, oy: number, flag: Flag | null, theme: SlamTheme): void {
  const x = ox + MARGIN;
  const y = oy + MARGIN;
  const radius = PLATE * 0.15;

  roundRect(ctx, x, y, PLATE, PLATE, radius);
  ctx.save();
  ctx.clip();

  if (flag) {
    drawFlag(ctx, { x, y, w: PLATE, h: PLATE }, flag);
  } else {
    ctx.fillStyle = FALLBACK;
    ctx.fillRect(x, y, PLATE, PLATE);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.arc(x + PLATE / 2, y + PLATE / 2, PLATE * 0.07, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = withAlpha(theme.groundDeep, 0.16);
  ctx.fillRect(x, y, PLATE, PLATE);

  ctx.restore();

  roundRect(ctx, x + 1.5, y + 1.5, PLATE - 3, PLATE - 3, radius * 0.92);
  ctx.strokeStyle = 'rgba(12,16,22,0.55)';
  ctx.lineWidth = PLATE * 0.02;
  ctx.stroke();

  roundRect(ctx, x + 3, y + 3, PLATE - 6, PLATE - 6, radius * 0.86);
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = PLATE * 0.012;
  ctx.stroke();
}

function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function buildMarkAtlas(countries: string[], theme: SlamTheme): MarkAtlas {
  const codes = [...new Set(countries.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  const total = codes.length + 1;
  const cols = Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / cols);
  const width = nextPow2(cols * CELL);
  const height = nextPow2(rows * CELL);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, width, height);

  const rects = new Map<string, [number, number, number, number]>();
  const place = (i: number): [number, number] => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return [col * CELL, row * CELL];
  };

  const rectFor = (ox: number, oy: number): [number, number, number, number] => {
    const px = ox + MARGIN;
    const py = oy + MARGIN;
    const u0 = px / width;
    const u1 = (px + PLATE) / width;
    const v1 = 1 - py / height;
    const v0 = 1 - (py + PLATE) / height;
    return [u0, v0, u1, v1];
  };

  codes.forEach((code, i) => {
    const [ox, oy] = place(i);
    drawCell(ctx, ox, oy, FLAGS[code] ?? null, theme);
    rects.set(code, rectFor(ox, oy));
  });

  const [fx, fy] = place(codes.length);
  drawCell(ctx, fx, fy, null, theme);
  rects.set(FALLBACK_KEY, rectFor(fx, fy));

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  return {
    texture,
    uv: (country) => rects.get(country?.trim().toUpperCase() ?? '') ?? rects.get(FALLBACK_KEY)!,
    dispose: () => texture.dispose(),
  };
}
