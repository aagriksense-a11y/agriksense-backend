import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { asyncHandler, created, ok, accepted, noContent } from '../lib/http';
import { ApiError, forbidden, serviceUnavailable, unauthorized, unprocessable } from '../lib/errors';
import { parse, email, phone, password, name } from '../lib/validation';
import { issueTokens, publicTokens, revokeAllSessions } from '../lib/tokens';
import { randomToken, sha256 } from '../lib/crypto';
import { audit } from '../lib/audit';
import { serializeUser } from '../lib/serializers';
import { requireAuth, authOf } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { assertCurrentConsentVersion, assertIdentifiersAvailable, createAccount, hashPassword, verifyPassword } from '../services/user.service';
import { NotificationService } from '../services/notification.service';
import { refreshOnboarding } from '../services/onboarding.service';

const router = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, key: (req) => String(req.body?.identifier ?? '') });
const resetLimiter = rateLimit({ windowMs: 15 * 60_000, max: 5, key: (req) => String(req.body?.identifier ?? '') });

const sessionMeta = (req: import('express').Request) => ({ userAgent: req.header('user-agent'), ip: req.ip });

function registrationResponse(user: { id: string; agriksenseId: string; baseRole: string; onboardingStatus: string }, tokens: object) {
  return { user_id: user.id, agriksense_id: user.agriksenseId, role: user.baseRole, onboarding_status: user.onboardingStatus, tokens };
}

// POST /auth/register/farmers
const farmerSchema = z.object({
  first_name: name,
  last_name: name,
  other_name: name.optional().nullable(),
  phone,
  email: email.optional().nullable(),
  password,
  consent_version: z.string().min(1).max(20),
  consent_accepted: z.boolean({ required_error: 'required' }),
});
router.post(
  '/register/farmers',
  asyncHandler(async (req, res) => {
    const body = parse(farmerSchema, req.body);
    await assertCurrentConsentVersion(body.consent_version);
    await assertIdentifiersAvailable(body.email, body.phone);
    const user = await createAccount({
      role: 'farmer',
      firstName: body.first_name,
      lastName: body.last_name,
      otherName: body.other_name,
      phone: body.phone,
      email: body.email,
      password: body.password,
      consent: { version: body.consent_version, farmDataDecision: body.consent_accepted ? 'accepted' : 'rejected', channel: 'registration' },
    });
    await NotificationService.welcome(user);
    const tokens = await issueTokens(user, sessionMeta(req));
    created(res, registrationResponse(user, publicTokens(tokens)));
  }),
);

// POST /auth/register/dcos
const dcoSchema = z.object({
  first_name: name,
  last_name: name,
  other_name: name.optional().nullable(),
  email,
  phone,
  password,
});
router.post(
  '/register/dcos',
  asyncHandler(async (req, res) => {
    const body = parse(dcoSchema, req.body);
    await assertIdentifiersAvailable(body.email, body.phone);
    const user = await createAccount({
      role: 'dco',
      firstName: body.first_name,
      lastName: body.last_name,
      otherName: body.other_name,
      email: body.email,
      phone: body.phone,
      password: body.password,
    });
    await NotificationService.welcome(user);
    const tokens = await issueTokens(user, sessionMeta(req));
    created(res, registrationResponse(user, publicTokens(tokens)));
  }),
);

// POST /auth/register/organizations
const orgSchema = z.object({
  organization_name: z.string().trim().min(2).max(200),
  email,
  phone: phone.optional().nullable(),
  password,
  is_registered: z.boolean().default(false),
});
router.post(
  '/register/organizations',
  asyncHandler(async (req, res) => {
    const body = parse(orgSchema, req.body);
    await assertIdentifiersAvailable(body.email, body.phone);
    const user = await createAccount({
      role: 'organization_admin',
      organizationName: body.organization_name,
      organizationIsRegistered: body.is_registered,
      email: body.email,
      phone: body.phone,
      password: body.password,
    });
    await NotificationService.welcome(user);
    const tokens = await issueTokens(user, sessionMeta(req));
    created(res, { ...registrationResponse(user, publicTokens(tokens)), organization_id: user.organization?.id });
  }),
);

// POST /auth/login — identifier may be email, phone or 10-digit AgriKSense ID
const loginSchema = z.object({ identifier: z.string().trim().min(3).max(254), password: z.string().min(1).max(128) });
router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const identifier = body.identifier.includes('@') ? body.identifier.toLowerCase() : body.identifier;
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { phone: identifier }, { agriksenseId: identifier }] },
    });
    const valid = user?.passwordHash ? await verifyPassword(body.password, user.passwordHash) : false;
    if (!user || !valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    if (!user.isActive) throw new ApiError(403, 'ACCOUNT_DISABLED', 'Account has been disabled. Contact an administrator.');
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const tokens = await issueTokens(user, sessionMeta(req));
    ok(res, {
      user_id: user.id,
      agriksense_id: user.agriksenseId,
      role: user.baseRole,
      onboarding_status: user.onboardingStatus,
      tokens: publicTokens(tokens),
    });
  }),
);

// POST /auth/oauth/google — exchange a Google ID token for a platform session
export const googleVerifier = {
  async verify(idToken: string): Promise<{ sub: string; email?: string; email_verified?: boolean; given_name?: string; family_name?: string }> {
    if (!env.googleClientId) throw serviceUnavailable('Google sign-in is not configured', 'NOT_CONFIGURED');
    const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!resp.ok) throw unauthorized('Invalid Google ID token');
    const info = (await resp.json()) as Record<string, string>;
    if (info.aud !== env.googleClientId) throw unauthorized('Google token audience mismatch');
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(info.iss)) throw unauthorized('Invalid Google token issuer');
    return { sub: info.sub, email: info.email, email_verified: info.email_verified === 'true', given_name: info.given_name, family_name: info.family_name };
  },
};
const googleSchema = z.object({
  id_token: z.string().min(10),
  role: z.enum(['farmer', 'dco', 'organization_admin']).optional(),
  phone: phone.optional(),
  organization_name: z.string().trim().min(2).max(200).optional(),
  consent_version: z.string().max(20).optional(),
  consent_accepted: z.boolean().optional(),
});
router.post(
  '/oauth/google',
  asyncHandler(async (req, res) => {
    const body = parse(googleSchema, req.body);
    const profile = await googleVerifier.verify(body.id_token);
    const verifiedEmail = profile.email && profile.email_verified ? profile.email.toLowerCase() : null;

    let user = await prisma.user.findUnique({ where: { googleSubject: profile.sub } });
    if (!user && verifiedEmail) {
      user = await prisma.user.findUnique({ where: { email: verifiedEmail } });
      if (user) user = await prisma.user.update({ where: { id: user.id }, data: { googleSubject: profile.sub } });
    }
    let isNew = false;
    if (!user) {
      if (!body.role) throw unprocessable('Role is required to create a new account', [{ field: 'role', reason: 'required for new accounts' }]);
      if (body.role === 'farmer') {
        if (!body.consent_version || body.consent_accepted === undefined) {
          throw unprocessable('Consent decision is required for farmer accounts', [{ field: 'consent_accepted', reason: 'required' }]);
        }
        await assertCurrentConsentVersion(body.consent_version);
      }
      if (body.role === 'dco' && !body.phone) throw unprocessable('Phone is required for DCO accounts', [{ field: 'phone', reason: 'required' }]);
      if (body.role === 'organization_admin' && !body.organization_name) {
        throw unprocessable('Organization name is required', [{ field: 'organization_name', reason: 'required' }]);
      }
      await assertIdentifiersAvailable(verifiedEmail, body.phone);
      user = await createAccount({
        role: body.role,
        email: verifiedEmail,
        phone: body.phone,
        authProvider: 'google',
        googleSubject: profile.sub,
        firstName: profile.given_name,
        lastName: profile.family_name,
        organizationName: body.organization_name,
        consent:
          body.role === 'farmer'
            ? { version: body.consent_version!, farmDataDecision: body.consent_accepted ? 'accepted' : 'rejected', channel: 'google_oauth' }
            : undefined,
      });
      await NotificationService.welcome(user);
      isNew = true;
    }
    if (!user.isActive) throw new ApiError(403, 'ACCOUNT_DISABLED', 'Account has been disabled. Contact an administrator.');
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const tokens = await issueTokens(user, sessionMeta(req));
    (isNew ? created : ok)(res, {
      user_id: user.id,
      agriksense_id: user.agriksenseId,
      role: user.baseRole,
      onboarding_status: user.onboardingStatus,
      is_new_user: isNew,
      tokens: publicTokens(tokens),
    });
  }),
);

// POST /auth/refresh — rotate refresh token; reuse of a rotated token revokes the whole family
router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refresh_token } = parse(z.object({ refresh_token: z.string().min(20) }), req.body);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refresh_token) }, include: { user: true } });
    if (!stored) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Invalid refresh token');
    if (stored.revokedAt) {
      await prisma.refreshToken.updateMany({ where: { familyId: stored.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      await audit(req, 'auth.refresh_token_reuse', 'user', stored.userId, { family_id: stored.familyId });
      throw new ApiError(401, 'REFRESH_TOKEN_REUSED', 'Refresh token was already used; all sessions in this family were revoked');
    }
    if (stored.expiresAt < new Date()) throw new ApiError(401, 'REFRESH_TOKEN_EXPIRED', 'Refresh token expired');
    if (!stored.user.isActive) throw new ApiError(403, 'ACCOUNT_DISABLED', 'Account has been disabled');
    const tokens = await issueTokens(stored.user, { ...sessionMeta(req), familyId: stored.familyId });
    const rotated = await prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedBy: tokens.refreshTokenId },
    });
    if (rotated.count !== 1) {
      // Lost a concurrent rotation race: treat as reuse.
      await prisma.refreshToken.updateMany({ where: { familyId: stored.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new ApiError(401, 'REFRESH_TOKEN_REUSED', 'Refresh token was already used');
    }
    ok(res, publicTokens(tokens));
  }),
);

// POST /auth/logout
router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ refresh_token: z.string().optional(), all_sessions: z.boolean().default(false) }), req.body ?? {});
    const auth = authOf(req);
    if (body.all_sessions) {
      await revokeAllSessions(auth.userId);
    } else if (body.refresh_token) {
      const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(body.refresh_token) } });
      if (stored && stored.userId === auth.userId) {
        await prisma.refreshToken.updateMany({ where: { familyId: stored.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
    } else {
      throw unprocessable('Provide refresh_token or all_sessions=true', [{ field: 'refresh_token', reason: 'required unless all_sessions is true' }]);
    }
    noContent(res);
  }),
);

// POST /auth/password/forgot — always 202 to avoid account enumeration
router.post(
  '/password/forgot',
  resetLimiter,
  asyncHandler(async (req, res) => {
    const { identifier } = parse(z.object({ identifier: z.string().trim().min(3).max(254) }), req.body);
    const normalized = identifier.includes('@') ? identifier.toLowerCase() : identifier;
    const user = await prisma.user.findFirst({ where: { OR: [{ email: normalized }, { phone: normalized }, { agriksenseId: normalized }] } });
    if (user && user.isActive) {
      await issuePasswordReset(user);
      await audit(req, 'auth.password_reset_requested', 'user', user.id);
    }
    accepted(res, { message: 'If an account matches, password reset instructions have been sent.' });
  }),
);

export async function issuePasswordReset(user: { id: string; email: string | null; phone: string | null }, initiatedBy?: string) {
  const token = randomToken(24);
  await prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60_000), initiatedBy },
  });
  await NotificationService.passwordReset(user, token);
}

// POST /auth/password/reset
router.post(
  '/password/reset',
  resetLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ token: z.string().min(10), new_password: password }), req.body);
    const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(body.token) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new ApiError(400, 'INVALID_RESET_TOKEN', 'Reset token is invalid or has expired');
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { passwordHash: await hashPassword(body.new_password) } }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
    await revokeAllSessions(record.userId);
    await audit(req, 'auth.password_reset_completed', 'user', record.userId);
    ok(res, { message: 'Password has been reset. Please sign in again.' });
  }),
);

// POST /auth/password/change
router.post(
  '/password/change',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ current_password: z.string().max(128).optional(), new_password: password }), req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: authOf(req).userId } });
    if (user.passwordHash) {
      if (!body.current_password || !(await verifyPassword(body.current_password, user.passwordHash))) {
        throw new ApiError(400, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
      }
    }
    if (body.current_password && body.current_password === body.new_password) {
      throw unprocessable('New password must differ from the current password', [{ field: 'new_password', reason: 'same as current' }]);
    }
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.new_password) } });
    await revokeAllSessions(user.id);
    await audit(req, 'auth.password_changed', 'user', user.id);
    const tokens = await issueTokens(user, sessionMeta(req));
    ok(res, { message: 'Password changed. Other sessions have been signed out.', tokens: publicTokens(tokens) });
  }),
);

// GET /auth/me
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const user = await prisma.user.findUnique({ where: { id: auth.userId }, include: { state: true, lga: true, organization: true } });
    if (!user) throw forbidden();
    const onboarding = await refreshOnboarding(user.id);
    ok(res, {
      user: serializeUser({ ...user, onboardingStatus: onboarding.onboarding_status }),
      permissions: [...auth.permissions].sort(),
      onboarding,
    });
  }),
);

export default router;
