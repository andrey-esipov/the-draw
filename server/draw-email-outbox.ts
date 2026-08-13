import { and, asc, count, eq, inArray, lte, min, or, sql } from 'drizzle-orm';
import { db } from './db.js';
import {
  DRAW_EMAIL_CANARY_PROVEN,
  DRAW_EMAIL_WORKER_ENABLED,
  hasDrawEmailProvider,
  PUBLIC_URL,
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  SESSION_SECRET,
} from './env.js';
import { drawEmailOutbox, drawLeagues, drawParticipants } from './schema.js';
import { mintDrawParticipantToken } from './draw-tokens.js';

type DrawEmailDatabase = typeof db;
export type DrawEmailTransport = (input: {
  to: string;
  returnLink: string;
  idempotencyKey: string;
}) => Promise<void>;

const FAILURE_CODES = new Set(['provider_unavailable', 'participant_unavailable', 'delivery_failed']);
const DEFAULT_PASS_LIMIT = 25;
const EMAIL_BACKLOG_BOUNDARY_MS = 15 * 60_000;

function failureCode(error: unknown): string {
  if (error instanceof Error && FAILURE_CODES.has(error.message)) return error.message;
  return 'delivery_failed';
}

export async function processNextDrawEmail(
  dependencies: {
    database?: DrawEmailDatabase;
    now?: Date;
    secret: string;
    publicUrl: string;
    send: DrawEmailTransport;
    beforeClaim?: () => Promise<void>;
  },
): Promise<'empty' | 'sent' | 'retry' | 'failed'> {
  const database = dependencies.database ?? db;
  const now = dependencies.now ?? new Date();
  const stale = new Date(now.getTime() - 5 * 60_000);
  const [candidate] = await database.select().from(drawEmailOutbox)
    .where(or(
      and(eq(drawEmailOutbox.status, 'pending'), lte(drawEmailOutbox.availableAt, now)),
      and(eq(drawEmailOutbox.status, 'sending'), lte(drawEmailOutbox.claimedAt, stale)),
    ))
    .orderBy(asc(drawEmailOutbox.createdAt))
    .limit(1);
  if (!candidate) return 'empty';
  await dependencies.beforeClaim?.();
  if (candidate.attempts >= 5) {
    const [failed] = await database.update(drawEmailOutbox).set({
      status: 'failed',
      claimedAt: null,
      lastErrorCode: candidate.lastErrorCode ?? 'delivery_failed',
      updatedAt: now,
    }).where(and(
      eq(drawEmailOutbox.id, candidate.id),
      eq(drawEmailOutbox.status, candidate.status),
      eq(drawEmailOutbox.attempts, candidate.attempts),
    )).returning();
    return failed ? 'failed' : 'empty';
  }
  const [claimed] = await database.update(drawEmailOutbox).set({
    status: 'sending',
    attempts: candidate.attempts + 1,
    claimedAt: now,
    updatedAt: now,
  }).where(and(
    eq(drawEmailOutbox.id, candidate.id),
    eq(drawEmailOutbox.status, candidate.status),
    eq(drawEmailOutbox.attempts, candidate.attempts),
  )).returning();
  if (!claimed) return 'empty';

  try {
    if (!claimed.participantId || !claimed.recipientEmail) throw new Error('participant_unavailable');
    await database.transaction(async (tx) => {
      const [owner] = await tx.select({
        participant: drawParticipants,
        league: drawLeagues,
      }).from(drawParticipants)
        .innerJoin(drawLeagues, eq(drawLeagues.id, drawParticipants.leagueId))
        .where(and(
          eq(drawParticipants.id, claimed.participantId!),
          eq(drawParticipants.leagueId, claimed.leagueId),
        ))
        .for('update')
        .limit(1);
      if (!owner || owner.participant.removedAt || now >= owner.league.expiresAt) {
        throw new Error('participant_unavailable');
      }

      const token = mintDrawParticipantToken(
        owner.league.id,
        owner.participant.id,
        owner.participant.returnGeneration,
        dependencies.secret,
      );
      const returnLink = `${dependencies.publicUrl.replace(/\/+$/, '')}/draw/#return=${encodeURIComponent(token)}`;
      await dependencies.send({
        to: claimed.recipientEmail!,
        returnLink,
        idempotencyKey: claimed.id,
      });
      await tx.update(drawEmailOutbox).set({
        status: 'sent',
        sentAt: now,
        lastErrorCode: null,
        updatedAt: now,
      }).where(and(
        eq(drawEmailOutbox.id, claimed.id),
        eq(drawEmailOutbox.status, 'sending'),
        eq(drawEmailOutbox.claimedAt, now),
      ));
    });
    return 'sent';
  } catch (error) {
    const attempts = claimed.attempts;
    const terminal = attempts >= 5 || failureCode(error) === 'participant_unavailable';
    await database.update(drawEmailOutbox).set({
      status: terminal ? 'failed' : 'pending',
      attempts,
      availableAt: new Date(now.getTime() + Math.min(60, 2 ** attempts) * 60_000),
      lastErrorCode: failureCode(error),
      claimedAt: null,
      updatedAt: now,
    }).where(and(
      eq(drawEmailOutbox.id, claimed.id),
      inArray(drawEmailOutbox.status, ['sending']),
      eq(drawEmailOutbox.claimedAt, now),
    ));
    return terminal ? 'failed' : 'retry';
  }
}

export async function sendDrawReturnEmail(input: {
  to: string;
  returnLink: string;
  idempotencyKey: string;
}): Promise<void> {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) throw new Error('provider_unavailable');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`,
      'content-type': 'application/json',
      'idempotency-key': input.idempotencyKey,
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: input.to,
      subject: 'Your private Draw return link',
      text: `Return to your private league:\n\n${input.returnLink}\n\nKeep this link private.`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('provider_unavailable');
}

export async function processDrawEmailPass(input: {
  database?: DrawEmailDatabase;
  now?: Date;
  secret?: string;
  publicUrl?: string;
  send?: DrawEmailTransport;
  limit?: number;
} = {}) {
  const limit = input.limit ?? DEFAULT_PASS_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_email_pass_limit');
  const results = { processed: 0, sent: 0, retries: 0, failed: 0 };
  while (results.processed < limit) {
    const outcome = await processNextDrawEmail({
      database: input.database,
      now: input.now,
      secret: input.secret ?? SESSION_SECRET,
      publicUrl: input.publicUrl ?? PUBLIC_URL,
      send: input.send ?? sendDrawReturnEmail,
    });
    if (outcome === 'empty') break;
    results.processed += 1;
    if (outcome === 'sent') results.sent += 1;
    if (outcome === 'retry') results.retries += 1;
    if (outcome === 'failed') results.failed += 1;
  }
  return results;
}

export async function drawEmailHealth(
  database: DrawEmailDatabase = db,
  now: Date = new Date(),
  enabled = DRAW_EMAIL_WORKER_ENABLED,
  canaryProven = DRAW_EMAIL_CANARY_PROVEN,
  providerConfigured = hasDrawEmailProvider,
) {
  const [backlog] = await database.select({
    value: count(),
    oldest: min(drawEmailOutbox.createdAt),
    retries: sql<number>`coalesce(sum(${drawEmailOutbox.attempts}), 0)::int`,
  }).from(drawEmailOutbox).where(inArray(drawEmailOutbox.status, ['pending', 'sending']));
  const [terminal] = await database.select({ value: count() }).from(drawEmailOutbox)
    .where(and(
      eq(drawEmailOutbox.status, 'failed'),
      inArray(drawEmailOutbox.lastErrorCode, ['delivery_failed', 'provider_unavailable']),
    ));
  const backlogCount = Number(backlog?.value ?? 0);
  const oldestBacklogAgeMs = backlog?.oldest
    ? Math.max(0, now.getTime() - backlog.oldest.getTime())
    : 0;
  const terminalFailures = Number(terminal?.value ?? 0);
  const operational = enabled && canaryProven && providerConfigured;
  const unhealthy = operational && (
    oldestBacklogAgeMs > EMAIL_BACKLOG_BOUNDARY_MS || terminalFailures > 0
  );
  return {
    state: unhealthy
      ? 'unhealthy' as const
      : operational
        ? 'enabled' as const
        : enabled
          ? canaryProven && !providerConfigured
            ? 'provider_unavailable' as const
            : 'canary_required' as const
          : 'disabled' as const,
    enabled: operational,
    canaryProven,
    providerConfigured,
    backlog: backlogCount,
    retries: Number(backlog?.retries ?? 0),
    terminalFailures,
    oldestBacklogAgeMs,
    backlogBoundaryMs: EMAIL_BACKLOG_BOUNDARY_MS,
  };
}

export function createDrawEmailWorker(input: {
  database?: DrawEmailDatabase;
  now?: () => Date;
  secret?: string;
  publicUrl?: string;
  send?: DrawEmailTransport;
  limit?: number;
} = {}) {
  let running: Promise<Awaited<ReturnType<typeof processDrawEmailPass>>> | null = null;
  return {
    run() {
      if (running) return running;
      running = processDrawEmailPass({
        ...input,
        now: input.now?.() ?? new Date(),
      }).finally(() => {
        running = null;
      });
      return running;
    },
  };
}

export function startDrawEmailDelivery(input: {
  database?: DrawEmailDatabase;
  now?: () => Date;
  secret?: string;
  publicUrl?: string;
  send?: DrawEmailTransport;
  limit?: number;
  workerEnabled?: boolean;
  canaryProven?: boolean;
  intervalMs?: number;
  setInterval?: typeof globalThis.setInterval;
} = {}) {
  if (!(input.workerEnabled ?? DRAW_EMAIL_WORKER_ENABLED)) return null;
  if (!(input.canaryProven ?? DRAW_EMAIL_CANARY_PROVEN)) return null;
  if (!input.send && !hasDrawEmailProvider) return null;
  const worker = createDrawEmailWorker(input);
  const tick = () => {
    void worker.run().catch(() => {
      console.error('[draw-email] pass_failed reason=email_worker_failed');
    });
  };
  tick();
  const timer = (input.setInterval ?? globalThis.setInterval)(
    tick,
    input.intervalMs ?? 5_000,
  );
  timer.unref();
  return worker;
}
