import { isDeepStrictEqual } from 'node:util';
import type {
  AcceptedDrawRevision,
  Match,
  ParsedDrawRevision,
  ReconciliationClassification,
  ReconciliationContext,
  ReconciliationResult,
} from '../shared/draw/contracts.js';
import {
  downstreamMatchIds,
  drawMatches,
  validateParsedDrawRevision,
} from '../shared/draw/validation.js';

function accept(
  candidate: ParsedDrawRevision,
  context: ReconciliationContext,
): AcceptedDrawRevision {
  return {
    ...candidate,
    acceptedAt: context.acceptedAt ?? new Date().toISOString(),
  };
}

function result(
  classification: ReconciliationClassification,
  canonical: AcceptedDrawRevision,
  diagnostics: string[] = [],
  invalidatedMatchIds: string[] = [],
  correctedMatchIds: string[] = [],
): ReconciliationResult {
  return { classification, canonical, diagnostics, invalidatedMatchIds, correctedMatchIds };
}

function byId(matches: Match[]): Map<string, Match> {
  return new Map(matches.map((match) => [match.id, match]));
}

function firstRoundEntrants(revision: ParsedDrawRevision): string[] {
  return revision.draw.rounds[0].matches.flatMap((match) => match.sides.map((side) => side.player));
}

function isNewerRevision(current: string, candidate: string): boolean {
  return BigInt(candidate) > BigInt(current);
}

export function reconcileDrawRevision(
  current: AcceptedDrawRevision,
  candidate: ParsedDrawRevision,
  context: ReconciliationContext,
): ReconciliationResult {
  const candidateDiagnostics = validateParsedDrawRevision(candidate);
  if (candidateDiagnostics.length > 0) {
    return result('conflicting', current, candidateDiagnostics.map((diagnostic) => `candidate ${diagnostic}`));
  }
  if (!/^\d+$/.test(current.revisionId)) {
    return result('conflicting', current, ['canonical source revision ID must be numeric']);
  }
  if (candidate.checksum === current.checksum) return result('unchanged', current);
  if (!isNewerRevision(current.revisionId, candidate.revisionId)) {
    return result('conflicting', current, ['candidate source revision is not newer than canonical']);
  }
  if (
    candidate.draw.id !== current.draw.id ||
    candidate.draw.bestOf !== current.draw.bestOf ||
    candidate.draw.source.wikipedia !== current.draw.source.wikipedia ||
    candidate.draw.source.url !== current.draw.source.url
  ) {
    return result('conflicting', current, ['candidate draw identity or source changed']);
  }

  const previousEntrants = firstRoundEntrants(current);
  const candidateEntrants = firstRoundEntrants(candidate);
  const changedSlots: number[] = [];
  for (let index = 0; index < previousEntrants.length; index += 1) {
    if (previousEntrants[index] !== candidateEntrants[index]) changedSlots.push(index);
  }
  if (changedSlots.length > 0) {
    if (context.locked) {
      return result('conflicting', current, [`${changedSlots.length} first-round slots changed after lock`]);
    }
    const invalidated = new Set<string>();
    for (const slot of changedSlots) {
      for (const id of downstreamMatchIds(1, Math.floor(slot / 2))) invalidated.add(id);
    }
    return result('structural_revision', accept(candidate, context), [], [...invalidated]);
  }

  const previousMatches = byId(drawMatches(current.draw));
  const candidateMatches = byId(drawMatches(candidate.draw));
  const regressions: string[] = [];
  const winnerChanges: string[] = [];
  const resultChanges: string[] = [];
  const advances: string[] = [];
  const changedMatches = new Set<string>();
  for (const [id, previous] of previousMatches) {
    const next = candidateMatches.get(id);
    if (!next) {
      regressions.push(`${id} disappeared`);
      continue;
    }
    if (!isDeepStrictEqual(previous, next)) changedMatches.add(id);
    if (previous.winner && !next.winner) regressions.push(`${id} dropped accepted winner ${previous.winner}`);
    else if (previous.winner && next.winner && previous.winner !== next.winner) winnerChanges.push(id);
    else if (previous.winner && next.winner && !isDeepStrictEqual(previous, next)) resultChanges.push(id);
    else if (!previous.winner && next.winner) advances.push(id);
  }
  if (regressions.length > 0) {
    return result('conflicting', current, regressions.map((message) => `winner conflict: ${message}`));
  }
  const attributableDownstream = new Set<string>();
  for (const id of winnerChanges) {
    const match = previousMatches.get(id);
    if (!match) continue;
    for (const downstream of downstreamMatchIds(match.round, match.position).slice(1)) {
      attributableDownstream.add(downstream);
    }
  }
  const rootWinnerChanges = winnerChanges.filter((id) => !attributableDownstream.has(id));
  const independentResultChanges = resultChanges.filter((id) => !attributableDownstream.has(id));
  const declaredCorrections = [...new Set([...rootWinnerChanges, ...independentResultChanges])];
  if (declaredCorrections.length > 0) {
    const declared = new Set(candidate.explicitCorrections);
    const undeclared = declaredCorrections.filter((id) => !declared.has(id));
    if (undeclared.length > 0) {
      return result('conflicting', current, [`winner changes lack explicit correction: ${undeclared.join(', ')}`]);
    }
    const correctionSpan = [...previousMatches.keys()].filter((id) => {
      if (declaredCorrections.includes(id)) return true;
      if (!changedMatches.has(id)) return false;
      return rootWinnerChanges.some((rootId) => {
        const root = previousMatches.get(rootId);
        return root ? downstreamMatchIds(root.round, root.position).slice(1).includes(id) : false;
      });
    });
    return result('correction', accept(candidate, context), [], [], correctionSpan);
  }
  if (advances.length > 0) return result('safe_advance', accept(candidate, context));
  return result('incomplete', current, ['revision contains no new verified terminal result']);
}
