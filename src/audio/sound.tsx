// The sound layer for "The Draw" — a self-contained, imperative surface plus a
// bespoke toggle. Sound is ON by intent from the first visit; browsers will not
// unlock an AudioContext without a gesture, so the bed arms itself on the first
// interaction the visitor makes anyway. Everything is synthesized (see engine.ts);
// no audio assets ship.
//
// Wire the imperative `sound` object into call sites; render <SoundToggle /> once.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Engine, type SlamKey } from './engine';

const STORAGE_KEY = 'the-draw:sound';

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** Map an app SlamId (or any slam string) to the engine's room key. */
export function slamKey(id: string): SlamKey {
  if (id.startsWith('austral')) return 'ao';
  if (id.startsWith('french') || id.startsWith('roland')) return 'rg';
  if (id.startsWith('wimb')) return 'wim';
  return 'us';
}

type Listener = (state: { enabled: boolean; ready: boolean }) => void;

class Sound {
  /** What the visitor wants. Persisted. On unless they turned it off. */
  enabled = true;
  /** Whether audio is actually running. Never inferred from `enabled`. */
  ready = false;
  private engine: Engine | null = null;
  private pendingSlam: SlamKey = 'wim';
  private lastSlam: SlamKey = 'wim';
  private listeners = new Set<Listener>();
  private hiddenDucked = false;
  private arming = false;

  constructor() {
    if (typeof window === 'undefined') return;
    try {
      this.enabled = window.localStorage.getItem(STORAGE_KEY) !== 'off';
    } catch {
      this.enabled = true;
    }
    document.addEventListener('visibilitychange', this.onVisibility);
    if (this.enabled) this.listenForGesture();
  }

  /**
   * Autoplay policy means the bed cannot start until the visitor touches the page.
   * Rather than nag them with a "click to enable audio" gate, we arm on whatever
   * they do first. Until then the toggle reports "on, not yet playing" honestly.
   */
  private listenForGesture() {
    if (typeof window === 'undefined') return;
    const arm = () => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
      void this.arm();
    };
    window.addEventListener('pointerdown', arm, { once: true });
    window.addEventListener('keydown', arm, { once: true });
  }

  private async arm(): Promise<void> {
    if (this.arming || this.ready || !this.enabled) return;
    this.arming = true;
    try {
      await this.init();
      if (this.engine) {
        this.engine.start(this.pendingSlam);
        this.lastSlam = this.pendingSlam;
        this.ready = true;
      }
    } finally {
      this.arming = false;
      this.emit();
    }
  }

  private onVisibility = () => {
    if (!this.engine) return;
    if (document.hidden) {
      this.engine.fadeOut(0.4);
      this.hiddenDucked = true;
      window.setTimeout(() => { if (document.hidden) this.engine?.suspend(); }, 500);
    } else if (this.hiddenDucked) {
      this.hiddenDucked = false;
      this.engine.resume();
      if (this.enabled) this.engine.fadeIn(0.7);
    }
  };

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const snapshot = { enabled: this.enabled, ready: this.ready };
    for (const fn of this.listeners) fn(snapshot);
  }

  /** Unlock the AudioContext on a user gesture. */
  async init(): Promise<void> {
    if (this.engine) {
      await this.engine.resume();
      return;
    }
    try {
      this.engine = new Engine({ restrained: prefersReduced() });
      await this.engine.resume();
    } catch {
      this.engine = null;
    }
  }

  async setEnabled(on: boolean): Promise<void> {
    this.enabled = on;
    try { window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
    if (on) {
      await this.arm();
      return;
    }
    this.engine?.fadeOut(0.5);
    this.ready = false;
    this.emit();
  }

  bed(slam: string): void {
    const key = slamKey(slam);
    this.pendingSlam = key;
    if (!this.engine || !this.enabled) return;
    if (key !== this.lastSlam) {
      this.engine.setBed(key);
      this.lastSlam = key;
    }
  }

  private fire(fn: (e: Engine) => void): void {
    if (!this.engine || !this.enabled || !this.ready) return;
    fn(this.engine);
  }

  slamChange(): void { this.fire((e) => e.slamChange()); }
  hover(): void { this.fire((e) => e.hover()); }
  select(): void { this.fire((e) => e.select()); }
  expand(): void { this.fire((e) => e.expand()); }
  dismiss(): void { this.fire((e) => e.dismiss()); }
  glide(seconds?: number, depart?: boolean): void { this.fire((e) => e.glide(seconds, depart)); }
  runStart(): void { this.fire((e) => e.runStart()); }
  advance(round: number, total = 7): void { this.fire((e) => e.advance(round, total)); }
  crown(): void { this.fire((e) => e.crown()); }

  dispose(): void {
    if (typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    this.engine?.dispose();
    this.engine = null;
    this.ready = false;
  }
}

export const sound = new Sound();

// ── The toggle ────────────────────────────────────────────────────────────────

interface ToggleProps {
  /** Current slam so the bed opens on the right room. */
  slam?: string;
  style?: CSSProperties;
  className?: string;
}

/**
 * A bespoke sound mark rather than a stock speaker glyph: a struck vertical stem
 * with three arcs radiating from it, the arcs sized like the rings of a ball
 * bouncing away. Muted replaces the arcs with a single cut stroke, so the state
 * survives colour blindness and reads at a glance.
 */
export function SoundToggle({ slam, style, className }: ToggleProps) {
  const [state, setState] = useState({ enabled: sound.enabled, ready: sound.ready });
  const busy = useRef(false);

  useEffect(() => sound.subscribe(setState), []);
  useEffect(() => { if (slam) sound.bed(slam); }, [slam]);

  const { enabled, ready } = state;
  const label = !enabled
    ? 'Sound off — turn on ambient sound'
    : ready
      ? 'Sound on — mute'
      : 'Sound on — starts when you touch the board';

  const toggle = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      if (slam) sound.bed(slam);
      await sound.setEnabled(!enabled);
    } finally {
      busy.current = false;
    }
  };

  return (
    <button
      type="button"
      className={`snd${enabled ? ' is-on' : ''}${ready ? ' is-live' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      onClick={toggle}
      aria-pressed={enabled}
      aria-label={label}
      title={label}
    >
      <svg className="snd-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          className="snd-stem"
          d="M8.4 9.1h2.3L14 6.2v11.6l-3.3-2.9H8.4a1 1 0 0 1-1-1v-3.8a1 1 0 0 1 1-1Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinejoin="round"
        />
        <g className="snd-arcs" fill="none" stroke="currentColor" strokeLinecap="round">
          <path className="snd-arc snd-arc-1" d="M16.5 9.6a3.4 3.4 0 0 1 0 4.8" strokeWidth="1.35" />
          <path className="snd-arc snd-arc-2" d="M18.7 7.6a6.5 6.5 0 0 1 0 8.8" strokeWidth="1.2" />
        </g>
        {/* Muted is a cross, not a single stroke. One diagonal sitting beside the
            cone, crossing nothing, read as a stray tick rather than as "off" —
            it needs either to cut through the whole icon or to be an unambiguous
            x. A cross sits exactly where the waves are when sound is on, so the
            two states swap in the same place and say opposite things. */}
        <g
          className="snd-cut"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
        >
          <path d="M16.2 9.8 20.6 14.2" />
          <path d="M20.6 9.8 16.2 14.2" />
        </g>
      </svg>
      <span className="snd-sr">{label}</span>
    </button>
  );
}
