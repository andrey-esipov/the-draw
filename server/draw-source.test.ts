import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { Draw, DrawSourceRevisionInput } from '../shared/draw/contracts.js';
import { drawEventSourceIdentityConfigured, parseMediaWikiRevision } from './draw-source.js';

const fixtures = resolve(process.cwd(), 'tools/fixtures/mediawiki');
const oracle = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/draws/wimbledon-men.json'), 'utf8'),
) as Draw;
const womenOracle = JSON.parse(
  readFileSync(resolve(fixtures, 'complete-wimbledon-women.oracle.json'), 'utf8'),
) as Draw;

function inputFor(
  draw: Draw,
  file: string,
  revisionId: string,
  explicitCorrections: string[] = [],
): DrawSourceRevisionInput {
  return {
    draw: {
      id: draw.id,
      tournament: draw.tournament,
      year: draw.year,
      event: draw.event,
      surface: draw.surface,
      venue: draw.venue,
      city: draw.city,
      bestOf: draw.bestOf,
    },
    source: draw.source,
    revisionId,
    fetchedAt: '2026-08-11T20:00:00.000Z',
    wikitext: readFileSync(resolve(fixtures, file), 'utf8'),
    explicitCorrections,
  };
}

function input(file: string, revisionId: string, explicitCorrections: string[] = []): DrawSourceRevisionInput {
  return inputFor(oracle, file, revisionId, explicitCorrections);
}

function parsed(file: string, revisionId: string, explicitCorrections: string[] = []) {
  const result = parseMediaWikiRevision(input(file, revisionId, explicitCorrections));
  expect(result.ok, result.ok ? undefined : result.diagnostics.join('\n')).toBe(true);
  if (!result.ok) throw new Error(result.diagnostics.join('\n'));
  return result.revision;
}

describe('MediaWiki draw source qualification', () => {
  it('matches the completed Python-oracle draw, including retirements and walkovers', () => {
    const revision = parsed('complete-wimbledon-men.wiki', '100');
    const matches = revision.draw.rounds.flatMap((round) => round.matches);
    const oracleMatches = oracle.rounds.flatMap((round) => round.matches);

    expect(revision.draw.players).toEqual(oracle.players);
    expect(revision.draw.rounds.map((round) => round.matches.length)).toEqual([64, 32, 16, 8, 4, 2, 1]);
    expect(matches).toHaveLength(127);
    expect(matches.map(({ id, winner, sides }) => ({ id, winner, sides }))).toEqual(
      oracleMatches.map(({ id, winner, sides }) => ({ id, winner, sides })),
    );
    expect(matches.filter((match) => match.terminal === 'retirement')).toHaveLength(5);
    expect(matches.filter((match) => match.terminal === 'walkover')).toHaveLength(0);
    expect(matches.filter((match) => match.winner)).toHaveLength(127);
  });

  it('keeps the Python builder as an executable completed-draw parity oracle', () => {
    const output = execFileSync(
      'python3',
      [
        'tools/build_draw.py',
        '--slam',
        'wimbledon-men',
        '--wikitext',
        'tools/fixtures/mediawiki/complete-wimbledon-men.wiki',
        '--compare',
        'public/draws/wimbledon-men.json',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(output).toContain('completed draw matches');
  });

  it('qualifies a complete best-of-three women format against its Python oracle contract', () => {
    const result = parseMediaWikiRevision(inputFor(womenOracle, 'complete-wimbledon-women.wiki', '200'));
    expect(result.ok, result.ok ? undefined : result.diagnostics.join('\n')).toBe(true);
    if (!result.ok) throw new Error(result.diagnostics.join('\n'));

    expect(result.revision.draw.bestOf).toBe(3);
    expect(result.revision.draw.players).toEqual(womenOracle.players);
    expect(result.revision.draw.rounds.map((round) => round.matches.length)).toEqual([64, 32, 16, 8, 4, 2, 1]);
    expect(result.revision.draw.rounds.flatMap((round) => round.matches).every(
      (match) => match.sides.every((side) => side.sets.length <= 3),
    )).toBe(true);
    expect(result.revision.draw.rounds.flatMap((round) => round.matches).map(
      ({ id, winner, sides }) => ({ id, winner, sides }),
    )).toEqual(womenOracle.rounds.flatMap((round) => round.matches).map(
      ({ id, winner, sides }) => ({ id, winner, sides }),
    ));

    const output = execFileSync(
      'python3',
      [
        'tools/build_draw.py',
        '--slam',
        'wimbledon-women',
        '--wikitext',
        'tools/fixtures/mediawiki/complete-wimbledon-women.wiki',
        '--compare',
        'tools/fixtures/mediawiki/complete-wimbledon-women.oracle.json',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(output).toContain('completed draw matches');
  });

  it('requires an explicit retirement before one best-of-three winning set is terminal', () => {
    const base = inputFor(womenOracle, 'complete-wimbledon-women.wiki', '201');
    const oneSet = base.wikitext.replace("|RD1-score01-2='''6'''", '|RD1-score01-2=');
    const retired = parseMediaWikiRevision({ ...base, wikitext: oneSet.replace('|RD1-team02=', '|RD1-status1=retired\n|RD1-team02=') });
    expect(retired.ok, retired.ok ? undefined : retired.diagnostics.join('\n')).toBe(true);
    if (!retired.ok) throw new Error(retired.diagnostics.join('\n'));
    expect(retired.revision.draw.rounds[0].matches[0].terminal).toBe('retirement');

    const unresolved = parseMediaWikiRevision({
      ...base,
      revisionId: '202',
      wikitext: ['RD2-team01', 'RD3-team01', 'RD4-team01', 'RD1-team1', 'RD2-team1', 'RD3-team1']
        .reduce((wiki, key) => wiki.replace(new RegExp(`^\\|${key}=.*$`, 'm'), `|${key}=`), oneSet),
    });
    expect(unresolved.ok, unresolved.ok ? undefined : unresolved.diagnostics.join('\n')).toBe(true);
    if (!unresolved.ok) throw new Error(unresolved.diagnostics.join('\n'));
    expect(unresolved.revision.draw.rounds[0].matches[0]).toMatchObject({
      winner: null,
      terminal: 'incomplete',
    });
  });

  it('preserves unresolved slots and withholds suspended results', () => {
    const partial = parsed('partial-mid-round.wiki', '101');
    const suspended = parsed('suspended.wiki', '102');
    const partialMatches = partial.draw.rounds.flatMap((round) => round.matches);
    const suspendedFirst = suspended.draw.rounds[0].matches[0];

    expect(partial.complete).toBe(false);
    expect(partialMatches.filter((match) => match.winner).length).toBeGreaterThan(64);
    expect(partialMatches.filter((match) => match.winner).length).toBeLessThan(127);
    expect(partialMatches.some((match) => match.sides.length === 0 && match.winner === null)).toBe(true);
    expect(suspendedFirst.sides).toHaveLength(2);
    expect(suspendedFirst.sides.every((side) => side.sets.length === 0)).toBe(true);
    expect(suspendedFirst.winner).toBeNull();
    expect(suspendedFirst.terminal).toBe('incomplete');
  });

  it('recognizes retirement and walkover terminality without inventing set winners', () => {
    const retirement = parsed('complete-wimbledon-men.wiki', '100').draw.rounds[0].matches[5];
    const walkover = parsed('walkover.wiki', '105').draw.rounds[0].matches[0];

    expect(retirement.terminal).toBe('retirement');
    expect(walkover.terminal).toBe('walkover');
    expect(walkover.winner).toBe('jannik-sinner');
    expect(walkover.sides.every((side) => side.sets.length === 0)).toBe(true);
  });

  it('does not promote a bold scoreless player without an explicit walkover signal', () => {
    const candidate = input('walkover.wiki', '106');
    candidate.wikitext = ['RD2-team01', 'RD3-team01', 'RD4-team01', 'RD1-team1', 'RD2-team1', 'RD3-team1']
      .reduce(
        (wiki, key) => wiki.replace(new RegExp(`^\\|${key}=.*$`, 'm'), `|${key}=`),
        candidate.wikitext.replace('|RD1-status1=walkover\n', ''),
      );
    const result = parseMediaWikiRevision(candidate);

    expect(result.ok, result.ok ? undefined : result.diagnostics.join('\n')).toBe(true);
    if (!result.ok) throw new Error(result.diagnostics.join('\n'));
    expect(result.revision.draw.rounds[0].matches[0]).toMatchObject({
      winner: null,
      terminal: 'incomplete',
    });
  });

  it('fails closed when the declared best-of format does not match the wikitext templates', () => {
    const candidate = input('complete-wimbledon-men.wiki', '107');
    candidate.draw.bestOf = 3;
    const result = parseMediaWikiRevision(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.join(' ')).toMatch(/bracket format.*bestOf 3/i);
  });

  it('fails closed on non-numeric revision IDs and unknown correction slots', () => {
    const invalidRevision = parseMediaWikiRevision(input('complete-wimbledon-men.wiki', 'revision-ten'));
    expect(invalidRevision.ok).toBe(false);
    if (!invalidRevision.ok) expect(invalidRevision.diagnostics).toContain('source revision ID must be numeric');

    const invalidCorrection = parseMediaWikiRevision(input('complete-wimbledon-men.wiki', '108', ['r8m1']));
    expect(invalidCorrection.ok).toBe(false);
    if (!invalidCorrection.ok) {
      expect(invalidCorrection.diagnostics).toContain('explicit correction names unknown match slot r8m1');
    }
  });

  it.each([
    ['malformed template', (wiki: string) => wiki.replace(/\}\}\s*$/, '')],
    [
      'duplicate first-round slot',
      (wiki: string) =>
        wiki.replace(
          '{{flagicon|SRB}} [[Miomir Kecmanović|M Kecmanović]]',
          '{{flagicon|ITA}} [[Jannik Sinner|J Sinner]]',
        ),
    ],
    [
      'impossible winner lineage',
      (wiki: string) =>
        wiki.replace(
          "|RD2-team01='''{{flagicon|ITA}} [[Jannik Sinner|J Sinner]]'''",
          "|RD2-team01='''{{flagicon|USA}} [[Tristan Boyer|T Boyer]]'''",
        ),
    ],
    [
      'unsupported structural drift',
      (wiki: string) => wiki.replace(/\{\{16TeamBracket-Compact-Tennis5[\s\S]*?\n\}\}\n/, ''),
    ],
    ['malformed score', (wiki: string) => wiki.replace('|RD1-score01-1=4', '|RD1-score01-1=not-a-score')],
  ])('fails closed on %s with diagnostic context', (_name, mutate) => {
    const candidate = input('complete-wimbledon-men.wiki', '999');
    candidate.wikitext = mutate(candidate.wikitext);
    const result = parseMediaWikiRevision(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics.join(' ')).toMatch(/template|slot|lineage|round|brace|score/i);
    }
  });

  it('rejects a non-allowlisted source before it can become authoritative', () => {
    const candidate = input('complete-wimbledon-men.wiki', 'bad-source');
    candidate.source = { ...candidate.source, url: 'http://example.com/wiki/draw' };
    const result = parseMediaWikiRevision(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toContain('source URL is not an allowlisted HTTPS MediaWiki page');
  });

  it('keeps the shared boundary React-free and prohibits application cross-imports', () => {
    const sharedSource = [
      readFileSync(resolve(process.cwd(), 'shared/draw/contracts.ts'), 'utf8'),
      readFileSync(resolve(process.cwd(), 'shared/draw/validation.ts'), 'utf8'),
    ].join('\n');
    const serverSource = readFileSync(resolve(process.cwd(), 'server/draw-source.ts'), 'utf8');
    const drawTypes = readFileSync(resolve(process.cwd(), 'src/data/types.ts'), 'utf8');

    expect(sharedSource).not.toMatch(/from ['"](?:react|react-dom|.*server\/|.*draw\/src)/);
    expect(serverSource).not.toMatch(/from ['"].*draw\/src/);
    expect(drawTypes).not.toMatch(/from ['"].*server\//);
  });

  describe('drawEventSourceIdentityConfigured', () => {
    const real = { surface: 'Grass', venue: 'All England Club', city: 'London' };

    it('is unconfigured when any placeholder field is still the operator-pending sentinel', () => {
      expect(drawEventSourceIdentityConfigured(real)).toBe(true);
      expect(drawEventSourceIdentityConfigured({ ...real, surface: 'Unknown' })).toBe(false);
      expect(drawEventSourceIdentityConfigured({ ...real, venue: 'Unconfigured' })).toBe(false);
      expect(drawEventSourceIdentityConfigured({ ...real, city: 'Unconfigured' })).toBe(false);
    });

    it('is the single source of truth both operator actions and the poller rely on', () => {
      // Item 13 parity guard: draw-operations.ts (certification, flag toggles) and
      // draw-ingestion.ts (the polling worker) must both call this shared helper
      // instead of re-implementing the surface/venue/city sentinel check inline,
      // so the two call sites cannot drift out of sync with each other.
      const operationsSource = readFileSync(resolve(process.cwd(), 'server/draw-operations.ts'), 'utf8');
      const ingestionSource = readFileSync(resolve(process.cwd(), 'server/draw-ingestion.ts'), 'utf8');

      expect(operationsSource).toMatch(/import\s*\{[^}]*\bdrawEventSourceIdentityConfigured\b[^}]*\}\s*from\s*['"]\.\/draw-source\.js['"]/);
      expect(ingestionSource).toMatch(/import\s*\{[^}]*\bdrawEventSourceIdentityConfigured\b[^}]*\}\s*from\s*['"]\.\/draw-source\.js['"]/);

      // Neither call site should still carry its own inline copy of the sentinel check.
      expect(operationsSource).not.toMatch(/===\s*['"]Unknown['"]\s*\n?\s*\|\|/);
      expect(ingestionSource).not.toMatch(/===\s*['"]Unknown['"]\s*\n?\s*\|\|/);
    });
  });
});
