// Bakes a power-of-two flag sprite atlas from the MIT-licensed `flag-icons`
// 4x3 SVGs (https://github.com/lipis/flag-icons, MIT). Renders every country
// code that appears in public/draws/*.json plus a neutral fallback chip, packs
// them into a 1024x1024 PNG committed at public/flags/atlas.png, and emits the
// cell lookup table at src/three/flag-atlas.data.ts.
//
// Re-run after the draw data or country set changes:
//   npm i -D flag-icons
//   node tools/build-flags.mjs
//
// Uses Playwright (already a dependency) to rasterise the SVGs in a real
// browser canvas, so gradients/paths match how the flags actually look.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// IOC (3-letter) -> ISO 3166-1 alpha-2, matching src/three/matchcard.ts.
const IOC_TO_ISO2 = {
  AND: 'AD', ARG: 'AR', AUS: 'AU', AUT: 'AT', BEL: 'BE', BIH: 'BA', BOL: 'BO', BRA: 'BR',
  BUL: 'BG', CAN: 'CA', CHI: 'CL', CHN: 'CN', COL: 'CO', CRO: 'HR', CZE: 'CZ', DEN: 'DK',
  EGY: 'EG', ESP: 'ES', FIN: 'FI', FRA: 'FR', GBR: 'GB', GEO: 'GE', GER: 'DE', GRE: 'GR',
  HKG: 'HK', HUN: 'HU', INA: 'ID', ITA: 'IT', JPN: 'JP', KAZ: 'KZ', KOR: 'KR', LAT: 'LV',
  LTU: 'LT', MEX: 'MX', MKD: 'MK', MNE: 'ME', MON: 'MC', NED: 'NL', NOR: 'NO', NZL: 'NZ',
  PAR: 'PY', PER: 'PE', PHI: 'PH', POL: 'PL', POR: 'PT', ROU: 'RO', SRB: 'RS', SLO: 'SI',
  SUI: 'CH', SVK: 'SK', SWE: 'SE', THA: 'TH', TUR: 'TR', UKR: 'UA', USA: 'US', UZB: 'UZ',
};

function countryCodes() {
  const dir = join(root, 'public/draws');
  const set = new Set();
  const walk = (o) => {
    if (o && typeof o === 'object') {
      if (typeof o.country === 'string' && o.country) set.add(o.country.trim().toUpperCase());
      for (const k of Object.keys(o)) walk(o[k]);
    }
  };
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.json')) walk(JSON.parse(readFileSync(join(dir, f), 'utf8')));
  }
  return [...set].sort();
}

function svgDataUri(iso2) {
  const path = join(root, 'node_modules/flag-icons/flags/4x3', `${iso2.toLowerCase()}.svg`);
  const svg = readFileSync(path, 'utf8');
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const CELL_W = 96;
const CELL_H = 72;
const GUTTER = 4;
const ATLAS = 1024;
const FALLBACK = '__fallback';

async function main() {
  const codes = countryCodes();
  const missing = codes.filter((c) => !IOC_TO_ISO2[c] || !safe(() => svgDataUri(IOC_TO_ISO2[c])));
  if (missing.length) {
    console.error('No flag for IOC codes:', missing.join(', '));
    process.exit(1);
  }

  const order = [...codes, FALLBACK];
  const cols = Math.floor((ATLAS + GUTTER) / (CELL_W + GUTTER));
  const cells = {};
  const drawList = [];
  order.forEach((code, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = GUTTER + col * (CELL_W + GUTTER);
    const y = GUTTER + row * (CELL_H + GUTTER);
    cells[code] = [x, y, CELL_W, CELL_H];
    drawList.push({ code, x, y, uri: code === FALLBACK ? null : svgDataUri(IOC_TO_ISO2[code]) });
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const dataUrl = await page.evaluate(async ({ drawList, CELL_W, CELL_H, ATLAS }) => {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS;
    canvas.height = ATLAS;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, ATLAS, ATLAS);

    const radius = CELL_H * 0.16;
    const roundRect = (x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };
    const load = (uri) =>
      new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = uri;
      });

    for (const d of drawList) {
      ctx.save();
      roundRect(d.x, d.y, CELL_W, CELL_H, radius);
      ctx.clip();
      if (d.uri) {
        const img = await load(d.uri);
        // cover-fit the 4:3 flag into the 4:3 cell (edge to edge).
        ctx.drawImage(img, d.x, d.y, CELL_W, CELL_H);
        // subtle darkening so the flag sits on a dark plate without glare.
        ctx.fillStyle = 'rgba(8,12,18,0.10)';
        ctx.fillRect(d.x, d.y, CELL_W, CELL_H);
      } else {
        ctx.fillStyle = '#5b636f';
        ctx.fillRect(d.x, d.y, CELL_W, CELL_H);
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.beginPath();
        ctx.arc(d.x + CELL_W / 2, d.y + CELL_H / 2, CELL_H * 0.14, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      roundRect(d.x + 1, d.y + 1, CELL_W - 2, CELL_H - 2, radius * 0.94);
      ctx.strokeStyle = 'rgba(12,16,22,0.55)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      roundRect(d.x + 2.2, d.y + 2.2, CELL_W - 4.4, CELL_H - 4.4, radius * 0.86);
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    return canvas.toDataURL('image/png');
  }, { drawList, CELL_W, CELL_H, ATLAS });
  await browser.close();

  const png = Buffer.from(dataUrl.split(',')[1], 'base64');
  writeFileSync(join(root, 'public/flags/atlas.png'), png);

  const data = {
    src: '/flags/atlas.png',
    width: ATLAS,
    height: ATLAS,
    fallback: FALLBACK,
    cells,
  };
  const banner = '// Generated by tools/build-flags.mjs. Do not edit by hand.\n';
  const body =
    `export const FLAG_ATLAS = ${JSON.stringify(data, null, 2)} as const;\n\n` +
    'export type FlagCode = keyof typeof FLAG_ATLAS.cells;\n';
  writeFileSync(join(root, 'src/three/flag-atlas.data.ts'), banner + body);

  console.log(`atlas: ${(png.length / 1024).toFixed(1)} KB, ${codes.length} flags + fallback`);
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

main();
