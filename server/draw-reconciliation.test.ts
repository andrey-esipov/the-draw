import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AcceptedDrawRevision, Draw, DrawSourceRevisionInput, ParsedDrawRevision } from '../shared/draw/contracts.js';
import { parseMediaWikiRevision } from './draw-source.js';
import { reconcileDrawRevision } from './draw-reconciliation.js';

const root = process.cwd();
const fixtures = resolve(root, 'tools/fixtures/mediawiki');
const oracle = JSON.parse(readFileSync(resolve(root, 'public/draws/wimbledon-men.json'), 'utf8')) as Draw;

function parse(file: string, revisionId: string, explicitCorrections: string[] = []): ParsedDrawRevision {
  const input: DrawSourceRevisionInput = {
    draw: {
      id: oracle.id,
      tournament: oracle.tournament,
      year: oracle.year,
      event: oracle.event,
      surface: oracle.surface,
      venue: oracle.venue,
      city: oracle.city,
      bestOf: oracle.bestOf,
    },
    source: oracle.source,
    revisionId,
    fetchedAt: `2026-08-11T20:0${revisionId.slice(-1)}:00.000Z`,
    wikitext: readFileSync(resolve(fixtures, file), 'utf8'),
    explicitCorrections,
  };
  const result = parseMediaWikiRevision(input);
  if (!result.ok) throw new Error(result.diagnostics.join('\n'));
  return result.revision;
}

function accepted(revision: ParsedDrawRevision): AcceptedDrawRevision {
  return { ...revision, acceptedAt: '2026-08-11T20:10:00.000Z' };
}

describe('draw revision reconciliation', () => {
  it('does no canonical work for an unchanged checksum', () => {
    const current = accepted(parse('complete-wimbledon-men.wiki', '100'));
    const result = reconcileDrawRevision(current, { ...current, revisionId: '101' }, { locked: true });

    expect(result.classification).toBe('unchanged');
    expect(result.canonical).toBe(current);
  });

  it('accepts terminal advances from a partial revision', () => {
    const current = accepted(parse('partial-mid-round.wiki', '101'));
    const candidate = parse('complete-wimbledon-men.wiki', '102');
    const result = reconcileDrawRevision(current, candidate, { locked: true });

    expect(result.classification).toBe('safe_advance');
    expect(result.canonical.revisionId).toBe('102');
  });

  it('withholds a conflicting regression and preserves canonical identity', () => {
    const current = accepted(parse('complete-wimbledon-men.wiki', '100'));
    const candidate = parse('partial-mid-round.wiki', '101');
    const result = reconcileDrawRevision(current, candidate, { locked: true });

    expect(result.classification).toBe('conflicting');
    expect(result.canonical).toBe(current);
    expect(result.diagnostics.join(' ')).toContain('winner');
  });

  it('returns only the exact downstream match IDs for a pre-lock replacement', () => {
    const current = accepted(parse('complete-wimbledon-men.wiki', '100'));
    const candidate = parse('pre-lock-withdrawal.wiki', '103');
    const result = reconcileDrawRevision(current, candidate, { locked: false });

    expect(result.classification).toBe('structural_revision');
    expect(result.invalidatedMatchIds).toEqual([
      'r1m2',
      'r2m1',
      'r3m1',
      'r4m1',
      'r5m1',
      'r6m1',
      'r7m1',
    ]);
    expect(result.canonical.revisionId).toBe('103');
  });

  it('classifies an explicit correction once, then becomes checksum-idempotent', () => {
    const current = accepted(parse('complete-wimbledon-men.wiki', '100'));
    const corrected = parse('corrected-revision.wiki', '104', ['r1m2']);
    const first = reconcileDrawRevision(current, corrected, { locked: true });

    expect(first.classification).toBe('correction');
    expect(first.correctedMatchIds).toEqual(['r1m2', 'r2m1']);

    const second = reconcileDrawRevision(first.canonical, corrected, { locked: true });
    expect(second.classification).toBe('unchanged');
    expect(second.canonical).toBe(first.canonical);
  });

  it('withholds unmarked winner changes and structural changes after lock', () => {
    const current = accepted(parse('complete-wimbledon-men.wiki', '100'));
    const corrected = parse('corrected-revision.wiki', '104');
    const replacement = parse('pre-lock-withdrawal.wiki', '103');

    expect(reconcileDrawRevision(current, corrected, { locked: true }).classification).toBe('conflicting');
    expect(reconcileDrawRevision(current, replacement, { locked: true }).classification).toBe('conflicting');
  });

  it('withholds a stale source revision even when its payload differs', () => {
    const current = accepted(parse('partial-mid-round.wiki', '101'));
    const stale = parse('complete-wimbledon-men.wiki', '100');
    const result = reconcileDrawRevision(current, stale, { locked: true });

    expect(result.classification).toBe('conflicting');
    expect(result.canonical).toBe(current);
    expect(result.diagnostics).toContain('candidate source revision is not newer than canonical');
  });

  it('rejects malformed candidate lineage at the reconciliation boundary', () => {
    const current = accepted(parse('complete-wimbledon-men.wiki', '100'));
    const malformed = parse('complete-wimbledon-men.wiki', '101');
    malformed.draw.rounds[1].matches[0].sides[0].player = 'tristan-boyer';
    const result = reconcileDrawRevision(current, malformed, { locked: true });

    expect(result.classification).toBe('conflicting');
    expect(result.canonical).toBe(current);
    expect(result.diagnostics.join(' ')).toContain('impossible winner lineage');
  });

  it('rejects non-numeric revision IDs instead of ordering them lexicographically', () => {
    const current = accepted(parse('partial-mid-round.wiki', '101'));
    const candidate = { ...parse('complete-wimbledon-men.wiki', '102'), revisionId: 'next' };
    const result = reconcileDrawRevision(current, candidate, { locked: true });

    expect(result.classification).toBe('conflicting');
    expect(result.canonical).toBe(current);
    expect(result.diagnostics).toContain('candidate source revision ID must be numeric');
  });
});
