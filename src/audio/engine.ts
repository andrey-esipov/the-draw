// The synthesis engine for "The Draw". Everything is generated from oscillators,
// noise buffers, filters and a synthesized convolution reverb — no audio assets ship.
// The public surface lives in sound.ts; this file is the instrument.

export type SlamKey = 'ao' | 'rg' | 'wim' | 'us';

interface SlamVoice {
  /** Fundamental of the drone, in Hz. Kept in the low register so it reads as room, not note. */
  root: number;
  /** Ceiling of the drone lowpass — how much air the bed carries. */
  droneCut: number;
  /** Centre of the crowd-air bandpass — the colour of the room. */
  airCentre: number;
  /** How present the crowd air is. Wimbledon whispers; the US Open breathes. */
  airLevel: number;
  /** Overall bed level trim. Warmer rooms sit lower. */
  bedTrim: number;
  /** Slight detune spread across the drone stack, in cents. */
  spread: number;
}

// Four rooms. Roots are low just-tuned pitches; the character is carried in the
// filtering, not the note. Wimbledon is warmest and quietest, the US Open coolest
// and most electric, Roland-Garros clay-warm, Melbourne open and bright-blue.
const SLAMS: Record<SlamKey, SlamVoice> = {
  ao: { root: 65.41, droneCut: 300, airCentre: 300, airLevel: 0.8, bedTrim: 1.0, spread: 3 },
  rg: { root: 58.27, droneCut: 260, airCentre: 250, airLevel: 0.66, bedTrim: 0.9, spread: 4 },
  wim: { root: 55.0, droneCut: 232, airCentre: 200, airLevel: 0.3, bedTrim: 0.95, spread: 2.5 },
  us: { root: 61.74, droneCut: 320, airCentre: 340, airLevel: 0.9, bedTrim: 1.0, spread: 4 },
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** A gentle equal-power-ish crossfade curve. */
function eqPower(x: number): number {
  return Math.sin((x * Math.PI) / 2);
}

export interface EngineOptions {
  /** Reduced-motion is a hint toward restraint: lower everything, soften transients. */
  restrained: boolean;
  /**
   * Inject a context. Production passes nothing and a realtime AudioContext is created;
   * the offline test harness passes an OfflineAudioContext so every sound can be rendered
   * to a buffer and measured. Both satisfy BaseAudioContext, which is all the graph uses.
   */
  context?: BaseAudioContext;
}

/**
 * The instrument. Owns one AudioContext and its whole graph. All timing is done in
 * AudioContext time; all levels pass through a master lowpass and a limiter so nothing
 * can ever clip or fatigue, and every one-shot is voice-capped and rate-limited.
 */
export class Engine {
  readonly ctx: BaseAudioContext;
  private restrained: boolean;

  // Master chain: busGain -> tone (lowpass roll-off) -> comp (limiter) -> master -> out
  private master: GainNode;
  private comp: DynamicsCompressorNode;
  private tone: BiquadFilterNode;
  private bus: GainNode;
  private reverb: ConvolverNode;
  private reverbReturn: GainNode;

  // Bed
  private bedGain: GainNode;
  private droneOscs: OscillatorNode[] = [];
  private droneGain: GainNode;
  private droneFilter: BiquadFilterNode;
  private droneLfo: OscillatorNode;
  private droneLfoGain: GainNode;
  private airSrc: AudioBufferSourceNode | null = null;
  private airFilter: BiquadFilterNode;
  private airGain: GainNode;
  private airLfo: OscillatorNode;
  private airLfoGain: GainNode;
  private currentSlam: SlamKey | null = null;

  private noiseBuffer: AudioBuffer;

  // Voice management
  private activeVoices = 0;
  private readonly maxVoices = 10;
  private lastAt: Record<string, number> = {};
  private started = false;

  constructor(opts: EngineOptions) {
    this.restrained = opts.restrained;
    if (opts.context) {
      this.ctx = opts.context;
    } else {
      const Ctor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    const ctx = this.ctx;

    // ── Master chain ──────────────────────────────────────────────────────────
    this.master = ctx.createGain();
    this.master.gain.value = 0; // fade in on start()

    // A brick-wall-ish limiter so a judge's laptop can never be startled.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 12;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.25;

    // Global top-end roll-off — nothing above this reaches the ear, so nothing is harsh.
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 4200;
    this.tone.Q.value = 0.4;

    this.bus = ctx.createGain();
    this.bus.gain.value = 1;

    this.bus.connect(this.tone);
    this.tone.connect(this.comp);
    this.comp.connect(this.master);
    this.master.connect(ctx.destination);

    // ── Reverb (synthesized impulse) ─────────────────────────────────────────
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(4.2, 2.8);
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.72;
    this.reverb.connect(this.reverbReturn);
    this.reverbReturn.connect(this.bus);

    this.noiseBuffer = this.makeNoise(3.0);

    // ── Bed: drone ────────────────────────────────────────────────────────────
    this.bedGain = ctx.createGain();
    this.bedGain.gain.value = 1;
    this.bedGain.connect(this.bus);

    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 300;
    this.droneFilter.Q.value = 0.7;

    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.droneFilter.connect(this.droneGain);
    this.droneGain.connect(this.bedGain);
    // A whisper of the drone into the reverb gives the room a tail.
    const droneSend = ctx.createGain();
    droneSend.gain.value = 0.25;
    this.droneGain.connect(droneSend);
    droneSend.connect(this.reverb);

    // Root, octave, twelfth. A fifth this low turns to mud on a laptop speaker;
    // stacking upward keeps the bed warm and clean.
    const ratios = [1, 2, 3];
    for (const r of ratios) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 46 * r;
      osc.connect(this.droneFilter);
      this.droneOscs.push(osc);
    }

    // Slow breathing on the drone's amplitude so the bed never sits perfectly still.
    this.droneLfo = ctx.createOscillator();
    this.droneLfo.type = 'sine';
    this.droneLfo.frequency.value = 0.037;
    this.droneLfoGain = ctx.createGain();
    this.droneLfoGain.gain.value = 0.0009;
    this.droneLfo.connect(this.droneLfoGain);
    this.droneLfoGain.connect(this.droneGain.gain);

    // ── Bed: crowd air ────────────────────────────────────────────────────────
    this.airFilter = ctx.createBiquadFilter();
    this.airFilter.type = 'bandpass';
    this.airFilter.frequency.value = 480;
    this.airFilter.Q.value = 0.5;

    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0;
    this.airFilter.connect(this.airGain);
    this.airGain.connect(this.bedGain);

    // Very slow swells in the air, like a distant crowd inhaling.
    this.airLfo = ctx.createOscillator();
    this.airLfo.type = 'sine';
    this.airLfo.frequency.value = 0.028;
    this.airLfoGain = ctx.createGain();
    this.airLfoGain.gain.value = 0.0028;
    this.airLfo.connect(this.airLfoGain);
    this.airLfoGain.connect(this.airGain.gain);
  }

  /** Build a decaying-noise impulse response for the convolution reverb. */
  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(seconds * rate));
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // A short soft onset then an exponential tail; a touch of stereo decorrelation.
        const env = Math.pow(1 - t, decay);
        const onset = Math.min(1, i / (rate * 0.012));
        data[i] = (Math.random() * 2 - 1) * env * onset;
      }
    }
    return buf;
  }

  private makeNoise(seconds: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(seconds * rate);
    const buf = this.ctx.createBuffer(1, len, rate);
    const data = buf.getChannelData(0);
    // Brown-ish noise: integrated white, softer and rounder than raw hiss.
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    return buf;
  }

  private canVoice(kind: string, minGap: number): boolean {
    const t = now();
    if (this.activeVoices >= this.maxVoices) return false;
    if (t - (this.lastAt[kind] ?? -1e9) < minGap) return false;
    this.lastAt[kind] = t;
    return true;
  }

  private hold(seconds: number) {
    this.activeVoices++;
    window.setTimeout(() => { this.activeVoices = Math.max(0, this.activeVoices - 1); }, seconds * 1000 + 60);
  }

  /** Start the bed. Idempotent; safe to call once the context is running. */
  start(slam: SlamKey) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    if (!this.started) {
      this.started = true;
      this.droneOscs.forEach((o) => o.start());
      this.droneLfo.start();
      this.airLfo.start();
      this.airSrc = ctx.createBufferSource();
      this.airSrc.buffer = this.noiseBuffer;
      this.airSrc.loop = true;
      this.airSrc.connect(this.airFilter);
      this.airSrc.start();
    }
    // Fade the master up gently — the bed arrives, it doesn't switch on.
    const target = this.restrained ? 0.24 : 0.36;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(target, t + 3.4);
    this.setBed(slam, this.currentSlam === null ? 3.2 : 2.4);
  }

  /** Retune the bed to a slam, crossfading the room over `fade` seconds. */
  setBed(slam: SlamKey, fade = 2.4) {
    const v = SLAMS[slam];
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const trim = this.restrained ? 0.7 : 1;

    const ratios = [1, 2, 3];
    this.droneOscs.forEach((osc, i) => {
      const detune = (i - 1) * v.spread;
      osc.frequency.cancelScheduledValues(t);
      osc.frequency.setValueAtTime(osc.frequency.value, t);
      osc.frequency.linearRampToValueAtTime(v.root * ratios[i]!, t + fade);
      osc.detune.setTargetAtTime(detune, t, 0.5);
    });

    this.droneFilter.frequency.cancelScheduledValues(t);
    this.droneFilter.frequency.setValueAtTime(this.droneFilter.frequency.value, t);
    this.droneFilter.frequency.linearRampToValueAtTime(v.droneCut, t + fade);

    const droneLevel = 0.026 * v.bedTrim * trim;
    this.droneGain.gain.cancelScheduledValues(t);
    this.droneGain.gain.setValueAtTime(Math.max(0.0001, this.droneGain.gain.value), t);
    this.droneGain.gain.linearRampToValueAtTime(droneLevel, t + fade);

    this.airFilter.frequency.cancelScheduledValues(t);
    this.airFilter.frequency.setValueAtTime(this.airFilter.frequency.value, t);
    this.airFilter.frequency.linearRampToValueAtTime(v.airCentre, t + fade);

    const airLevel = 0.009 * v.airLevel * trim;
    this.airGain.gain.cancelScheduledValues(t);
    this.airGain.gain.setValueAtTime(Math.max(0.0001, this.airGain.gain.value), t);
    this.airGain.gain.linearRampToValueAtTime(airLevel, t + fade);

    this.currentSlam = slam;
  }

  /** Fade the whole output down without tearing the graph down (used for ducking/disable). */
  fadeOut(seconds = 0.5) {
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(0, t + seconds);
  }

  fadeIn(seconds = 0.6) {
    const t = this.ctx.currentTime;
    const target = this.restrained ? 0.24 : 0.36;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(target, t + seconds);
  }

  // ── One-shots ───────────────────────────────────────────────────────────────

  /**
   * A struck resonant tone: three partials over a soft body, eased in over tens
   * of milliseconds so there is no click, damped by a lowpass that closes as it
   * decays, and sent generously to the room. This is the whole vocabulary — the
   * interface is never allowed to beep.
   */
  private strike(freq: number, peak: number, tail: number, sendAmt: number, colour = 1) {
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const body = ctx.createGain();
    body.gain.value = 1;

    // A lowpass that closes over the tail, the way a struck body loses its top
    // first. Nothing here is ever bright enough to read as a beep.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.4;
    lp.frequency.setValueAtTime(Math.min(3200, freq * 5.5 * colour), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(140, freq * 1.4), t + tail);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    // A slow enough attack to be felt rather than struck at you.
    g.gain.linearRampToValueAtTime(peak, t + 0.055);
    g.gain.exponentialRampToValueAtTime(0.0001, t + tail);

    // Root, octave, twelfth: consonant, no beating, no metallic inharmonics.
    const partials: [number, number][] = [[1, 1], [2, 0.3], [3, 0.12]];
    const oscs: OscillatorNode[] = [];
    for (const [ratio, level] of partials) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * ratio;
      const pg = ctx.createGain();
      pg.gain.value = level;
      osc.connect(pg);
      pg.connect(body);
      oscs.push(osc);
    }

    body.connect(lp);
    lp.connect(g);
    g.connect(this.bus);

    const send = ctx.createGain();
    send.gain.value = sendAmt;
    g.connect(send);
    send.connect(this.reverb);

    oscs.forEach((o) => { o.start(t); o.stop(t + tail + 0.08); });
    this.hold(tail);
  }

  hover() {
    if (!this.canVoice('hover', 90)) return;
    const trim = this.restrained ? 0.6 : 1;
    // Barely there: a low breath of tone under the cursor, not a tick.
    this.strike(220, 0.016 * trim, 0.9, 0.5, 0.7);
  }

  select() {
    if (!this.canVoice('select', 90)) return;
    const trim = this.restrained ? 0.6 : 1;
    // A card opening: a warm low tone, answered a beat later by its fifth.
    this.strike(146.83, 0.05 * trim, 2.2, 0.62);
    window.setTimeout(() => this.strike(220, 0.03 * trim, 2.6, 0.7), 130);
  }

  /** A card closing: the same warmth, resolving downward. */
  dismiss() {
    if (!this.canVoice('dismiss', 90)) return;
    const trim = this.restrained ? 0.6 : 1;
    this.strike(196, 0.032 * trim, 1.6, 0.6);
    window.setTimeout(() => this.strike(130.81, 0.028 * trim, 2.2, 0.66), 120);
  }

  /**
   * The camera moving. Not a note — a breath of air moving past, so the travel
   * has weight without anything sounding.
   */
  glide(seconds = 0.9, depart = true) {
    if (!this.canVoice('glide', 220)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const trim = this.restrained ? 0.4 : 1;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.55;
    const from = depart ? 170 : 380;
    const to = depart ? 420 : 150;
    bp.frequency.setValueAtTime(from, t);
    bp.frequency.exponentialRampToValueAtTime(to, t + seconds);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.075 * trim, t + seconds * 0.42);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds * 1.15);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.bus);
    const send = ctx.createGain();
    send.gain.value = 0.45;
    g.connect(send);
    send.connect(this.reverb);

    src.start(t);
    src.stop(t + seconds * 1.2);
    this.hold(seconds * 1.2);
  }

  slamChange() {
    if (!this.canVoice('slam', 200)) return;
    const trim = this.restrained ? 0.6 : 1;
    // The room changing: one low tone, long, under everything.
    this.strike(98, 0.045 * trim, 3.2, 0.8, 0.8);
  }

  // ── The run: a build that resolves ────────────────────────────────────────

  /** The run begins: a soft, dark swell rising under the board. */
  runStart() {
    if (!this.canVoice('runstart', 200)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const trim = this.restrained ? 0.55 : 1;

    // A filtered-noise riser plus a low sub, both swelling in and settling.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(180, t);
    bp.frequency.linearRampToValueAtTime(430, t + 1.9);
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.017 * trim, t + 1.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    src.connect(bp); bp.connect(g); g.connect(this.bus);
    const send = ctx.createGain(); send.gain.value = 0.3; g.connect(send); send.connect(this.reverb);
    src.start(t); src.stop(t + 2.3);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(41, t);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.linearRampToValueAtTime(0.038 * trim, t + 1.0);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 2.0);
    sub.connect(sg); sg.connect(this.bus);
    sub.start(t); sub.stop(t + 2.1);
    this.hold(2.3);
  }

  /**
   * The thread crosses a round. A low pentatonic climb — no leading tones, so it
   * rises without ever sounding like a scale being played at you. Later rounds
   * gain an octave above and a longer tail, so the ascent is felt, not counted.
   */
  advance(round: number, total = 7) {
    if (!this.canVoice(`adv${round}`, 120)) return;
    const trim = this.restrained ? 0.6 : 1;

    const scale = [146.83, 174.61, 196.0, 220.0, 261.63, 293.66, 349.23, 392.0];
    const idx = Math.max(0, Math.min(scale.length - 1, round - 1));
    const f = scale[idx]!;
    const climb = idx / Math.max(1, total - 1);

    this.strike(f, (0.032 + climb * 0.026) * trim, 1.9 + climb * 1.1, 0.55 + climb * 0.25, 0.9 + climb * 0.3);
    if (climb > 0.45) {
      window.setTimeout(() => this.strike(f * 2, 0.016 * trim, 2.4, 0.75, 0.8), 90);
    }
  }
  crown() {
    if (!this.canVoice('crown', 800)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const trim = this.restrained ? 0.6 : 1;

    // A major chord voiced low to high: root, fifth, octave, major tenth. Warm.
    const chord = [98.0, 146.83, 196.0, 246.94, 392.0];
    chord.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = i < 2 ? 'sine' : 'triangle';
      osc.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(3400, f * 3.5);
      lp.Q.value = 0.4;
      const g = ctx.createGain();
      const peak = (0.062 - i * 0.007) * trim;
      const attack = 0.12 + i * 0.05;
      const tail = 3.4 - i * 0.25;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(Math.max(0.012, peak), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + tail);
      osc.connect(lp); lp.connect(g); g.connect(this.bus);
      const send = ctx.createGain(); send.gain.value = 0.6; g.connect(send); send.connect(this.reverb);
      osc.start(t); osc.stop(t + tail + 0.1);
    });

    // A soft sub swell underneath for body — the trophy landing.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 49;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.linearRampToValueAtTime(0.05 * trim, t + 0.35);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 3.0);
    sub.connect(sg); sg.connect(this.bus);
    sub.start(t); sub.stop(t + 3.1);
    this.hold(3.5);

    void eqPower; // reserved for future manual crossfades; keep the helper referenced
  }

  suspend() { const c = this.ctx as AudioContext; if (c.state === 'running' && c.suspend) void c.suspend(); }
  resume() { const c = this.ctx as AudioContext; if (c.state === 'suspended' && c.resume) void c.resume(); }

  dispose() {
    try {
      this.droneOscs.forEach((o) => { try { o.stop(); } catch { /* already stopped */ } });
      try { this.droneLfo.stop(); } catch { /* noop */ }
      try { this.airLfo.stop(); } catch { /* noop */ }
      try { this.airSrc?.stop(); } catch { /* noop */ }
    } finally {
      const c = this.ctx as AudioContext;
      if (c.close) void c.close();
    }
  }
}
