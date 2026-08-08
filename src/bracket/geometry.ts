import type { Draw, Match } from '../data/types';

export const ENTRANTS = 128;
export const ROUNDS = 7;

/** Angular gap at the top of the ring, in degrees. Gives the mandala an opening. */
const GAP_DEG = 14;
const SWEEP_DEG = 360 - GAP_DEG;
const START_DEG = -90 + GAP_DEG / 2;

/** Normalized radius of the entrant ring and of the innermost (final) node. */
const R_OUTER = 1;
const R_FINAL = 0.014;
/** >1 gives the crowded outer rounds more radial room and pulls the closing rounds into a tight core. */
const RADIUS_FALLOFF = 1.35;

export interface Point {
  x: number;
  y: number;
}

export interface NodeRef {
  round: number;
  position: number;
}

export interface EdgeGeom {
  /** Match this edge feeds into. */
  matchId: string;
  round: number;
  position: number;
  /** 0 or 1 — which side of the match. */
  side: number;
  /** Player entering along this edge, if known. */
  player: string | null;
  /** True when this player won the match and continued inward. */
  advanced: boolean;
  d: string;
  /** Path length in normalized units, for stroke-dash choreography. */
  length: number;
  /**
   * This side's share of the games played in the match, doubled so an even match
   * reads as 1. A blowout gives the winner a confident thread and the loser a
   * vanishing one; a five-setter gives two threads of almost equal weight.
   */
  weight: number;
}

export interface LeafGeom {
  index: number;
  angleDeg: number;
  player: string | null;
  seed: string | null;
  matchId: string;
  side: number;
}

export interface MatchGeom {
  match: Match;
  angleDeg: number;
  radius: number;
  point: Point;
}

export interface DrawGeometry {
  edges: EdgeGeom[];
  leaves: LeafGeom[];
  matches: Map<string, MatchGeom>;
  center: Point;
  radius: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

export function polar(angleDeg: number, radius: number, scale: number, center: Point): Point {
  const a = rad(angleDeg);
  return { x: center.x + Math.cos(a) * radius * scale, y: center.y + Math.sin(a) * radius * scale };
}

export function leafAngle(index: number): number {
  return START_DEG + (index / (ENTRANTS - 1)) * SWEEP_DEG;
}

/** Radius of the node ring for a given round. Round 0 is the entrant ring. */
export function ringRadius(round: number): number {
  const t = (ROUNDS - round) / ROUNDS;
  return R_FINAL + (R_OUTER - R_FINAL) * t ** RADIUS_FALLOFF;
}

/** Angle of a match node: the midpoint of the entrant span it governs. */
export function matchAngle(round: number, position: number): number {
  const span = 2 ** round;
  return leafAngle(position * span + (span - 1) / 2);
}

/**
 * One edge, routed as a bundled cubic: it leaves the child on a radial heading and
 * arrives at the parent on a radial heading, swinging between the two angles in the
 * middle. Every thread therefore reads as flowing inward rather than around.
 */
function edgePath(
  childAngle: number,
  childRadius: number,
  parentAngle: number,
  parentRadius: number,
  scale: number,
  center: Point,
): { d: string; length: number } {
  const a = polar(childAngle, childRadius, scale, center);
  const b = polar(parentAngle, parentRadius, scale, center);
  const radial = Math.abs(childRadius - parentRadius) * scale;

  if (parentRadius <= 0 || Math.abs(parentAngle - childAngle) < 1e-6) {
    return { d: `M${a.x.toFixed(2)},${a.y.toFixed(2)}L${b.x.toFixed(2)},${b.y.toFixed(2)}`, length: radial };
  }

  const c1 = polar(childAngle, childRadius + (parentRadius - childRadius) * 0.55, scale, center);
  const c2 = polar(parentAngle, parentRadius + (childRadius - parentRadius) * 0.3, scale, center);
  const arc = (Math.abs(rad(parentAngle - childAngle)) * (childRadius + parentRadius) * scale) / 2;
  const d =
    `M${a.x.toFixed(2)},${a.y.toFixed(2)}` +
    `C${c1.x.toFixed(2)},${c1.y.toFixed(2)} ${c2.x.toFixed(2)},${c2.y.toFixed(2)} ${b.x.toFixed(2)},${b.y.toFixed(2)}`;
  return { d, length: Math.hypot(radial, arc) };
}

/** Doubled share of total games won by one side. 1 means an even match. */
function gameShare(match: Match, side: number): number {
  const totals = match.sides.map((s) => s.sets.reduce((sum, set) => sum + set.games, 0));
  const all = totals.reduce((a, b) => a + b, 0);
  if (all === 0) return 1;
  return ((totals[side] ?? 0) / all) * 2;
}

export function buildGeometry(draw: Draw, scale: number, center: Point): DrawGeometry {
  const edges: EdgeGeom[] = [];
  const leaves: LeafGeom[] = [];
  const matches = new Map<string, MatchGeom>();

  for (const round of draw.rounds) {
    for (const match of round.matches) {
      const angle = matchAngle(round.round, match.position);
      const radius = ringRadius(round.round);
      matches.set(match.id, { match, angleDeg: angle, radius, point: polar(angle, radius, scale, center) });
    }
  }

  for (const round of draw.rounds) {
    const childRadius = ringRadius(round.round - 1);
    for (const match of round.matches) {
      const parent = matches.get(match.id)!;
      for (let side = 0; side < 2; side++) {
        const childPos = match.position * 2 + side;
        const childAngle =
          round.round === 1 ? leafAngle(childPos) : matchAngle(round.round - 1, childPos);
        const player = match.sides[side]?.player ?? null;
        const weight = gameShare(match, side);
        const { d, length } = edgePath(
          childAngle,
          childRadius,
          parent.angleDeg,
          parent.radius,
          scale,
          center,
        );
        edges.push({
          matchId: match.id,
          round: round.round,
          position: match.position,
          side,
          player,
          advanced: player !== null && player === match.winner,
          d,
          length,
          weight,
        });

        if (round.round === 1) {
          leaves.push({
            index: childPos,
            angleDeg: childAngle,
            player,
            seed: match.sides[side]?.seed ?? null,
            matchId: match.id,
            side,
          });
        }
      }
    }
  }

  const final = draw.rounds[draw.rounds.length - 1]?.matches[0];
  if (final?.winner) {
    const parent = matches.get(final.id)!;
    const { d, length } = edgePath(parent.angleDeg, parent.radius, parent.angleDeg, 0, scale, center);
    edges.push({
      matchId: final.id,
      round: ROUNDS + 1,
      position: 0,
      side: -1,
      player: final.winner,
      advanced: true,
      d,
      length,
      weight: 1.5,
    });
  }

  return { edges, leaves, matches, center, radius: scale };
}
