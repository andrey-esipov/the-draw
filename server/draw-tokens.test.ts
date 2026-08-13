import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  authorizationBearer,
  mintDrawInvitationToken,
  mintDrawParticipantToken,
  verifyDrawInvitationToken,
  verifyDrawParticipantToken,
} from './draw-tokens.js';

const secret = 'draw-token-test-secret-with-enough-entropy';

describe('Draw capability tokens', () => {
  it('keeps invitation and participant capabilities non-interchangeable', () => {
    const invitation = mintDrawInvitationToken('league-1', 3, secret);
    const participant = mintDrawParticipantToken('league-1', 'participant-1', 4, secret);
    expect(verifyDrawInvitationToken(invitation, secret)).toEqual({ leagueId: 'league-1', generation: 3 });
    expect(verifyDrawParticipantToken(participant, secret)).toEqual({
      leagueId: 'league-1',
      participantId: 'participant-1',
      generation: 4,
    });
    expect(verifyDrawParticipantToken(invitation, secret)).toBeNull();
    expect(verifyDrawInvitationToken(participant, secret)).toBeNull();
  });

  it('pins audience, algorithm, signature, and expiry', () => {
    const wrongAudience = jwt.sign(
      { l: 'league-1', g: 0 },
      createHmac('sha256', secret).update('draw-invitation-v1').digest(),
      { algorithm: 'HS256', audience: 'rallo:draw-participant', expiresIn: '30d' },
    );
    const wrongAlgorithm = jwt.sign(
      { l: 'league-1', g: 0 },
      createHmac('sha512', secret).update('draw-invitation-v1').digest(),
      { algorithm: 'HS512', audience: 'rallo:draw-invitation', expiresIn: '30d' },
    );
    const expired = jwt.sign(
      { l: 'league-1', g: 0, exp: 1 },
      createHmac('sha256', secret).update('draw-invitation-v1').digest(),
      { algorithm: 'HS256', audience: 'rallo:draw-invitation' },
    );
    expect(verifyDrawInvitationToken(wrongAudience, secret)).toBeNull();
    expect(verifyDrawInvitationToken(wrongAlgorithm, secret)).toBeNull();
    expect(verifyDrawInvitationToken(expired, secret)).toBeNull();
    expect(verifyDrawInvitationToken(`${wrongAudience}x`, secret)).toBeNull();
  });

  it('accepts a bearer only from exactly one Authorization header', () => {
    expect(authorizationBearer({
      rawHeaders: ['Host', 'example.test', 'Authorization', 'Bearer one'],
      headers: { authorization: 'Bearer one' },
    })).toBe('one');
    expect(authorizationBearer({
      rawHeaders: ['Authorization', 'Bearer one', 'authorization', 'Bearer two'],
      headers: { authorization: 'Bearer one, Bearer two' },
    })).toBeNull();
    expect(authorizationBearer({
      rawHeaders: ['Cookie', 'draw=one'],
      headers: { cookie: 'draw=one' },
    })).toBeNull();
  });
});
