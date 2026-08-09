// Offline measurement harness. Renders every sound through an OfflineAudioContext and
// reports peak, RMS, effective duration and a rough spectral centroid, plus a composite
// waveform of the "run the draw" build-and-resolve for visual envelope inspection.
// Not shipped — served by Vite only for verification.

import { Engine, type SlamKey } from './engine';

const SR = 44100;

interface Metrics {
  name: string;
  peak: number;
  rms: number;
  durSec: number;   // effective ring-out (last sample above -66 dBFS)
  centroid: number; // Hz
  clips: boolean;
}

function analyse(name: string, buf: AudioBuffer): Metrics {
  const n = buf.length;
  const chs = buf.numberOfChannels;
  const mono = new Float32Array(n);
  for (let c = 0; c < chs; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i]! / chs;
  }
  let peak = 0, sq = 0, lastLoud = 0;
  const floor = Math.pow(10, -66 / 20);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(mono[i]!);
    if (a > peak) peak = a;
    sq += mono[i]! * mono[i]!;
    if (a > floor) lastLoud = i;
  }
  const rms = Math.sqrt(sq / n);
  const durSec = lastLoud / SR;
  const centroid = spectralCentroid(mono);
  return { name, peak, rms, durSec, centroid, clips: peak > 0.999 };
}

/** Rough spectral centroid from a naive DFT over the loudest window. */
function spectralCentroid(mono: Float32Array): number {
  const win = 16384;
  // Find loudest region start.
  let bestStart = 0, bestE = -1;
  for (let s = 0; s + win <= mono.length; s += win) {
    let e = 0;
    for (let i = 0; i < win; i += 8) e += mono[s + i]! * mono[s + i]!;
    if (e > bestE) { bestE = e; bestStart = s; }
  }
  if (mono.length < win) return 0;
  const bins = 128;
  const maxHz = 8000;
  let num = 0, den = 0;
  for (let b = 1; b < bins; b++) {
    const f = (b / bins) * maxHz;
    const w = (2 * Math.PI * f) / SR;
    let re = 0, im = 0;
    for (let i = 0; i < win; i += 4) {
      const s = mono[bestStart + i]!;
      // Hann window
      const hn = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);
      re += s * hn * Math.cos(w * i);
      im -= s * hn * Math.sin(w * i);
    }
    const mag = Math.sqrt(re * re + im * im);
    num += f * mag;
    den += mag;
  }
  return den > 0 ? num / den : 0;
}

async function renderOneShot(name: string, seconds: number, trigger: (e: Engine) => void): Promise<Metrics> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR);
  const eng = new Engine({ restrained: false, context: ctx });
  eng.fadeIn(0.005); // bring master up without starting the bed, so we measure only the one-shot
  trigger(eng);
  // Let any setTimeout-scheduled sub-voices (e.g. select's second note) schedule before render.
  await new Promise((r) => setTimeout(r, 140));
  const buf = await ctx.startRendering();
  return analyse(name, buf);
}

async function renderBed(name: string, slam: SlamKey): Promise<Metrics> {
  const seconds = 4.5;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR);
  const eng = new Engine({ restrained: false, context: ctx });
  eng.start(slam);
  const buf = await ctx.startRendering();
  // Measure only the steady-state final second.
  const from = Math.floor(3.4 * SR);
  const slice = ctx.createBuffer(2, buf.length - from, SR);
  for (let c = 0; c < 2; c++) slice.getChannelData(c).set(buf.getChannelData(c).subarray(from));
  return analyse(name, slice);
}

/** The full run laid onto one timeline: runStart, seven advances spaced like the
 *  cinematic, then crown. Each stage is rendered in isolation and summed into the
 *  timeline at its felt offset, which faithfully reproduces the build-and-resolve. */
async function renderRunTimeline(): Promise<{ metrics: Metrics; mono: Float32Array }> {
  const seconds = 11;
  const total = Math.ceil(seconds * SR);
  const mono = new Float32Array(total);
  const place = (m: Float32Array, atSec: number) => {
    const off = Math.floor(atSec * SR);
    for (let i = 0; i < m.length && off + i < total; i++) mono[off + i]! += m[i]!;
  };
  const renderStage = async (secs: number, fn: (e: Engine) => void): Promise<Float32Array> => {
    const ctx = new OfflineAudioContext(1, Math.ceil(secs * SR), SR);
    const eng = new Engine({ restrained: false, context: ctx });
    eng.fadeIn(0.005);
    fn(eng);
    await new Promise((r) => setTimeout(r, 20));
    const b = await ctx.startRendering();
    return b.getChannelData(0).slice();
  };

  place(await renderStage(2.6, (e) => e.runStart()), 0.0);
  const advTimes = [1.2, 1.9, 2.6, 3.35, 4.15, 5.0, 5.9];
  for (let r = 0; r < advTimes.length; r++) {
    const seg = await renderStage(1.6, (e) => e.advance(r + 1, 7));
    place(seg, advTimes[r]!);
  }
  place(await renderStage(4.0, (e) => e.crown()), 6.6);

  // Analyse peak/rms/centroid over the whole run.
  let peak = 0, sq = 0, lastLoud = 0;
  const floor = Math.pow(10, -66 / 20);
  for (let i = 0; i < total; i++) {
    const a = Math.abs(mono[i]!); if (a > peak) peak = a; sq += mono[i]! * mono[i]!;
    if (a > floor) lastLoud = i;
  }
  const metrics: Metrics = {
    name: 'run (build+resolve)', peak, rms: Math.sqrt(sq / total),
    durSec: lastLoud / SR, centroid: spectralCentroid(mono), clips: peak > 0.999,
  };
  return { metrics, mono };
}

function plot(mono: Float32Array) {
  const cv = document.getElementById('plot') as HTMLCanvasElement;
  const g = cv.getContext('2d')!;
  const W = cv.width, H = cv.height, mid = H / 2;
  g.clearRect(0, 0, W, H);
  g.strokeStyle = '#22405a'; g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
  // Envelope: max abs per column.
  g.strokeStyle = '#ecca6a'; g.fillStyle = 'rgba(236,202,106,0.25)';
  const step = Math.floor(mono.length / W);
  g.beginPath();
  for (let x = 0; x < W; x++) {
    let mx = 0; const s = x * step;
    for (let i = 0; i < step; i++) { const a = Math.abs(mono[s + i] ?? 0); if (a > mx) mx = a; }
    const y = mx * mid * 0.95;
    g.moveTo(x, mid - y); g.lineTo(x, mid + y);
  }
  g.stroke();
  return cv.toDataURL('image/png');
}

async function run() {
  const log = document.getElementById('log')!;
  const rows: Metrics[] = [];
  rows.push(await renderOneShot('hover', 1.6, (e) => e.hover()));
  rows.push(await renderOneShot('select', 3.2, (e) => e.select()));
  rows.push(await renderOneShot('dismiss', 3.0, (e) => e.dismiss()));
  rows.push(await renderOneShot('glide in', 1.6, (e) => e.glide(0.85, true)));
  rows.push(await renderOneShot('glide out', 1.6, (e) => e.glide(0.9, false)));
  rows.push(await renderOneShot('slamChange', 4.0, (e) => e.slamChange()));
  rows.push(await renderOneShot('runStart', 2.8, (e) => e.runStart()));
  rows.push(await renderOneShot('advance r1', 3.0, (e) => e.advance(1, 7)));
  rows.push(await renderOneShot('advance r4', 3.4, (e) => e.advance(4, 7)));
  rows.push(await renderOneShot('advance r7', 3.8, (e) => e.advance(7, 7)));
  rows.push(await renderOneShot('crown', 4.2, (e) => e.crown()));
  rows.push(await renderBed('bed ao', 'ao'));
  rows.push(await renderBed('bed rg', 'rg'));
  rows.push(await renderBed('bed wim', 'wim'));
  rows.push(await renderBed('bed us', 'us'));

  const { metrics: runM, mono } = await renderRunTimeline();
  rows.push(runM);
  const png = plot(mono);

  // Anti-stacking proof: fire 50 hovers within one tick; rate-limiting + voice-cap must
  // let essentially one through, so the peak stays at a single-hover level, not 50×.
  const single = await renderOneShot('hover×1', 1.0, (e) => e.hover());
  const flood = await renderOneShot('hover×50', 1.0, (e) => { for (let i = 0; i < 50; i++) e.hover(); });
  rows.push({ ...flood, name: 'hover×50 (flood)' });
  const stackRatio = flood.peak / Math.max(1e-9, single.peak);

  const fmt = (x: number, d = 4) => x.toFixed(d);
  const dbfs = (x: number) => (x <= 0 ? '-inf' : (20 * Math.log10(x)).toFixed(1));
  let out = 'name'.padEnd(22) + 'peak'.padEnd(10) + 'peakdB'.padEnd(9) + 'rms'.padEnd(10) + 'dur(s)'.padEnd(9) + 'centHz'.padEnd(9) + 'clip\n';
  out += '-'.repeat(78) + '\n';
  for (const r of rows) {
    out += r.name.padEnd(22) + fmt(r.peak).padEnd(10) + dbfs(r.peak).padEnd(9) + fmt(r.rms).padEnd(10) +
      fmt(r.durSec, 2).padEnd(9) + Math.round(r.centroid).toString().padEnd(9) + (r.clips ? 'YES' : 'no') + '\n';
  }
  log.textContent = out;
  out += `\nanti-stack: hover×50 peak / hover×1 peak = ${stackRatio.toFixed(2)}× ` +
    `(≤ ~1.5 means no pile-up)\n`;
  log.textContent = out;
  (window as unknown as Record<string, unknown>).__RESULTS = { rows, png, stackRatio };
  (window as unknown as Record<string, unknown>).__DONE = true;
}

run().catch((e) => {
  document.getElementById('log')!.textContent = 'ERROR: ' + (e as Error).message + '\n' + (e as Error).stack;
  (window as unknown as Record<string, unknown>).__DONE = true;
  (window as unknown as Record<string, unknown>).__ERR = String(e);
});
