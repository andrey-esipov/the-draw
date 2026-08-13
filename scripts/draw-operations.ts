import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { AcceptedDrawRevision, Draw, DrawSourceRevisionInput } from '../shared/draw/contracts.js';
import { closeDatabase, db, runMigrations } from '../server/db.js';
import { createDrawIngestionWorker, pollDrawEvent } from '../server/draw-ingestion.js';
import {
  certifyDrawEvent,
  configureDrawEvent,
  drawDeploymentInvariants,
  drawSourceOperatorStatus,
  inspectDrawEvent,
  setDrawEventFlags,
} from '../server/draw-operations.js';
import { reconcileDrawRevision } from '../server/draw-reconciliation.js';
import { DRAW_PARSER_VERSION, parseMediaWikiRevision } from '../server/draw-source.js';
import { drawAcceptedRevisions, drawEventHeads, drawEvents } from '../server/schema.js';

function argumentsMap(values: string[]): { command: string; options: Map<string, string> } {
  const command = values[0] ?? '';
  const options = new Map<string, string>();
  for (let index = 1; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('options must use --name value pairs');
    }
    options.set(key.slice(2), value);
  }
  return { command, options };
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function boolean(options: Map<string, string>, name: string): boolean | undefined {
  const value = options.get(name);
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new Error(`--${name} must be true or false`);
  return value === 'true';
}

function date(options: Map<string, string>, name: string): Date {
  const value = new Date(required(options, name));
  if (!Number.isFinite(value.getTime())) throw new Error(`--${name} must be an ISO timestamp`);
  return value;
}

async function parsedFixture(
  file: string,
  revisionId: string,
  draw: Draw,
): Promise<ReturnType<typeof parseMediaWikiRevision>> {
  const input: DrawSourceRevisionInput = {
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
    fetchedAt: new Date().toISOString(),
    wikitext: await readFile(resolve('tools/fixtures/mediawiki', file), 'utf8'),
    explicitCorrections: [],
  };
  return parseMediaWikiRevision(input);
}

async function certifyLiveSource(slug: string, attribution: string, output: string) {
  const [event] = await db.select().from(drawEvents).where(eq(drawEvents.slug, slug)).limit(1);
  if (!event) throw new Error('draw event not found');
  if (!event.pollingEnabled) throw new Error('polling must be certified and enabled before live certification');
  const first = await pollDrawEvent(event.id);
  if (first.state !== 'accepted' && first.state !== 'unchanged') {
    throw new Error(`live source gate failed: ${first.state}`);
  }
  const second = await pollDrawEvent(event.id);
  if (second.state !== 'unchanged') throw new Error(`unchanged repoll failed: ${second.state}`);
  const [head] = await db.select({
    sourceRevisionId: drawAcceptedRevisions.sourceRevisionId,
    checksum: drawAcceptedRevisions.checksum,
    parserVersion: drawAcceptedRevisions.parserVersion,
    payload: drawAcceptedRevisions.payload,
  }).from(drawEventHeads).innerJoin(drawAcceptedRevisions, and(
    eq(drawAcceptedRevisions.eventId, drawEventHeads.eventId),
    eq(drawAcceptedRevisions.id, drawEventHeads.acceptedRevisionId),
  )).where(eq(drawEventHeads.eventId, event.id)).limit(1);
  if (!head) throw new Error('live source did not produce an accepted event head');
  const live = head.payload as AcceptedDrawRevision;
  const matchIds = live.draw.rounds.flatMap((round) => round.matches.map((match) => match.id));
  const expectedIds = [64, 32, 16, 8, 4, 2, 1].flatMap((size, round) => (
    Array.from({ length: size }, (_, match) => `r${round + 1}m${match + 1}`)
  ));
  if (matchIds.length !== 127 || matchIds.some((id, index) => id !== expectedIds[index])) {
    throw new Error('live source did not expose the 127 stable match identities');
  }
  if (head.parserVersion !== DRAW_PARSER_VERSION || !/^[a-f0-9]{64}$/.test(head.checksum)) {
    throw new Error('live parser version or checksum is invalid');
  }

  const oracle = JSON.parse(
    await readFile(resolve('public/draws/wimbledon-men.json'), 'utf8'),
  ) as Draw;
  const partial = await parsedFixture('partial-mid-round.wiki', '1001', oracle);
  const complete = await parsedFixture('complete-wimbledon-men.wiki', '1002', oracle);
  if (!partial.ok || !complete.ok) throw new Error('local positive control fixture failed to parse');
  const safeAdvance = reconcileDrawRevision(
    { ...partial.revision, acceptedAt: new Date().toISOString() },
    complete.revision,
    { locked: true },
  );
  if (safeAdvance.classification !== 'safe_advance') {
    throw new Error(`positive safe-advance control failed: ${safeAdvance.classification}`);
  }
  const conflict = reconcileDrawRevision(
    safeAdvance.canonical,
    { ...complete.revision, revisionId: '1003', checksum: 'f'.repeat(64), draw: { ...complete.revision.draw, id: 'unsupported' } },
    { locked: true },
  );
  const unsupported = parseMediaWikiRevision({
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
    revisionId: '1004',
    fetchedAt: new Date().toISOString(),
    wikitext: '{{unsupported',
    explicitCorrections: [],
  });
  if (conflict.classification !== 'conflicting' || unsupported.ok) {
    throw new Error('negative unsupported/conflict withholding control failed');
  }
  const certificate = {
    contractVersion: 1,
    liveSourcePassed: true,
    fixtureOnly: false,
    eventSlug: event.slug,
    sourcePage: event.sourcePage,
    sourceRevisionId: head.sourceRevisionId,
    parserVersion: head.parserVersion,
    checksum: head.checksum,
    stableMatchIdentities: matchIds.length,
    attribution,
    unchangedRepoll: true,
    safeAdvanceControl: true,
    unsupportedWithheld: true,
    conflictWithheld: true,
    observedAt: new Date().toISOString(),
  };
  await writeFile(resolve(output), `${JSON.stringify(certificate, null, 2)}\n`, { mode: 0o600 });
  return certificate;
}

async function main() {
  await runMigrations();
  const { command, options } = argumentsMap(process.argv.slice(2));
  const actor = options.get('actor') ?? '';
  const reason = options.get('reason') ?? '';
  if (command === 'configure') {
    const eventKind = required(options, 'event-kind');
    if (eventKind !== 'mens_singles' && eventKind !== 'womens_singles') {
      throw new Error('--event-kind must be mens_singles or womens_singles');
    }
    const surface = required(options, 'surface');
    if (surface !== 'Hard' && surface !== 'Clay' && surface !== 'Grass') {
      throw new Error('--surface must be Hard, Clay, or Grass');
    }
    const event = await configureDrawEvent({
      slug: required(options, 'slug'),
      drawId: required(options, 'draw-id'),
      tournament: required(options, 'tournament'),
      tournamentYear: Number(required(options, 'year')),
      eventKind,
      surface,
      venue: required(options, 'venue'),
      city: required(options, 'city'),
      sourcePage: required(options, 'source-page'),
      lockAt: date(options, 'lock-at'),
      completesAt: date(options, 'completes-at'),
    }, { actor, reason });
    console.log(JSON.stringify({
      command,
      slug: event.slug,
      pollingEnabled: event.pollingEnabled,
      creationEnabled: event.creationEnabled,
      audited: true,
    }));
    return;
  }
  if (command === 'certify') {
    const event = await certifyDrawEvent(required(options, 'slug'), {
      actor,
      reason,
      pollingEnabled: boolean(options, 'polling-enabled') ?? true,
    });
    console.log(JSON.stringify({
      command,
      slug: event.slug,
      pollingEnabled: event.pollingEnabled,
      creationEnabled: event.creationEnabled,
      audited: true,
    }));
    return;
  }
  if (command === 'flags') {
    const event = await setDrawEventFlags(required(options, 'slug'), {
      pollingEnabled: boolean(options, 'polling-enabled'),
      creationEnabled: boolean(options, 'creation-enabled'),
    }, { actor, reason });
    console.log(JSON.stringify({
      command,
      slug: event.slug,
      pollingEnabled: event.pollingEnabled,
      creationEnabled: event.creationEnabled,
      audited: true,
    }));
    return;
  }
  if (command === 'poll') {
    const slug = options.get('slug');
    if (slug) {
      const [event] = await db.select({ id: drawEvents.id }).from(drawEvents)
        .where(eq(drawEvents.slug, slug))
        .limit(1);
      if (!event) throw new Error('draw event not found');
      console.log(JSON.stringify(await pollDrawEvent(event.id)));
    } else {
      console.log(JSON.stringify(await createDrawIngestionWorker().run()));
    }
    return;
  }
  if (command === 'inspect') {
    const result = await inspectDrawEvent(required(options, 'slug'));
    console.log(JSON.stringify(result));
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(await drawSourceOperatorStatus()));
    return;
  }
  if (command === 'invariants') {
    const report = await drawDeploymentInvariants();
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === 'certify-live') {
    console.log(JSON.stringify(await certifyLiveSource(
      required(options, 'slug'),
      required(options, 'attribution'),
      required(options, 'output'),
    )));
    return;
  }
  throw new Error(
    'usage: draw:operations <configure|certify|certify-live|flags|poll|inspect|invariants|status> [--name value]',
  );
}

main()
  .catch((error) => {
    console.error('[draw-operations] failed:', error instanceof Error ? error.message : 'unknown');
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
