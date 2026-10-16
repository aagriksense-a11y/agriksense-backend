import jwt from 'jsonwebtoken';
import { BaseRole } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { randomToken, sha256 } from './crypto';
import crypto from 'crypto';

export interface AccessTokenPayload {
  sub: string;
  aid: string;
  role: BaseRole;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.jwtAccessSecret, { expiresIn: env.accessTokenTtl as jwt.SignOptions['expiresIn'] });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.jwtAccessSecret) as AccessTokenPayload;
}

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

function ttlSeconds(ttl: string): number {
  const match = /^(\d+)([smhd])?$/.exec(ttl);
  if (!match) return 900;
  const n = Number(match[1]);
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'] ?? 1);
}

/**
 * Issue an access token plus an opaque rotating refresh token. Refresh tokens are stored
 * hashed; a family id links rotations so reuse of a revoked token revokes the whole family.
 */
export async function issueTokens(
  user: { id: string; agriksenseId: string; baseRole: BaseRole },
  meta: { familyId?: string; userAgent?: string; ip?: string } = {},
): Promise<IssuedTokens & { refreshTokenId: string }> {
  const refresh = randomToken(48);
  const expiresAt = new Date(Date.now() + env.refreshTokenTtlDays * 86400_000);
  const record = await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(refresh),
      familyId: meta.familyId ?? crypto.randomUUID(),
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 255),
      ip: meta.ip,
    },
  });
  return {
    access_token: signAccessToken({ sub: user.id, aid: user.agriksenseId, role: user.baseRole }),
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: ttlSeconds(env.accessTokenTtl),
    refreshTokenId: record.id,
  };
}

export function publicTokens(tokens: IssuedTokens & { refreshTokenId?: string }): IssuedTokens {
  const { refreshTokenId: _ignored, ...rest } = tokens;
  return rest;
}

export async function revokeAllSessions(userId: string) {
  await prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
