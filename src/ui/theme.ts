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
}

const THEMES: Record<string, Omit<SlamTheme, 'id'>> = {
  'australian-open': {
    ground: '#0f4478',
    groundDeep: '#07203f',
    chalk: '#e9f1f6',
    chalkDim: '#8fb6d6',
    flare: '#ffd166',
    flareGlow: '#ffb703',
    trace: '#f4f1e6',
    surface: 'Hard',
    label: 'Australian Open',
    city: 'Melbourne',
  },
  'french-open': {
    ground: '#6b2a12',
    groundDeep: '#331307',
    chalk: '#f6ece4',
    chalkDim: '#c08a6c',
    flare: '#ffb26b',
    flareGlow: '#ff8c42',
    trace: '#f4f1e6',
    surface: 'Clay',
    label: 'Roland-Garros',
    city: 'Paris',
  },
  wimbledon: {
    ground: '#164630',
    groundDeep: '#071f14',
    chalk: '#f2f4ea',
    chalkDim: '#7fa189',
    flare: '#d8c56a',
    flareGlow: '#bfa53f',
    trace: '#f4f1e6',
    surface: 'Grass',
    label: 'Wimbledon',
    city: 'London',
  },
  'us-open': {
    ground: '#0d3345',
    groundDeep: '#051d28',
    chalk: '#eef3f8',
    chalkDim: '#79a9b4',
    flare: '#7fe3d0',
    flareGlow: '#3fc9b0',
    trace: '#f4f1e6',
    surface: 'Hard',
    label: 'US Open',
    city: 'New York',
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
