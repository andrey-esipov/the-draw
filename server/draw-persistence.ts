import type { Draw } from '../shared/draw/contracts.js';
import { drawMatches, validateDrawStructure } from '../shared/draw/validation.js';

export class DrawPersistenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrawPersistenceValidationError';
  }
}

export function validateDrawDraftForPersistence(
  draw: Draw,
  value: unknown,
): Record<string, string> {
  const drawDiagnostics = validateDrawStructure(draw);
  if (drawDiagnostics.length > 0) {
    throw new DrawPersistenceValidationError(`accepted draw is invalid: ${drawDiagnostics[0]}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DrawPersistenceValidationError('draft picks must be a JSON object');
  }

  const picks = value as Record<string, unknown>;
  const matches = new Set(drawMatches(draw).map((match) => match.id));
  const players = new Set(Object.keys(draw.players));
  const entries = Object.entries(picks);
  if (entries.length > 127) {
    throw new DrawPersistenceValidationError('draft picks exceed the 127-match limit');
  }
  for (const [matchId, playerId] of entries) {
    if (!matches.has(matchId)) {
      throw new DrawPersistenceValidationError(`draft names unknown match ${matchId}`);
    }
    if (typeof playerId !== 'string' || !players.has(playerId)) {
      throw new DrawPersistenceValidationError(`draft names unknown player for ${matchId}`);
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export function validateDrawRecapRound(round: number): number {
  if (!Number.isInteger(round) || round < 1 || round > 7) {
    throw new DrawPersistenceValidationError('recap round must be an integer from 1 through 7');
  }
  return round;
}

export function expectedDrawLeagueExpiry(completesAt: Date): Date {
  if (!Number.isFinite(completesAt.getTime())) {
    throw new DrawPersistenceValidationError('event completion time is invalid');
  }
  const expiry = new Date(completesAt);
  const day = expiry.getUTCDate();
  expiry.setUTCDate(1);
  expiry.setUTCMonth(expiry.getUTCMonth() + 13);
  const monthEnd = new Date(Date.UTC(
    expiry.getUTCFullYear(),
    expiry.getUTCMonth() + 1,
    0,
    expiry.getUTCHours(),
    expiry.getUTCMinutes(),
    expiry.getUTCSeconds(),
    expiry.getUTCMilliseconds(),
  )).getUTCDate();
  expiry.setUTCDate(Math.min(day, monthEnd));
  return expiry;
}

export function validateDrawLeagueExpiry(completesAt: Date, expiresAt: Date): Date {
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= completesAt) {
    throw new DrawPersistenceValidationError('league expiry must be after event completion');
  }
  const expected = expectedDrawLeagueExpiry(completesAt);
  if (expiresAt.getTime() !== expected.getTime()) {
    throw new DrawPersistenceValidationError('league expiry must be exactly 13 months after completion');
  }
  return expiresAt;
}
