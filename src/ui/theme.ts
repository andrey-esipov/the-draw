import type { SlamId, Surface } from '../data/types';

export interface SlamTheme {
  id: SlamId;
  /** Deep court ground the whole field is painted in. */
  ground: string;
  groundDeep: string;
  /** Chalk — line paint. The threads and type. */
  chalk: string;
  chalkDim: string;
  /** The one earned accent: the champion's thread. */
  flare: string;
  /** Following a player who did not win. Never the champion's gold. */
  trace: string;
  flareGlow: string;
  surface: Surface;
  label: string;
  city: string;
  /** Secondary signature colour paired with the ground: Wimbledon purple, Roland-Garros bottle green, the AO's cyan, the US Open's apron green. */
  heritage: string;
  /** Tint for the raking rim light that rides the metal. */
  rim: string;
  /** Near-black colour the court dissolves into, carrying the slam's hue as a whisper. */
  fog: string;
}

const THEMES: Record<string, Omit<SlamTheme, 'id'>> = {
  'australian-open': {
    ground: '#0e63a6',
    groundDeep: '#06213f',
    chalk: '#eef5fb',
    chalkDim: '#8cbbe0',
    flare: '#ffd15c',
    flareGlow: '#ffb703',
    trace: '#b9d8ee',
    surface: 'Hard',
    label: 'Australian Open',
    city: 'Melbourne',
    heritage: '#1aa7e0',
    rim: '#2fb4e6',
    fog: '#061422',
  },
  'french-open': {
    ground: '#7e3418',
    groundDeep: '#2e1206',
    chalk: '#f6ece4',
    chalkDim: '#cc9878',
    flare: '#f2b03a',
    flareGlow: '#ff8c42',
    trace: '#c4cbbd',
    surface: 'Clay',
    label: 'Roland-Garros',
    city: 'Paris',
    heritage: '#1c5638',
    rim: '#2a6f49',
    fog: '#150b06',
  },
  wimbledon: {
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
  },
  'us-open': {
    ground: '#113a63',
    groundDeep: '#04182b',
    chalk: '#eef3f8',
    chalkDim: '#7fa2bd',
    flare: '#ecca6a',
    flareGlow: '#d9b24a',
    trace: '#c3d1de',
    surface: 'Hard',
    label: 'US Open',
    city: 'New York',
    heritage: '#3f7a3e',
    rim: '#4f9147',
    fog: '#05111d',
  },
};

export function themeFor(id: SlamId): SlamTheme {
  const key = id.replace(/-(men|women)$/, '');
  const base = THEMES[key] ?? THEMES.wimbledon!;
  return { id, ...base };
}

export const SLAM_ORDER: SlamId[] = [
  'australian-open-men',
  'french-open-men',
  'wimbledon-men',
  'us-open-men',
];

export const SLAM_ORDER_WOMEN: SlamId[] = [
  'australian-open-women',
  'french-open-women',
  'wimbledon-women',
  'us-open-women',
];
