import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';

const ALGORITHM = 'HS256';
const INVITATION_AUDIENCE = 'rallo:draw-invitation';
const PARTICIPANT_AUDIENCE = 'rallo:draw-participant';
// League/database expiry is authoritative; 500d only prevents premature JWT expiry during 13-month retention.
const INVITATION_TTL = '500d';
const PARTICIPANT_TTL = '500d';

type HeaderRequest = {
  rawHeaders: string[];
  headers: { authorization?: string | string[]; [name: string]: string | string[] | undefined };
};

function key(secret: string, purpose: string): Buffer {
  return createHmac('sha256', secret).update(purpose).digest();
}

export function mintDrawInvitationToken(leagueId: string, generation: number, secret: string): string {
  return jwt.sign(
    { l: leagueId, g: generation },
    key(secret, 'draw-invitation-v1'),
    { algorithm: ALGORITHM, audience: INVITATION_AUDIENCE, expiresIn: INVITATION_TTL },
  );
}

export function mintDrawParticipantToken(
  leagueId: string,
  participantId: string,
  generation: number,
  secret: string,
): string {
  return jwt.sign(
    { l: leagueId, p: participantId, g: generation },
    key(secret, 'draw-participant-v1'),
    { algorithm: ALGORITHM, audience: PARTICIPANT_AUDIENCE, expiresIn: PARTICIPANT_TTL },
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function verifyDrawInvitationToken(
  token: string,
  secret: string,
): { leagueId: string; generation: number } | null {
  try {
    const claims = jwt.verify(token, key(secret, 'draw-invitation-v1'), {
      algorithms: [ALGORITHM],
      audience: INVITATION_AUDIENCE,
    }) as { l?: unknown; g?: unknown };
    if (typeof claims.l !== 'string' || !claims.l || !nonNegativeInteger(claims.g)) return null;
    return { leagueId: claims.l, generation: claims.g };
  } catch {
    return null;
  }
}

export function verifyDrawParticipantToken(
  token: string,
  secret: string,
): { leagueId: string; participantId: string; generation: number } | null {
  try {
    const claims = jwt.verify(token, key(secret, 'draw-participant-v1'), {
      algorithms: [ALGORITHM],
      audience: PARTICIPANT_AUDIENCE,
    }) as { l?: unknown; p?: unknown; g?: unknown };
    if (
      typeof claims.l !== 'string'
      || !claims.l
      || typeof claims.p !== 'string'
      || !claims.p
      || !nonNegativeInteger(claims.g)
    ) return null;
    return { leagueId: claims.l, participantId: claims.p, generation: claims.g };
  } catch {
    return null;
  }
}

export function authorizationBearer(req: HeaderRequest): string | null {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === 'authorization') count += 1;
  }
  if (count !== 1 || typeof req.headers.authorization !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(req.headers.authorization);
  return match?.[1] ?? null;
}
