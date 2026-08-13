import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { and, eq, gte, lte } from 'drizzle-orm';
import type {
  AcceptedDrawRevision,
  DrawSourceRevisionInput,
  ParsedDrawRevision,
  ReconciliationClassification,
} from '../shared/draw/contracts.js';
import { db } from './db.js';
import {
  DRAW_SOURCE_DEADLINE_MS,
  DRAW_SOURCE_MAXLAG_SECONDS,
  DRAW_SOURCE_USER_AGENT,
  DRAW_SOURCE_WORKER_ENABLED,
} from './env.js';
import { reconcileDrawRevision } from './draw-reconciliation.js';
import { DRAW_PARSER_VERSION, MAX_WIKITEXT_BYTES, parseMediaWikiRevision } from './draw-source.js';
import {
  drawAcceptedRevisions,
  drawEventHeads,
  drawEvents,
} from './schema.js';

type DrawDatabase = typeof db;
type FetchInit = RequestInit & { dispatcher?: unknown };
export type DrawSourceFetch = (input: string | URL, init?: FetchInit) => Promise<Response>;
export type DrawSourceLookup = (hostname: string) => Promise<string[]>;

const MEDIAWIKI_HOST = 'en.wikipedia.org';
const MEDIAWIKI_API_PATH = '/w/api.php';
const MAX_REDIRECTS = 3;
const MAX_COMPRESSED_BYTES = 512 * 1024;
const MAX_EXPANDED_BYTES = MAX_WIKITEXT_BYTES + 256 * 1024;
const MAX_NESTING = 64;
const MAX_FAILURE_LENGTH = 500;

export interface DrawIngestionDependencies {
  database?: DrawDatabase;
  fetch?: DrawSourceFetch;
  lookup?: DrawSourceLookup;
  now?: () => Date;
  monotonicNow?: () => number;
  userAgent?: string;
  deadlineMs?: number;
  maxlagSeconds?: number;
  projectAccepted?: (eventId: string, revisionId: string) => Promise<void>;
}

export interface DrawPollResult {
  eventId: string;
  state: 'accepted' | 'unchanged' | 'delayed' | 'skipped';
  revisionId?: string;
  classification?: ReconciliationClassification | 'initial';
  delayCode?: string;
  retryAfterMs?: number;
  projectionLag?: boolean;
}

function boundedFailure(error: unknown): string {
  const value = error instanceof Error ? error.message : 'unknown_source_failure';
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_FAILURE_LENGTH);
}

function sourceFailure(
  code: string,
  detail: string,
  retryAfterMs?: number,
): Error & { code: string; retryAfterMs?: number } {
  const error = new Error(detail) as Error & { code: string; retryAfterMs?: number };
  error.code = code;
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return error;
}

function isMediaWikiMaxlag(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { error?: unknown }).error
    && typeof (value as { error: unknown }).error === 'object'
    && ((value as { error: { code?: unknown } }).error.code === 'maxlag'),
  );
}

function hasValidRetryAfter(response: Response): boolean {
  const value = response.headers.get('retry-after');
  if (!value) return false;
  return /^\d+$/.test(value) || Number.isFinite(Date.parse(value));
}

function retryAfterMs(response: Response, now: Date): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now.getTime()) : undefined;
}

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && [0, 2, 168].includes(b))
      || (a === 198 && [18, 19, 51].includes(b))
      || (a === 203 && b === 0)
      || a >= 224
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice('::ffff:'.length);
      if (isIP(mapped) === 4) return isPublicAddress(mapped);
      const words = mapped.split(':');
      if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) {
        const high = Number.parseInt(words[0], 16);
        const low = Number.parseInt(words[1], 16);
        return isPublicAddress([
          high >> 8,
          high & 255,
          low >> 8,
          low & 255,
        ].join('.'));
      }
      return false;
    }
    return !(
      normalized === '::'
      || normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith('ff')
      || normalized.startsWith('2001:db8:')
    );
  }
  return false;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function validatedApiUrl(value: string | URL): URL {
  const url = new URL(String(value));
  if (
    url.protocol !== 'https:'
    || url.hostname !== MEDIAWIKI_HOST
    || url.port
    || url.username
    || url.password
    || url.pathname !== MEDIAWIKI_API_PATH
  ) {
    throw sourceFailure('source_redirect_rejected', 'source redirect left the allowlisted MediaWiki API');
  }
  return url;
}

async function readBoundedUtf8(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    throw sourceFailure('source_content_type', 'source response was not application/json');
  }
  const contentLength = Number(response.headers.get('content-length'));
  const rawContentEncoding = response.headers.get('content-encoding')?.toLowerCase();
  const contentEncoding = rawContentEncoding && rawContentEncoding !== 'identity'
    ? rawContentEncoding
    : null;
  if (Number.isFinite(contentLength) && contentLength > (
    contentEncoding ? MAX_COMPRESSED_BYTES : MAX_EXPANDED_BYTES
  )) {
    throw sourceFailure(
      contentEncoding ? 'source_compressed_size' : 'source_expanded_size',
      'source response exceeded the byte limit',
    );
  }
  if (contentEncoding && !Number.isFinite(contentLength)) {
    throw sourceFailure('source_compressed_size', 'compressed source response omitted a bounded content length');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_EXPANDED_BYTES) {
      await reader.cancel();
      throw sourceFailure('source_expanded_size', 'source expanded response exceeded the byte limit');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw sourceFailure('source_encoding', 'source response was not valid UTF-8');
  }
}

async function fetchJson(
  initialUrl: URL,
  headers: Headers,
  dependencies: Required<Pick<DrawIngestionDependencies, 'fetch' | 'lookup'>>,
  deadlineMs: number,
  now: Date,
): Promise<{ value: unknown; headers: Headers; status: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deadlineMs);
  timeout.unref();
  let url = initialUrl;
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const validated = validatedApiUrl(url);
      const addresses = await dependencies.lookup(validated.hostname);
      if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
        throw sourceFailure('source_network_rejected', 'source host resolved to a non-public network');
      }
      const pinnedAddress = addresses[0];
      const dispatcher = new Agent({
        connect: {
          lookup: (_hostname, _options, callback) => {
            callback(null, pinnedAddress, isIP(pinnedAddress));
          },
        },
      });
      let response: Response;
      try {
        response = await Promise.race([
          dependencies.fetch(validated, {
            headers,
            redirect: 'manual',
            signal: controller.signal,
            dispatcher,
          }),
          new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => {
              reject(sourceFailure('source_timeout', 'source response exceeded the deadline'));
            }, { once: true });
          }),
        ]);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirect === MAX_REDIRECTS) {
            throw sourceFailure('source_redirect_limit', 'source redirect limit exceeded');
          }
          const location = response.headers.get('location');
          if (!location) throw sourceFailure('source_redirect_rejected', 'source redirect omitted location');
          url = validatedApiUrl(new URL(location, validated));
          continue;
        }
        if (response.status === 304) return { value: null, headers: response.headers, status: 304 };
        if (response.status === 503 && hasValidRetryAfter(response)) {
          throw sourceFailure(
            'source_maxlag',
            'MediaWiki requested a maxlag retry',
            retryAfterMs(response, now),
          );
        }
        if (!response.ok) {
          throw sourceFailure(
            response.status === 429 ? 'source_rate_limited' : 'source_http_error',
            `source returned HTTP ${response.status}`,
            response.status === 429 ? retryAfterMs(response, now) : undefined,
          );
        }
        const text = await readBoundedUtf8(response);
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          throw sourceFailure('source_malformed', 'source response was not valid JSON');
        }
        if (isMediaWikiMaxlag(value)) {
          throw sourceFailure('source_maxlag', 'MediaWiki requested a maxlag retry');
        }
        return { value, headers: response.headers, status: response.status };
      } finally {
        await dispatcher.close();
      }
    }
    throw sourceFailure('source_redirect_limit', 'source redirect limit exceeded');
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof Error && 'code' in error)) {
      throw sourceFailure('source_timeout', 'source response exceeded the deadline');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

type MediaWikiRevision = {
  revid: number;
  timestamp: string;
  comment?: string;
  slots?: { main?: { content?: string; '*'?: string } };
  '*'?: string;
};

function mediaWikiRevision(value: unknown): MediaWikiRevision {
  if (!value || typeof value !== 'object') throw sourceFailure('source_malformed', 'source query body was malformed');
  const query = (value as { query?: unknown }).query;
  if (!query || typeof query !== 'object') throw sourceFailure('source_malformed', 'source query omitted query');
  const pagesValue = (query as { pages?: unknown }).pages;
  const pages = Array.isArray(pagesValue)
    ? pagesValue
    : pagesValue && typeof pagesValue === 'object'
      ? Object.values(pagesValue)
      : [];
  const revision = (pages[0] as { revisions?: unknown } | undefined)?.revisions;
  const candidate = Array.isArray(revision) ? revision[0] : undefined;
  if (!candidate || typeof candidate !== 'object') {
    throw sourceFailure('source_malformed', 'source query omitted revision identity');
  }
  const typed = candidate as MediaWikiRevision;
  if (!Number.isSafeInteger(typed.revid) || !Number.isFinite(Date.parse(typed.timestamp))) {
    throw sourceFailure('source_malformed', 'source revision identity was invalid');
  }
  return typed;
}

function revisionContent(revision: MediaWikiRevision): string {
  const value = revision.slots?.main?.content
    ?? revision.slots?.main?.['*']
    ?? revision['*'];
  if (typeof value !== 'string') throw sourceFailure('source_malformed', 'immutable revision omitted wikitext');
  if (Buffer.byteLength(value, 'utf8') > MAX_WIKITEXT_BYTES) {
    throw sourceFailure('source_expanded_size', 'wikitext exceeded the parser byte limit');
  }
  let depth = 0;
  let maximum = 0;
  for (let index = 0; index < value.length - 1; index += 1) {
    const token = value.slice(index, index + 2);
    if (token === '{{') {
      depth += 1;
      maximum = Math.max(maximum, depth);
      index += 1;
    } else if (token === '}}') {
      depth = Math.max(0, depth - 1);
      index += 1;
    }
    if (maximum > MAX_NESTING) {
      throw sourceFailure('source_parser_work', 'wikitext nesting exceeded the parser-work limit');
    }
  }
  return value;
}

function pageTitle(sourcePage: string): string {
  const source = new URL(sourcePage);
  if (source.protocol !== 'https:' || source.hostname !== MEDIAWIKI_HOST || !source.pathname.startsWith('/wiki/')) {
    throw sourceFailure('source_page_rejected', 'event source page is outside the allowlist');
  }
  return decodeURIComponent(source.pathname.slice('/wiki/'.length)).replace(/_/g, ' ');
}

function sourceInput(
  event: typeof drawEvents.$inferSelect,
  revision: MediaWikiRevision,
): DrawSourceRevisionInput {
  const sourceName = pageTitle(event.sourcePage);
  const corrections = [...new Set(revision.comment?.match(/\br[1-7]m\d+\b/gi) ?? [])]
    .map((match) => match.toLowerCase());
  return {
    draw: {
      id: event.drawId,
      tournament: event.tournament,
      year: event.tournamentYear,
      event: event.eventKind === 'mens_singles' ? 'Men’s Singles' : 'Women’s Singles',
      surface: event.surface as 'Hard' | 'Clay' | 'Grass',
      venue: event.venue,
      city: event.city,
      bestOf: event.eventKind === 'mens_singles' ? 5 : 3,
    },
    source: { wikipedia: sourceName, url: event.sourcePage },
    revisionId: String(revision.revid),
    fetchedAt: revision.timestamp,
    wikitext: revisionContent(revision),
    explicitCorrections: corrections,
  };
}

async function currentAcceptedRevision(
  eventId: string,
  database: DrawDatabase,
): Promise<AcceptedDrawRevision | null> {
  const [row] = await database.select({ payload: drawAcceptedRevisions.payload })
    .from(drawEventHeads)
    .innerJoin(drawAcceptedRevisions, and(
      eq(drawAcceptedRevisions.eventId, drawEventHeads.eventId),
      eq(drawAcceptedRevisions.id, drawEventHeads.acceptedRevisionId),
    ))
    .where(eq(drawEventHeads.eventId, eventId))
    .limit(1);
  return row?.payload as AcceptedDrawRevision | null ?? null;
}

async function recordFailure(
  eventId: string,
  database: DrawDatabase,
  now: Date,
  error: unknown,
): Promise<DrawPollResult> {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'source_failure';
  await database.update(drawEvents).set({
    lastAttemptAt: now,
    delayCode: code,
    failureCode: boundedFailure(error),
    updatedAt: now,
  }).where(eq(drawEvents.id, eventId));
  const retry = error instanceof Error && 'retryAfterMs' in error && typeof error.retryAfterMs === 'number'
    ? error.retryAfterMs
    : undefined;
  return { eventId, state: 'delayed', delayCode: code, retryAfterMs: retry };
}

export async function pollDrawEvent(
  eventId: string,
  input: DrawIngestionDependencies = {},
): Promise<DrawPollResult> {
  const database = input.database ?? db;
  const now = input.now?.() ?? new Date();
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const deadlineMs = input.deadlineMs ?? DRAW_SOURCE_DEADLINE_MS;
  const startedAt = monotonicNow();
  const dependencies = {
    fetch: input.fetch ?? (globalThis.fetch as DrawSourceFetch),
    lookup: input.lookup ?? defaultLookup,
  };
  try {
    const [event] = await database.select().from(drawEvents).where(eq(drawEvents.id, eventId)).limit(1);
    if (!event || !event.pollingEnabled || now < event.createdAt || now > event.completesAt) {
      return { eventId, state: 'skipped' };
    }
    if (
      event.surface === 'Unknown'
      || event.venue === 'Unconfigured'
      || event.city === 'Unconfigured'
    ) {
      throw sourceFailure('source_identity_unconfigured', 'event source identity requires operator configuration');
    }
    const title = pageTitle(event.sourcePage);
    const current = await currentAcceptedRevision(event.id, database);
    const metadataUrl = new URL(`https://${MEDIAWIKI_HOST}${MEDIAWIKI_API_PATH}`);
    metadataUrl.search = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      prop: 'revisions',
      titles: title,
      rvprop: 'ids|timestamp|comment',
      rvlimit: '1',
      maxlag: String(input.maxlagSeconds ?? DRAW_SOURCE_MAXLAG_SECONDS),
    }).toString();
    const headers = new Headers({
      accept: 'application/json',
      'accept-encoding': 'identity',
      'user-agent': input.userAgent ?? DRAW_SOURCE_USER_AGENT,
    });
    if (event.lastSuccessfulAt) headers.set('if-modified-since', event.lastSuccessfulAt.toUTCString());
    const metadataResponse = await fetchJson(metadataUrl, headers, dependencies, deadlineMs, now);
    if (metadataResponse.status === 304) {
      await database.update(drawEvents).set({
        lastAttemptAt: now,
        lastSuccessfulAt: now,
        delayCode: null,
        failureCode: null,
        updatedAt: now,
      }).where(eq(drawEvents.id, event.id));
      return { eventId, state: 'unchanged', revisionId: current?.revisionId };
    }
    const metadata = mediaWikiRevision(metadataResponse.value);
    if (current?.revisionId === String(metadata.revid)) {
      await database.update(drawEvents).set({
        lastAttemptAt: now,
        lastSuccessfulAt: now,
        delayCode: null,
        failureCode: null,
        updatedAt: now,
      }).where(eq(drawEvents.id, event.id));
      return { eventId, state: 'unchanged', revisionId: current.revisionId };
    }
    const revisionUrl = new URL(`https://${MEDIAWIKI_HOST}${MEDIAWIKI_API_PATH}`);
    revisionUrl.search = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      prop: 'revisions',
      revids: String(metadata.revid),
      rvprop: 'ids|timestamp|comment|content',
      rvslots: 'main',
      maxlag: String(input.maxlagSeconds ?? DRAW_SOURCE_MAXLAG_SECONDS),
    }).toString();
    const immutableResponse = await fetchJson(revisionUrl, new Headers({
      accept: 'application/json',
      'accept-encoding': 'identity',
      'user-agent': input.userAgent ?? DRAW_SOURCE_USER_AGENT,
    }), dependencies, Math.max(1, deadlineMs - (monotonicNow() - startedAt)), now);
    const immutable = mediaWikiRevision(immutableResponse.value);
    if (immutable.revid !== metadata.revid) {
      throw sourceFailure('source_identity_conflict', 'immutable revision identity did not match the polled head');
    }
    if (!immutable.comment && metadata.comment) immutable.comment = metadata.comment;
    const parsed = parseMediaWikiRevision(sourceInput(event, immutable));
    if (!parsed.ok) throw sourceFailure('source_parse_rejected', parsed.diagnostics.join('; '));
    const parsedRevision = JSON.parse(JSON.stringify(parsed.revision)) as ParsedDrawRevision;
    if (monotonicNow() - startedAt > deadlineMs) {
      throw sourceFailure('source_timeout', 'source parsing exceeded the deadline');
    }

    let classification: ReconciliationClassification | 'initial' = 'initial';
    let canonical: AcceptedDrawRevision = { ...parsedRevision, acceptedAt: now.toISOString() };

    const accepted = await database.transaction(async (tx) => {
      const [lockedEvent] = await tx.select().from(drawEvents)
        .where(eq(drawEvents.id, event.id))
        .for('update')
        .limit(1);
      if (!lockedEvent) throw sourceFailure('event_missing', 'draw event disappeared during acceptance');
      const acceptanceNow = input.now?.() ?? new Date();
      const acceptedAt = acceptanceNow.toISOString();
      const locked = acceptanceNow >= lockedEvent.lockAt;
      const transactionalCurrent = await currentAcceptedRevision(event.id, tx as unknown as DrawDatabase);
      canonical = { ...parsedRevision, acceptedAt };
      if (transactionalCurrent) {
        const retried = reconcileDrawRevision(transactionalCurrent, parsedRevision, { locked, acceptedAt });
        if (retried.classification === 'unchanged') {
          await tx.update(drawEvents).set({
            lastAttemptAt: acceptanceNow,
            lastSuccessfulAt: acceptanceNow,
            delayCode: null,
            failureCode: null,
            updatedAt: acceptanceNow,
          }).where(eq(drawEvents.id, event.id));
          return null;
        }
        if (retried.classification === 'conflicting' || retried.classification === 'incomplete') {
          throw sourceFailure(
            retried.classification === 'conflicting'
              ? 'reconciliation_conflict'
              : 'reconciliation_incomplete',
            retried.diagnostics.join('; '),
          );
        }
        classification = retried.classification;
        canonical = retried.canonical;
      }
      const [revision] = await tx.insert(drawAcceptedRevisions).values({
        eventId: event.id,
        sourceRevisionId: canonical.revisionId,
        checksum: canonical.checksum,
        fetchedAt: new Date(canonical.fetchedAt),
        acceptedAt: new Date(canonical.acceptedAt),
        parserVersion: canonical.parserVersion,
        payload: canonical,
        explicitCorrections: canonical.explicitCorrections,
        complete: canonical.complete,
      }).onConflictDoNothing().returning();
      const persisted = revision ?? (await tx.select().from(drawAcceptedRevisions).where(and(
        eq(drawAcceptedRevisions.eventId, event.id),
        eq(drawAcceptedRevisions.sourceRevisionId, canonical.revisionId),
      )).limit(1))[0];
      if (!persisted) throw sourceFailure('acceptance_failed', 'accepted revision could not be persisted');
      await tx.insert(drawEventHeads).values({
        eventId: event.id,
        acceptedRevisionId: persisted.id,
        revisionAcceptedAt: persisted.acceptedAt,
        advancedAt: acceptanceNow,
      }).onConflictDoUpdate({
        target: drawEventHeads.eventId,
        set: {
          acceptedRevisionId: persisted.id,
          revisionAcceptedAt: persisted.acceptedAt,
          advancedAt: acceptanceNow,
        },
      });
      await tx.update(drawEvents).set({
        lastAttemptAt: acceptanceNow,
        lastSuccessfulAt: acceptanceNow,
        delayCode: null,
        failureCode: null,
        projectionFailureCode: null,
        updatedAt: acceptanceNow,
      }).where(eq(drawEvents.id, event.id));
      return persisted;
    });
    if (!accepted) return {
      eventId,
      state: 'unchanged',
      revisionId: current?.revisionId ?? parsedRevision.revisionId,
      classification: 'unchanged',
    };

    let projectionLag = false;
    if (input.projectAccepted) {
      try {
        await input.projectAccepted(event.id, canonical.revisionId);
      } catch (error) {
        projectionLag = true;
        await database.update(drawEvents).set({
          projectionFailureCode: boundedFailure(error),
          updatedAt: now,
        }).where(eq(drawEvents.id, event.id));
      }
    }
    return {
      eventId,
      state: 'accepted',
      revisionId: canonical.revisionId,
      classification,
      projectionLag,
    };
  } catch (error) {
    return recordFailure(eventId, database, now, error);
  }
}

export function createDrawIngestionWorker(input: DrawIngestionDependencies = {}) {
  const database = input.database ?? db;
  let running: Promise<DrawPollResult[]> | null = null;
  const deferredUntil = new Map<string, number>();
  return {
    run(): Promise<DrawPollResult[]> {
      if (running) return running;
      running = (async () => {
        const now = input.now?.() ?? new Date();
        const activeEvents = await database.select({ id: drawEvents.id }).from(drawEvents).where(and(
          eq(drawEvents.pollingEnabled, true),
          lte(drawEvents.createdAt, now),
          gte(drawEvents.completesAt, now),
        ));
        const results: DrawPollResult[] = [];
        for (const event of activeEvents) {
          if ((deferredUntil.get(event.id) ?? 0) > now.getTime()) {
            results.push({ eventId: event.id, state: 'skipped', delayCode: 'source_backoff' });
            continue;
          }
          const result = await pollDrawEvent(event.id, { ...input, database });
          results.push(result);
          if (result.retryAfterMs !== undefined) {
            deferredUntil.set(event.id, now.getTime() + result.retryAfterMs);
          } else if (result.state !== 'delayed') {
            deferredUntil.delete(event.id);
          }
        }
        return results;
      })().finally(() => {
        running = null;
      });
      return running;
    },
  };
}

export function startDrawIngestionMaintenance(
  input: DrawIngestionDependencies & {
    workerEnabled?: boolean;
    intervalMs?: number;
    setInterval?: typeof globalThis.setInterval;
  } = {},
): { run: () => Promise<DrawPollResult[]> } | null {
  if (!(input.workerEnabled ?? DRAW_SOURCE_WORKER_ENABLED)) return null;
  const worker = createDrawIngestionWorker(input);
  const run = () => {
    void worker.run().catch(() => {
      console.error('[draw-ingestion] pass_failed reason=source_worker_failed');
    });
  };
  run();
  const timer = (input.setInterval ?? globalThis.setInterval)(
    run,
    input.intervalMs ?? 60_000,
  );
  timer.unref();
  return worker;
}

export const DRAW_INGESTION_PARSER_VERSION = DRAW_PARSER_VERSION;
