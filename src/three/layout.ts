import type { Draw, Match } from '../data/types';

/**
 * The classic draw sheet, placed in space.
 *
 * Rounds mirror outward from the final: the top half of the draw runs off to the
 * left, the bottom half to the right, and both converge on the trophy at centre.
 * Each earlier round also steps further back in Z, so perspective does the work
 * that a flat bracket cannot — round one is a dense far wall, the final is close
 * enough to read from across the room.
 */

export const ROUNDS = 7;

/** Half the horizontal gap held open at centre for the final and the podium. */
const CENTER_GAP = 4.6;
/** Horizontal distance between adjacent rounds. */
const COL_W = 4.4;
/** How far each earlier round retreats from the camera. */
const DEPTH_STEP = 0.42;
/** Total vertical extent of every round, which is what keeps parents centred. */
const SPAN = 34;

/** Plate size per round. Later rounds are physically bigger, not just nearer. */
const PLATE_W = [0, 3.15, 3.35, 3.6, 3.9, 4.25, 4.7, 5.6];
const PLATE_H = [0, 0.62, 0.78, 0.98, 1.22, 1.5, 1.85, 2.3];

export interface PlateNode {
  match: Match;
  round: number;
  /** -1 for the top half of the draw, +1 for the bottom, 0 for the final. */
  side: -1 | 0 | 1;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  /** Index into the flat plate list, which doubles as the instance id. */
  index: number;
}

export interface Connector {
  from: PlateNode;
  to: PlateNode;
  /** The winning player, so a route can be filtered to one person. */
  player: string | null;
}

export interface BracketLayout {
  plates: PlateNode[];
  byMatch: Map<string, PlateNode>;
  connectors: Connector[];
  /** Where the trophy sits: just in front of the final. */
  podium: { x: number; y: number; z: number };
  bounds: { width: number; height: number; depth: number };
}

/**
 * Even spacing across a fixed span makes each parent land exactly on the midpoint
 * of its two children, which is the whole geometry of a bracket. Nothing else to do.
 */
function rowY(indexInHalf: number, countInHalf: number): number {
  return SPAN * ((indexInHalf + 0.5) / countInHalf - 0.5);
}

export function buildBracketLayout(draw: Draw): BracketLayout {
  const plates: PlateNode[] = [];
  const byMatch = new Map<string, PlateNode>();
  let index = 0;

  for (const round of draw.rounds) {
    const r = round.round;
    const depth = ROUNDS - r;
    const z = -depth * DEPTH_STEP;
    const total = round.matches.length;

    if (total === 1) {
      const node: PlateNode = {
        match: round.matches[0]!,
        round: r,
        side: 0,
        x: 0,
        y: 0,
        z,
        w: PLATE_W[r]!,
        h: PLATE_H[r]!,
        index: index++,
      };
      plates.push(node);
      byMatch.set(node.match.id, node);
      continue;
    }

    const half = total / 2;
    round.matches.forEach((match, i) => {
      const top = i < half;
      const side: -1 | 1 = top ? -1 : 1;
      const inHalf = top ? i : i - half;
      const node: PlateNode = {
        match,
        round: r,
        side,
        x: side * (CENTER_GAP + depth * COL_W),
        y: rowY(inHalf, half),
        z,
        w: PLATE_W[r]!,
        h: PLATE_H[r]!,
        index: index++,
      };
      plates.push(node);
      byMatch.set(match.id, node);
    });
  }

  const connectors: Connector[] = [];
  for (let r = 1; r < ROUNDS; r++) {
    const here = draw.rounds.find((x) => x.round === r);
    const next = draw.rounds.find((x) => x.round === r + 1);
    if (!here || !next) continue;
    here.matches.forEach((match, i) => {
      const parent = next.matches[Math.floor(i / 2)];
      const from = byMatch.get(match.id);
      const to = parent ? byMatch.get(parent.id) : undefined;
      if (from && to) connectors.push({ from, to, player: match.winner });
    });
  }

  const outermost = CENTER_GAP + (ROUNDS - 1) * COL_W;
  return {
    plates,
    byMatch,
    connectors,
    podium: { x: 0, y: SPAN / 2 - 9.4, z: 1.6 },
    bounds: { width: outermost * 2, height: SPAN, depth: (ROUNDS - 1) * DEPTH_STEP },
  };
}

/** The winner's route from their first-round plate to the final, in order. */
export function routeOf(layout: BracketLayout, draw: Draw, playerId: string): PlateNode[] {
  const out: PlateNode[] = [];
  for (const round of draw.rounds) {
    const match = round.matches.find((m) => m.sides.some((s) => s.player === playerId));
    if (!match) continue;
    const node = layout.byMatch.get(match.id);
    if (node) out.push(node);
    if (match.winner !== playerId) break;
  }
  return out;
}
