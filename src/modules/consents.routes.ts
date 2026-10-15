import { Router } from 'express';
import { z } from 'zod';
import type { Consent } from '@prisma/client';
import { prisma } from '../config/prisma';
import { asyncHandler, created, ok } from '../lib/http';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { parse, uuid } from '../lib/validation';
import { iso } from '../lib/serializers';
import { audit } from '../lib/audit';
import { authOf, hasPermission, requireAuth } from '../middleware/auth';
import { assertCurrentConsentVersion } from '../services/user.service';
import { ACTIVE_ASSIGNMENT_STATUSES } from '../services/access.service';
import { refreshOnboarding } from '../services/onboarding.service';

const router = Router();

const serializeConsent = (c: Consent) => ({
  id: c.id,
  user_id: c.userId,
  version: c.version,
  scope: c.scope,
  decision: c.decision,
  actor_id: c.actorId,
  recorded_on_behalf: c.actorId !== c.userId,
  channel: c.channel,
  decided_at: iso(c.decidedAt),
  withdrawn_at: iso(c.withdrawnAt),
  withdrawn_by_id: c.withdrawnById,
  withdraw_reason: c.withdrawReason,
  status: c.withdrawnAt ? 'withdrawn' : c.decision,
});

// GET /consents/current — public: wording shown before/at registration
router.get(
  '/current',
  asyncHandler(async (req, res) => {
    const q = parse(
      z.object({ scope: z.enum(['account_creation', 'farm_data_collection']).optional(), language: z.string().max(10).default('en') }),
      req.query,
    );
    const docs = await prisma.consentDocument.findMany({
      where: { isCurrent: true, language: q.language, ...(q.scope ? { scope: q.scope } : {}) },
      orderBy: { scope: 'asc' },
    });
    ok(
      res,
      docs.map((d) => ({ id: d.id, version: d.version, scope: d.scope, title: d.title, body: d.body, language: d.language, published_at: iso(d.publishedAt) })),
    );
  }),
);

router.use(requireAuth);

// POST /consents — record accept/reject. Farmers record their own; a DCO assigned to one of the
// farmer's farms (or an admin with users.write) may record a decision on the farmer's behalf.
const recordSchema = z.object({
  version: z.string().min(1).max(20),
  scope: z.enum(['account_creation', 'farm_data_collection']),
  decision: z.enum(['accepted', 'rejected']),
  farmer_id: uuid.optional(),
  channel: z.string().max(40).optional(),
});
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = parse(recordSchema, req.body);
    const subjectId = body.farmer_id ?? auth.userId;
    const subject = await prisma.user.findUnique({ where: { id: subjectId }, select: { id: true, baseRole: true } });
    if (!subject) throw notFound('Farmer');
    if (subject.baseRole !== 'farmer') throw unprocessable('Consent is recorded for farmer accounts only', [{ field: 'farmer_id', reason: 'not a farmer' }]);
    if (subjectId !== auth.userId) {
      let allowed = hasPermission(req, 'users.write');
      if (!allowed && auth.role === 'dco') {
        allowed = !!(await prisma.farmAssignment.findFirst({
          where: { dcoId: auth.userId, status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] }, farm: { ownerId: subjectId } },
          select: { id: true },
        }));
      }
      if (!allowed) throw forbidden('You may not record consent for this farmer');
    }
    if (body.scope === 'account_creation' && body.decision === 'rejected') {
      throw unprocessable('Account terms cannot be rejected for an existing account; request account closure instead');
    }
    await assertCurrentConsentVersion(body.version, body.scope);
    const consent = await prisma.consent.create({
      data: { userId: subjectId, version: body.version, scope: body.scope, decision: body.decision, actorId: auth.userId, channel: body.channel ?? 'api' },
    });
    await audit(req, 'consent.recorded', 'consent', consent.id, { subject_id: subjectId, scope: body.scope, decision: body.decision });
    await refreshOnboarding(subjectId);
    created(res, serializeConsent(consent));
  }),
);

// GET /consents/me — history plus effective status per scope
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const history = await prisma.consent.findMany({ where: { userId: auth.userId }, orderBy: { decidedAt: 'desc' } });
    const effective: Record<string, string> = { account_creation: 'not_given', farm_data_collection: 'not_given' };
    for (const scope of Object.keys(effective)) {
      const latest = history.find((c) => c.scope === scope);
      if (latest) effective[scope] = latest.withdrawnAt ? 'withdrawn' : latest.decision;
    }
    ok(res, { status: effective, history: history.map(serializeConsent) });
  }),
);

// POST /consents/{consentId}/withdraw — blocks future collection under the withdrawn scope
router.post(
  '/:consentId/withdraw',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const consentId = parse(uuid, req.params.consentId);
    const body = parse(z.object({ reason: z.string().max(500).optional() }), req.body ?? {});
    const consent = await prisma.consent.findUnique({ where: { id: consentId } });
    if (!consent) throw notFound('Consent');
    if (consent.userId !== auth.userId && !hasPermission(req, 'users.write')) throw notFound('Consent');
    if (consent.scope !== 'farm_data_collection') {
      throw unprocessable('Only farm visit / data collection consent can be withdrawn; request account closure for account terms');
    }
    if (consent.decision !== 'accepted') throw conflict('Only an accepted consent can be withdrawn');
    if (consent.withdrawnAt) throw conflict('Consent has already been withdrawn');
    const updated = await prisma.consent.update({
      where: { id: consent.id },
      data: { withdrawnAt: new Date(), withdrawnById: auth.userId, withdrawReason: body.reason },
    });
    await audit(req, 'consent.withdrawn', 'consent', consent.id, { subject_id: consent.userId });
    await refreshOnboarding(consent.userId);
    ok(res, serializeConsent(updated));
  }),
);

export default router;
