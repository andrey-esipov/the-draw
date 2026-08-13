import type { Draw, Match, ParsedDrawRevision } from './contracts.js';

export const GRAND_SLAM_ROUND_SIZES = [64, 32, 16, 8, 4, 2, 1] as const;

export function downstreamMatchIds(round: number, position: number): string[] {
  const ids: string[] = [];
  let nextPosition = position;
  for (let nextRound = round; nextRound <= GRAND_SLAM_ROUND_SIZES.length; nextRound += 1) {
    ids.push(`r${nextRound}m${nextPosition + 1}`);
    nextPosition = Math.floor(nextPosition / 2);
  }
  return ids;
}

export function drawMatches(draw: Draw): Match[] {
  return draw.rounds.flatMap((round) => round.matches);
}

export function validateDrawStructure(draw: Draw): string[] {
  const diagnostics: string[] = [];
  const sizes = draw.rounds.map((round) => round.matches.length);
  if (
    sizes.length !== GRAND_SLAM_ROUND_SIZES.length ||
    sizes.some((size, index) => size !== GRAND_SLAM_ROUND_SIZES[index])
  ) {
    diagnostics.push(`round structure ${sizes.join(',')} does not match 64,32,16,8,4,2,1`);
    return diagnostics;
  }

  const matchIds = new Set<string>();
  for (const round of draw.rounds) {
    for (const match of round.matches) {
      if (matchIds.has(match.id)) diagnostics.push(`duplicate match slot ${match.id}`);
      matchIds.add(match.id);
      if (match.round !== round.round || match.id !== `r${round.round}m${match.position + 1}`) {
        diagnostics.push(`unstable match slot identity ${match.id}`);
      }
      if (match.sides.length > 2) diagnostics.push(`${match.id} has more than two slots`);
      const sideIds = match.sides.map((side) => side.player);
      if (new Set(sideIds).size !== sideIds.length) diagnostics.push(`${match.id} has duplicate player slots`);
      if (match.winner && !sideIds.includes(match.winner)) {
        diagnostics.push(`${match.id} winner ${match.winner} is not in its slots`);
      }
      if (match.winner && match.sides.length !== 2) {
        diagnostics.push(`${match.id} is terminal without two players`);
      }
    }
  }

  const entrants = draw.rounds[0].matches.flatMap((match) => match.sides.map((side) => side.player));
  if (entrants.length !== 128) diagnostics.push(`first round has ${entrants.length} filled slots, expected 128`);
  const entrantSet = new Set(entrants);
  if (entrantSet.size !== entrants.length) diagnostics.push('first round contains duplicate slot identities');

  for (let roundIndex = 1; roundIndex < draw.rounds.length; roundIndex += 1) {
    const previous = draw.rounds[roundIndex - 1].matches;
    for (const match of draw.rounds[roundIndex].matches) {
      const possible = [
        previous[match.position * 2]?.winner,
        previous[match.position * 2 + 1]?.winner,
      ].filter((winner): winner is string => winner !== null && winner !== undefined);
      for (const side of match.sides) {
        if (!possible.includes(side.player)) {
          diagnostics.push(`${match.id} has impossible winner lineage for ${side.player}`);
        }
      }
    }
  }
  return diagnostics;
}

export function validateParsedDrawRevision(revision: ParsedDrawRevision): string[] {
  const diagnostics = validateDrawStructure(revision.draw);
  if (!/^\d+$/.test(revision.revisionId)) diagnostics.unshift('source revision ID must be numeric');
  if (!/^[a-f0-9]{64}$/.test(revision.checksum)) diagnostics.push('source checksum must be a SHA-256 digest');
  if (!Number.isFinite(Date.parse(revision.fetchedAt))) diagnostics.push('source fetch timestamp is invalid');
  if (!revision.parserVersion.trim()) diagnostics.push('parser version is empty');

  const matches = drawMatches(revision.draw);
  const matchIds = new Set(matches.map((match) => match.id));
  for (const correction of revision.explicitCorrections) {
    if (!matchIds.has(correction)) diagnostics.push(`explicit correction names unknown match slot ${correction}`);
  }
  if (revision.complete !== matches.every((match) => match.winner !== null)) {
    diagnostics.push('revision completeness flag does not match terminal results');
  }
  return diagnostics;
}
