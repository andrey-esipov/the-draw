import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { DrawParticipantAccess } from '../shared/draw/contracts.js';
import { db } from './db.js';
import {
  DRAW_EMAIL_CANARY_PROVEN,
  DRAW_EMAIL_WORKER_ENABLED,
  hasDrawEmailProvider,
  PUBLIC_URL,
  SESSION_SECRET,
} from './env.js';
import {
  drawAnalyticsFailure,
  recordDrawEngagement,
  recordDrawQualifyingReturn,
  type DrawEngagementKind,
} from './draw-analytics.js';
import {
  createDrawLeague,
  DrawApiError,
  inspectDrawInvitation,
  joinDrawLeague,
  queueDrawReturnEmail,
  readDrawDraft,
  readDrawEventAvailability,
  readDrawLeague,
  removeDrawParticipant,
  saveDrawDraft,
  submitDrawBracket,
  type DrawDatabase,
} from './draw-leagues.js';
import {
  authorizationBearer,
  mintDrawInvitationToken,
  mintDrawParticipantToken,
  verifyDrawInvitationToken,
  verifyDrawParticipantToken,
} from './draw-tokens.js';
import { fragmentLink } from './draw-links.js';

interface DrawRouteOptions {
  database?: DrawDatabase;
  now?: () => Date;
  publicUrl?: string;
  secret?: string;
  emailEnabled?: boolean;
  mutationsEnabled?: boolean;
}

type JsonBody = Record<string, unknown>;

function privateHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  res.vary('Authorization');
  next();
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}

function isSameOrigin(req: Request, origin: string): boolean {
  return req.headers.origin === origin;
}

function isCrossOrigin(req: Request, origin: string): boolean {
  const requestOrigin = req.headers.origin;
  return (
    (typeof requestOrigin === 'string' && requestOrigin !== origin)
    || req.headers['sec-fetch-site'] === 'cross-site'
  );
}

function body(req: Request): JsonBody {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new DrawApiError('invalid_request', 422);
  }
  return req.body as JsonBody;
}

function recapRound(league: DrawParticipantAccess): number | null {
  const recap = league.projection?.recap;
  if (!recap || recap.state !== 'current') return null;
  const round = recap.viewModel.round;
  return Number.isInteger(round) && round >= 1 && round <= 7 ? round : null;
}

function hasActiveSubmission(league: DrawParticipantAccess): boolean {
  return league.viewer.submission.active;
}

async function recordOrReport(input: {
  database: DrawDatabase;
  leagueId: string;
  participantId: string;
  kind: DrawEngagementKind;
  round: number;
  now: Date;
}): Promise<void> {
  try {
    await recordDrawEngagement(input);
  } catch {
    drawAnalyticsFailure(input.kind);
  }
}

function forbiddenCapabilityTransport(req: Request): boolean {
  if (Object.keys(req.query).length > 0) return true;
  if (!req.body || typeof req.body !== 'object') return false;
  return Object.keys(req.body as JsonBody).some((key) => (
    ['token', 'capability', 'authorization', 'inviteToken', 'returnToken'].includes(key)
  ));
}

function hasAuthorizationHeader(req: Request): boolean {
  return req.rawHeaders.some((value, index) => (
    index % 2 === 0 && value.toLowerCase() === 'authorization'
  ));
}

function invitation(req: Request, secret: string) {
  if (forbiddenCapabilityTransport(req)) return null;
  const token = authorizationBearer(req);
  return token ? verifyDrawInvitationToken(token, secret) : null;
}

function participant(req: Request, secret: string) {
  if (forbiddenCapabilityTransport(req)) return null;
  const token = authorizationBearer(req);
  return token ? verifyDrawParticipantToken(token, secret) : null;
}

function routeError(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof DrawApiError) {
    res.status(error.status).json({
      error: error.status === 404 ? 'not_found' : error.code,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  if (
    error instanceof Error
    && ('type' in error && error.type === 'entity.too.large' || 'status' in error && error.status === 413)
  ) {
    res.status(413).json({ error: 'body_too_large' });
    return;
  }
  if (error instanceof SyntaxError) {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }
  res.status(503).json({ error: 'unavailable' });
}

export function mountDrawRoutes(app: Express, options: DrawRouteOptions = {}): void {
  const database = options.database ?? db;
  const publicUrl = options.publicUrl ?? PUBLIC_URL;
  const origin = new URL(publicUrl).origin;
  const secret = options.secret ?? SESSION_SECRET;
  const dependencies = { database, now: options.now, secret };
  const json = express.json({ limit: '16kb', strict: true, type: 'application/json' });
  const mutationBoundary = (req: Request, res: Response, next: NextFunction) => {
    if (!isSameOrigin(req, origin)) {
      notFound(res);
      return;
    }
    json(req, res, next);
  };
  const leagueMutationBoundary = (req: Request, res: Response, next: NextFunction) => {
    if (options.mutationsEnabled === false) {
      notFound(res);
      return;
    }
    mutationBoundary(req, res, next);
  };

  app.use('/api/draw', (req, res, next) => {
    privateHeaders(req, res, () => {
      if (isCrossOrigin(req, origin)) return notFound(res);
      next();
    });
  });

  app.get('/api/draw/events/:eventSlug', async (req, res) => {
    if (hasAuthorizationHeader(req) || forbiddenCapabilityTransport(req)) return notFound(res);
    res.json(await readDrawEventAvailability(req.params.eventSlug, dependencies));
  });

  app.post('/api/draw/leagues', leagueMutationBoundary, async (req, res) => {
    if (hasAuthorizationHeader(req) || forbiddenCapabilityTransport(req)) return notFound(res);
    const input = body(req);
    const created = await createDrawLeague({
      eventSlug: input.eventSlug,
      leagueName: input.leagueName,
      displayName: input.displayName,
      idempotencyKey: req.get('Idempotency-Key'),
      ip: req.ip ?? '',
    }, dependencies);
    const invitationToken = mintDrawInvitationToken(
      created.league.id,
      created.league.invitationGeneration,
      secret,
    );
    const returnToken = mintDrawParticipantToken(
      created.league.id,
      created.participant.id,
      created.participant.returnGeneration,
      secret,
    );
    res.status(201).json({
      leagueId: created.league.id,
      participantId: created.participant.id,
      eventKind: created.event.eventKind,
      invitationLink: fragmentLink(publicUrl, 'invite', invitationToken),
      returnLink: fragmentLink(publicUrl, 'return', returnToken),
    });
  });

  app.get('/api/draw/invitation', async (req, res) => {
    const claims = invitation(req, secret);
    if (!claims) return notFound(res);
    res.json(await inspectDrawInvitation(claims, dependencies));
  });

  app.post('/api/draw/participants', leagueMutationBoundary, async (req, res) => {
    const claims = invitation(req, secret);
    if (!claims) return notFound(res);
    const input = body(req);
    const joined = await joinDrawLeague(claims, {
      displayName: input.displayName,
      idempotencyKey: req.get('Idempotency-Key'),
      ip: req.ip ?? '',
    }, dependencies);
    const token = mintDrawParticipantToken(
      joined.leagueId,
      joined.id,
      joined.returnGeneration,
      secret,
    );
    res.status(201).json({
      participantId: joined.id,
      seat: joined.seat,
      returnLink: fragmentLink(publicUrl, 'return', token),
    });
  });

  app.get('/api/draw/draft', async (req, res) => {
    const claims = participant(req, secret);
    if (!claims) return notFound(res);
    res.json(await readDrawDraft(claims, dependencies));
  });

  app.put('/api/draw/draft', leagueMutationBoundary, async (req, res) => {
    const claims = participant(req, secret);
    if (!claims) return notFound(res);
    const input = body(req);
    res.json(await saveDrawDraft(claims, {
      expectedVersion: input.expectedVersion,
      picks: input.picks,
    }, dependencies));
  });

  app.post('/api/draw/submissions', leagueMutationBoundary, async (req, res) => {
    const claims = participant(req, secret);
    if (!claims) return notFound(res);
    const input = body(req);
    const submitted = await submitDrawBracket(claims, {
      expectedDraftVersion: input.expectedDraftVersion,
    }, dependencies);
    await recordOrReport({
      database,
      leagueId: claims.leagueId,
      participantId: claims.participantId,
      kind: 'submission',
      round: 0,
      now: options.now?.() ?? new Date(),
    });
    res.status(201).json(submitted);
  });

  app.get('/api/draw/league', async (req, res) => {
    const claims = participant(req, secret);
    if (!claims) return notFound(res);
    const league = await readDrawLeague(claims, dependencies);
    const round = recapRound(league);
    const engagement = {
      database,
      leagueId: claims.leagueId,
      participantId: claims.participantId,
      now: options.now?.() ?? new Date(),
    };
    const writes: Promise<void>[] = [];
    if (hasActiveSubmission(league)) {
      writes.push(recordDrawQualifyingReturn(engagement)
        .then(() => undefined)
        .catch(() => { drawAnalyticsFailure('qualifying_return'); }));
    }
    if (round !== null) {
      writes.push(recordOrReport({ ...engagement, round, kind: 'recap_view' }));
    }
    await Promise.all(writes);
    res.json(league);
  });

  app.post('/api/draw/email', mutationBoundary, async (req, res) => {
    const claims = participant(req, secret);
    if (!claims) return notFound(res);
    const input = body(req);
    const delivery = await queueDrawReturnEmail(claims, {
      email: input.email,
      confirmed: input.confirmed,
      ip: req.ip ?? '',
      enabled: options.emailEnabled ?? (
        DRAW_EMAIL_WORKER_ENABLED && DRAW_EMAIL_CANARY_PROVEN && hasDrawEmailProvider
      ),
    }, dependencies);
    const token = mintDrawParticipantToken(
      claims.leagueId,
      claims.participantId,
      claims.generation,
      secret,
    );
    res.json({
      delivery,
      returnLink: fragmentLink(publicUrl, 'return', token),
    });
  });

  app.delete('/api/draw/participant', mutationBoundary, async (req, res) => {
    const claims = participant(req, secret);
    if (!claims) return notFound(res);
    res.json(await removeDrawParticipant(claims, dependencies));
  });

  app.use('/api/draw', (_req, res) => notFound(res));
  app.use('/api/draw', routeError);
}
