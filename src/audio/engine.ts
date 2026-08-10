// The synthesis engine for "The Draw". Everything is generated from oscillators,
// noise buffers, filters and a synthesized convolution reverb — no audio assets ship.
// The public surface lives in sound.ts; this file is the instrument.

export type SlamKey = 'ao' | 'rg' | 'wim' | 'us';

// A room, not a note. Every bed is built from three bands of filtered noise —
// a low rumble (the building), a low-mid murmur (the crowd) and a whisper of air
// (the openness overhead) — plus, optionally, a very distant occasional ball. No
// pitched drone anywhere: tennis rooms are broadband, so these are too.
interface SlamVoice {
  /** Lowpass ceiling of the room rumble, in Hz. Below pitch — this is felt, not heard. */
  rumbleCut: number;
  /** Level of the room rumble. The US night session rumbles; Wimbledon barely. */
  rumbleLevel: number;
  /** Centre of the crowd-murmur bandpass — the body of the room. */
  murmurCentre: number;
  /** Width of the murmur. Tighter reads closer and drier. */
  murmurQ: number;
  /** How present the crowd is. */
  murmurLevel: number;
  /** Centre of the airy top band — the sense of space above the court. */
  airCentre: number;
  /** How open the room feels overhead. Melbourne is bright and open; Wimbledon is close. */
  airLevel: number;
  /** How much the bed washes into the reverb — the size of the room. */
  reverbSend: number;
  /** Min/max seconds between distant, far-off ball impacts in the bed. */
  impactGap: [number, number];
  /** Level of those distant impacts — always far below the murmur. */
  impactLevel: number;
}

// Four rooms. Wimbledon: quiet, close, dry, restrained. Roland-Garros: warmer,
// dustier midrange, a little more crowd. US Open: night session, big room, most
// low-end rumble, most electric. Australian Open: bright open-air day, most air.
const SLAMS: Record<SlamKey, SlamVoice> = {
  ao:  { rumbleCut: 105, rumbleLevel: 0.20, murmurCentre: 560, murmurQ: 0.45, murmurLevel: 0.70, airCentre: 2100, airLevel: 0.85, reverbSend: 0.42, impactGap: [7, 15], impactLevel: 0.5 },
  rg:  { rumbleCut: 95,  rumbleLevel: 0.22, murmurCentre: 470, murmurQ: 0.55, murmurLevel: 0.78, airCentre: 1500, airLevel: 0.5,  reverbSend: 0.5,  impactGap: [8, 17], impactLevel: 0.45 },
  wim: { rumbleCut: 90,  rumbleLevel: 0.14, murmurCentre: 520, murmurQ: 0.6,  murmurLevel: 0.46, airCentre: 1700, airLevel: 0.34, reverbSend: 0.34, impactGap: [10, 22], impactLevel: 0.4 },
  us:  { rumbleCut: 120, rumbleLevel: 0.28, murmurCentre: 500, murmurQ: 0.4,  murmurLevel: 0.82, airCentre: 1900, airLevel: 0.7,  reverbSend: 0.62, impactGap: [6, 13], impactLevel: 0.55 },
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

  // Bed: three noise bands (rumble, murmur, air) plus far-off ball impacts.
  private bedGain: GainNode;
  private rumbleSrc: AudioBufferSourceNode | null = null;
  private rumbleFilter: BiquadFilterNode;
  private rumbleGain: GainNode;
  private murmurSrc: AudioBufferSourceNode | null = null;
  private murmurFilter: BiquadFilterNode;
  private murmurGain: GainNode;
  private murmurLfo: OscillatorNode;
  private murmurLfoGain: GainNode;
  private airSrc: AudioBufferSourceNode | null = null;
  private airFilter: BiquadFilterNode;
  private airGain: GainNode;
  private airLfo: OscillatorNode;
  private airLfoGain: GainNode;
  private bedSend: GainNode;
  private impactTimer: number | null = null;
  private currentSlam: SlamKey | null = null;

  private noiseBuffer: AudioBuffer;
  private airNoiseBuffer: AudioBuffer;

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
    this.airNoiseBuffer = this.makePinkNoise(3.0);

    // ── Bed ─────────────────────────────────────────────────────────────────────
    this.bedGain = ctx.createGain();
    this.bedGain.gain.value = 1;
    this.bedGain.connect(this.bus);

    // A shared send so the whole bed washes into the room by the slam's amount.
    this.bedSend = ctx.createGain();
    this.bedSend.gain.value = 0.4;
    this.bedSend.connect(this.reverb);

    // Rumble: lowpassed brown noise, below pitch. The building, not a note.
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 110;
    this.rumbleFilter.Q.value = 0.5;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumbleFilter.connect(this.rumbleGain);
    this.rumbleGain.connect(this.bedGain);

    // Murmur: bandpassed brown noise up where voices live, not down in the
    // building. Centred low it was a rumble and the room read as a threat; the
    // crowd is what makes a tennis venue sound like people rather than weather.
    this.murmurFilter = ctx.createBiquadFilter();
    this.murmurFilter.type = 'bandpass';
    this.murmurFilter.frequency.value = 340;
    this.murmurFilter.Q.value = 0.6;
    this.murmurGain = ctx.createGain();
    this.murmurGain.gain.value = 0;
    this.murmurFilter.connect(this.murmurGain);
    this.murmurGain.connect(this.bedGain);
    this.murmurGain.connect(this.bedSend);

    // Slow swells in the murmur, like a distant crowd breathing.
    this.murmurLfo = ctx.createOscillator();
    this.murmurLfo.type = 'sine';
    this.murmurLfo.frequency.value = 0.085;
    this.murmurLfoGain = ctx.createGain();
    this.murmurLfoGain.gain.value = 0.0055;
    this.murmurLfo.connect(this.murmurLfoGain);
    this.murmurLfoGain.connect(this.murmurGain.gain);

    // Air: a whisper of pink noise up top — the openness above the court.
    this.airFilter = ctx.createBiquadFilter();
    this.airFilter.type = 'bandpass';
    this.airFilter.frequency.value = 1600;
    this.airFilter.Q.value = 0.4;
    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0;
    this.airFilter.connect(this.airGain);
    this.airGain.connect(this.bedGain);

    // A slower, offset swell in the air so the two bands never pulse together.
    this.airLfo = ctx.createOscillator();
    this.airLfo.type = 'sine';
    this.airLfo.frequency.value = 0.058;
    this.airLfoGain = ctx.createGain();
    this.airLfoGain.gain.value = 0.0016;
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

  /** Pink noise (Paul Kellet's filter): a natural, airy spectrum for swooshes. */
  private makePinkNoise(seconds: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(seconds * rate);
    const buf = this.ctx.createBuffer(1, len, rate);
    const data = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      data[i] = pink * 0.11;
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
      this.murmurLfo.start();
      this.airLfo.start();
      this.rumbleSrc = ctx.createBufferSource();
      this.rumbleSrc.buffer = this.noiseBuffer;
      this.rumbleSrc.loop = true;
      this.rumbleSrc.connect(this.rumbleFilter);
      this.rumbleSrc.start();
      this.murmurSrc = ctx.createBufferSource();
      this.murmurSrc.buffer = this.noiseBuffer;
      this.murmurSrc.loop = true;
      this.murmurSrc.connect(this.murmurFilter);
      this.murmurSrc.start();
      this.airSrc = ctx.createBufferSource();
      this.airSrc.buffer = this.airNoiseBuffer;
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

    const ramp = (param: AudioParam, to: number) => {
      param.cancelScheduledValues(t);
      param.setValueAtTime(Math.max(0.0001, param.value), t);
      param.linearRampToValueAtTime(Math.max(0.0001, to), t + fade);
    };

    ramp(this.rumbleFilter.frequency, v.rumbleCut);
    ramp(this.rumbleGain.gain, 0.05 * v.rumbleLevel * trim);

    ramp(this.murmurFilter.frequency, v.murmurCentre);
    this.murmurFilter.Q.setTargetAtTime(v.murmurQ, t, 0.5);
    ramp(this.murmurGain.gain, 0.012 * v.murmurLevel * trim);

    ramp(this.airFilter.frequency, v.airCentre);
    ramp(this.airGain.gain, 0.0045 * v.airLevel * trim);

    this.bedSend.gain.cancelScheduledValues(t);
    this.bedSend.gain.setValueAtTime(this.bedSend.gain.value, t);
    this.bedSend.gain.linearRampToValueAtTime(v.reverbSend, t + fade);

    this.currentSlam = slam;
    this.scheduleImpact(v);
  }

  /** Schedule the next far-off ball impact for the current room, then reschedule itself. */
  private scheduleImpact(v: SlamVoice) {
    if (this.impactTimer !== null) { window.clearTimeout(this.impactTimer); this.impactTimer = null; }
    if (typeof window === 'undefined') return;
    const [lo, hi] = v.impactGap;
    const wait = (lo + Math.random() * (hi - lo)) * 1000;
    this.impactTimer = window.setTimeout(() => {
      if (this.currentSlam && this.started) {
        this.thock(0.02 * v.impactLevel * (this.restrained ? 0.6 : 1), 0.85, 0.7);
        this.scheduleImpact(SLAMS[this.currentSlam]);
      }
    }, wait);
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
   * A swoosh: pink noise through a bandpass swept between two frequencies, with a
   * soft attack and decay. The whole air-movement vocabulary — rackets, cards,
   * the camera — is built from this. A random read-offset means no two are alike.
   */
  private swoosh(dur: number, peak: number, fromHz: number, toHz: number, q: number, sendAmt: number) {
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.airNoiseBuffer;
    src.loop = true;
    const offset = Math.random() * Math.max(0, this.airNoiseBuffer.duration - dur - 0.1);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = q;
    bp.frequency.setValueAtTime(fromHz, t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(40, toHz), t + dur);

    // A fixed lowpass tames the pink-noise top so the swoosh reads as warm air
    // moving, not hiss.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1900;
    lp.Q.value = 0.5;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.15);

    src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(this.bus);
    const send = ctx.createGain(); send.gain.value = sendAmt; g.connect(send); send.connect(this.reverb);

    src.start(t, offset);
    src.stop(t + dur * 1.2);
    this.hold(dur * 1.2);
  }

  /**
   * A crowd, not a tone.
   *
   * Two bands of noise — chest around 240Hz and voices around 700Hz — each with
   * its own shape, so a swell reads as people rather than a synthesizer. Every
   * pure sine that used to sit under these moments is gone: a low sine is the
   * single most synthetic sound there is, and at 45-70Hz it read as menace.
   */
  private crowd(dur: number, peak: number, sendAmt = 0.6, lift = 1, delay = 0) {
    const ctx = this.ctx;
    // Scheduled in context time, never on a timer: an offline render has no
    // wall clock, so a setTimeout'd swell simply would not exist in the file
    // the harness measures.
    const t = ctx.currentTime + delay;
    const bands: [number, number, number][] = [
      [240 * lift, 0.55, 0.72],
      [700 * lift, 0.45, 1],
      [1450 * lift, 0.7, 0.34],
    ];
    for (const [centre, q, share] of bands) {
      const src = ctx.createBufferSource();
      src.buffer = this.airNoiseBuffer;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = q;
      bp.frequency.setValueAtTime(centre * 0.72, t);
      bp.frequency.linearRampToValueAtTime(centre, t + dur * 0.3);
      bp.frequency.exponentialRampToValueAtTime(centre * 0.66, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      // Slow in, slower out. A crowd rises before it realises it is rising.
      g.gain.linearRampToValueAtTime(peak * share, t + dur * 0.28);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(bp); bp.connect(g); g.connect(this.bus);
      const send = ctx.createGain(); send.gain.value = sendAmt; g.connect(send); send.connect(this.reverb);
      src.start(t, Math.random() * 1.5);
      src.stop(t + dur + 0.1);
    }
    this.hold(delay + dur + 0.15);
  }

  /**
   * A thock: ball on strings. Mostly a short burst of lowpassed brown noise whose
   * cutoff closes fast (the strings damping), under a low sine that drops in pitch
   * quickly (the weight of the ball). Warm, no click transient, no pitch to speak
   * of. `colour` opens the strings up for the brighter strikes late in a rally.
   */
  private thock(peak: number, colour = 1, sendAmt = 0.3) {
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const offset = Math.random() * Math.max(0, this.noiseBuffer.duration - 0.4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.8;
    lp.frequency.setValueAtTime(Math.min(3000, 1000 * colour), t);
    lp.frequency.exponentialRampToValueAtTime(200, t + 0.1);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(peak, t + 0.008);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
    src.connect(lp); lp.connect(ng); ng.connect(this.bus);
    const send = ctx.createGain(); send.gain.value = sendAmt; ng.connect(send); send.connect(this.reverb);
    src.start(t, offset); src.stop(t + 0.26);

    // The ball's weight, not a bass drop. Held up in the body of the strings
    // and cut short — the old 190→85Hz fall was the most electronic thing here.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(320, t);
    sub.frequency.exponentialRampToValueAtTime(165, t + 0.05);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.linearRampToValueAtTime(peak * 0.3, t + 0.005);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    sub.connect(sg); sg.connect(this.bus);
    sub.start(t); sub.stop(t + 0.26);
    this.hold(0.28);
  }

  hover() {
    if (!this.canVoice('hover', 90)) return;
    const trim = this.restrained ? 0.6 : 1;
    // A racket passing through air, heard from across the court. Barely there.
    this.swoosh(0.19, 0.075 * trim, 520, 1150, 1.0, 0.2);
  }

  select() {
    if (!this.canVoice('select', 90)) return;
    const trim = this.restrained ? 0.7 : 1;
    // A stroke, not a hit: the swing carries it and the strings only just
    // register. A full ball-strike on every click was far too hard a sound for
    // something you do dozens of times reading a draw.
    this.swoosh(0.26, 0.085 * trim, 380, 1250, 0.8, 0.3);
    this.thock(0.075 * trim, 1.5, 0.22);
  }

  /** A card sweeping open — a longer, soft swoosh riding the ~460ms open. */
  expand() {
    if (!this.canVoice('expand', 90)) return;
    const trim = this.restrained ? 0.6 : 1;
    this.swoosh(0.46, 0.085 * trim, 320, 1050, 0.7, 0.4);
  }

  /** A card closing: a shorter, reversed swoosh. */
  dismiss() {
    if (!this.canVoice('dismiss', 90)) return;
    const trim = this.restrained ? 0.6 : 1;
    this.swoosh(0.3, 0.08 * trim, 1050, 300, 0.7, 0.34);
  }

  /**
   * The camera moving. Air travelling past — the same vocabulary as everything
   * else, sweeping up as you depart, settling down as you arrive.
   */
  glide(seconds = 0.9, depart = true) {
    if (!this.canVoice('glide', 220)) return;
    const trim = this.restrained ? 0.5 : 1;
    const from = depart ? 240 : 950;
    const to = depart ? 950 : 240;
    this.swoosh(seconds, 0.06 * trim, from, to, 0.55, 0.42);
  }

  slamChange() {
    if (!this.canVoice('slam', 200)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const trim = this.restrained ? 0.6 : 1;
    // Walking into another stadium: the air moves, and a room full of people
    // settles around you. The old descending 70→45Hz sine read as dread.
    this.swoosh(0.75, 0.04 * trim, 620, 240, 0.55, 0.5);
    this.crowd(1.9, 0.055 * trim, 0.65, 0.92);
    void t;
    this.hold(2.0);
  }

  // ── The run: a rally that builds and resolves ─────────────────────────────

  /** The run begins: a soft breath drawing in under the board — the rally about to start. */
  runStart() {
    if (!this.canVoice('runstart', 200)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const trim = this.restrained ? 0.55 : 1;

    // A rising airy riser, no pitch — the room leaning in, and hushing.
    this.swoosh(1.5, 0.028 * trim, 220, 860, 0.7, 0.4);
    this.crowd(2.0, 0.038 * trim, 0.5, 0.86);
    void t;
    this.hold(2.1);
  }

  /**
   * The thread crosses a round: a struck ball. Energy builds through level,
   * brightness and density — never pitch. Late in the rally the strings are
   * brighter, the strike harder, and the exchanges double up.
   */
  advance(round: number, total = 7) {
    if (!this.canVoice(`adv${round}`, 120)) return;
    const trim = this.restrained ? 0.6 : 1;
    const climb = Math.max(0, Math.min(1, (round - 1) / Math.max(1, total - 1)));

    const peak = (0.11 + climb * 0.06) * trim;
    const colour = 1 + climb * 1.5;
    this.thock(peak, colour, 0.3 + climb * 0.2);
    // A whisper of air over the strike, growing brighter as the rally quickens.
    this.swoosh(0.18 + climb * 0.08, (0.014 + climb * 0.018) * trim, 800, 1500 + climb * 700, 0.85, 0.28);
    // Density: the fast late exchanges answer with a second ball.
    if (climb > 0.5) {
      window.setTimeout(() => this.thock(peak * 0.7, colour, 0.28), 90 - climb * 30);
    }
  }

  /**
   * The rally resolves into a crowd swell — the loudest, warmest moment.
   *
   * Three noise bands rising together and falling apart at different rates,
   * with the voices band arriving last and holding longest. That staggering is
   * what a stadium actually does; a single band blooming and closing is a
   * synthesizer pad, and a sine underneath it was the tell.
   */
  crown() {
    if (!this.canVoice('crown', 800)) return;
    const trim = this.restrained ? 0.6 : 1;

    // Match point: the decisive final ball, struck bright, a beat ahead of the
    // reaction — the room always answers the shot rather than meeting it.
    this.thock(0.15 * trim, 1.6, 0.5);

    // The roar. Long, so it can still be rising while the trophy is landing.
    this.crowd(4.2, 0.155 * trim, 0.75, 1, 0.11);
    // A second, later wave: applause settling in behind the first shout.
    this.crowd(3.4, 0.07 * trim, 0.8, 1.35, 0.78);

    this.hold(5.2);
    void eqPower; // reserved for future manual crossfades; keep the helper referenced
  }

  suspend() { const c = this.ctx as AudioContext; if (c.state === 'running' && c.suspend) void c.suspend(); }
  resume() { const c = this.ctx as AudioContext; if (c.state === 'suspended' && c.resume) void c.resume(); }

  dispose() {
    try {
      if (this.impactTimer !== null) window.clearTimeout(this.impactTimer);
      try { this.murmurLfo.stop(); } catch { /* noop */ }
      try { this.airLfo.stop(); } catch { /* noop */ }
      try { this.rumbleSrc?.stop(); } catch { /* noop */ }
      try { this.murmurSrc?.stop(); } catch { /* noop */ }
      try { this.airSrc?.stop(); } catch { /* noop */ }
    } finally {
      const c = this.ctx as AudioContext;
      if (c.close) void c.close();
    }
  }
}
