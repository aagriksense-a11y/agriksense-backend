import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { IdentityVerification } from '@prisma/client';
import { prisma } from '../config/prisma';
import { asyncHandler, accepted, ok } from '../lib/http';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { parse, nin, uuid } from '../lib/validation';
import { encrypt, decrypt, lookupHash, last4 } from '../lib/crypto';
import { fullName, iso } from '../lib/serializers';
import { audit } from '../lib/audit';
import { getPagination, pageMeta } from '../lib/pagination';
import { logger } from '../lib/logger';
import { authOf, hasPermission, requireAuth, requirePermission, requireRole } from '../middleware/auth';
import { getVerificationProvider } from '../services/verification.provider';
import { refreshOnboarding } from '../services/onboarding.service';
import { assertOwnDocuments } from '../services/document.service';
import { NotificationService } from '../services/notification.service';

export const verificationsRouter = Router();
export const adminVerificationsRouter = Router();

export const serializeVerification = (v: IdentityVerification, opts: { revealNumber?: boolean } = {}) => ({
  request_id: v.id,
  id: v.id,
  type: v.type,
  user_id: v.userId,
  organization_id: v.organizationId,
  status: v.status,
  number_masked: `${'*'.repeat(7)}${v.numberLast4}`,
  ...(opts.revealNumber ? { number: decrypt(v.numberEncrypted) } : {}),
  name_submitted: v.nameSubmitted,
  name_match: v.nameMatch,
  provider: v.provider,
  failure_reason: v.failureReason,
  document_ids: v.documentIds,
  review: v.reviewedAt ? { reviewed_by_id: v.reviewedById, reviewed_at: iso(v.reviewedAt), notes: v.reviewNotes } : null,
  submitted_at: iso(v.submittedAt),
  completed_at: iso(v.completedAt),
});

/** Apply a terminal or review state to a verification and propagate it to the user/organization. */
async function applyVerificationResult(
  id: string,
  result: { status: IdentityVerification['status']; nameMatch?: string; providerRef?: string; failureReason?: string },
  review?: { reviewerId: string; notes?: string },
) {
  const v = await prisma.identityVerification.update({
    where: { id },
    data: {
      status: result.status,
      nameMatch: result.nameMatch,
      providerRef: result.providerRef,
      failureReason: result.failureReason ?? null,
      completedAt: ['verified', 'rejected'].includes(result.status) ? new Date() : null,
      ...(review ? { reviewedById: review.reviewerId, reviewedAt: new Date(), reviewNotes: review.notes } : {}),
    },
  });
  if (v.type === 'nin') {
    await prisma.user.update({ where: { id: v.userId }, data: { ninStatus: v.status } });
  } else if (v.organizationId) {
    await prisma.organization.update({ where: { id: v.organizationId }, data: { cacStatus: v.status } });
  }
  await refreshOnboarding(v.userId);
  await NotificationService.inApp(
    v.userId,
    'verification_update',
    `${v.type.toUpperCase()} verification ${v.status.replace('_', ' ')}`,
    v.status === 'verified'
      ? `Your ${v.type.toUpperCase()} has been verified.`
      : v.status === 'rejected'
        ? `Your ${v.type.toUpperCase()} verification was rejected${v.failureReason ? `: ${v.failureReason}` : ''}. Please resubmit.`
        : `Your ${v.type.toUpperCase()} verification needs manual review.`,
    { verification_id: v.id, status: v.status },
  );
  return v;
}

/** Run the provider check in the background. Failures/timeouts become manual_review, never success. */
export async function processVerification(id: string) {
  const v = await prisma.identityVerification.findUnique({ where: { id } });
  if (!v || v.status !== 'pending') return;
  try {
    // Duplicate identity numbers are never auto-verified.
    const duplicate = await prisma.identityVerification.findFirst({
      where: { numberHash: v.numberHash, type: v.type, userId: { not: v.userId }, status: { in: ['verified', 'pending', 'manual_review'] } },
      select: { id: true },
    });
    if (duplicate) {
      await applyVerificationResult(id, { status: 'manual_review', nameMatch: 'unknown', failureReason: `${v.type.toUpperCase()} is already associated with another account` });
      return;
    }
    const provider = getVerificationProvider();
    const result = await provider.verify({ type: v.type, number: decrypt(v.numberEncrypted), name: v.nameSubmitted ?? '' });
    await applyVerificationResult(id, result);
  } catch (err) {
    logger.error('verification_provider_failed', { verification_id: id, error: String(err) });
    await applyVerificationResult(id, { status: 'manual_review', nameMatch: 'unknown', failureReason: 'Verification provider error' }).catch(() => undefined);
  }
}

/** Background processing; tests can await the returned promise via `pendingJobs`. */
export const pendingJobs = new Set<Promise<void>>();
function enqueue(id: string) {
  const job = processVerification(id).finally(() => pendingJobs.delete(job));
  pendingJobs.add(job);
}

async function loadOwnOrReviewable(req: Request, id: string, type: 'nin' | 'cac') {
  const v = await prisma.identityVerification.findUnique({ where: { id } });
  if (!v || v.type !== type) throw notFound('Verification request');
  if (v.userId !== authOf(req).userId && !hasPermission(req, 'verifications.review')) throw notFound('Verification request');
  if (v.userId !== authOf(req).userId) await audit(req, 'verification.viewed', 'identity_verification', v.id);
  return v;
}

verificationsRouter.use(requireAuth);

// POST /verifications/nin
verificationsRouter.post(
  '/nin',
  requireRole('farmer', 'dco'),
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = parse(z.object({ nin, document_id: uuid.optional() }), req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (user.ninStatus === 'verified') throw conflict('NIN is already verified for this account');
    if (user.ninStatus === 'pending') throw conflict('A NIN verification is already in progress');
    await assertOwnDocuments(req, [body.document_id]);
    const v = await prisma.identityVerification.create({
      data: {
        type: 'nin',
        userId: auth.userId,
        status: 'pending',
        numberEncrypted: encrypt(body.nin),
        numberHash: lookupHash(body.nin),
        numberLast4: last4(body.nin),
        nameSubmitted: fullName(user),
        provider: getVerificationProvider().name,
        documentIds: body.document_id ? [body.document_id] : [],
      },
    });
    await prisma.user.update({ where: { id: auth.userId }, data: { ninStatus: 'pending' } });
    await audit(req, 'verification.nin_submitted', 'identity_verification', v.id);
    enqueue(v.id);
    accepted(res, serializeVerification(v));
  }),
);

// GET /verifications/nin/{requestId}
verificationsRouter.get(
  '/nin/:requestId',
  asyncHandler(async (req, res) => {
    ok(res, serializeVerification(await loadOwnOrReviewable(req, parse(uuid, req.params.requestId), 'nin')));
  }),
);

// POST /verifications/cac
const cacSchema = z.object({
  cac_number: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^(RC|BN|IT|LP|LLP)?\s?[0-9]{4,8}$/, 'must be a CAC registration number such as RC123456 or BN1234567'),
  registered_name: z.string().trim().min(2).max(200).optional(),
  certificate_document_id: uuid,
  form2_document_id: uuid.optional(),
  form7_document_id: uuid.optional(),
});
verificationsRouter.post(
  '/cac',
  requireRole('organization_admin'),
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = parse(cacSchema, req.body);
    const org = await prisma.organization.findUnique({ where: { ownerUserId: auth.userId } });
    if (!org) throw notFound('Organization');
    if (!org.isRegistered) {
      throw unprocessable('Organization is marked as unregistered; set is_registered=true before CAC verification', [{ field: 'is_registered', reason: 'must be true' }]);
    }
    if (org.cacStatus === 'verified') throw conflict('CAC registration is already verified');
    if (org.cacStatus === 'pending') throw conflict('A CAC verification is already in progress');
    const docIds = [body.certificate_document_id, body.form2_document_id, body.form7_document_id].filter((d): d is string => !!d);
    await assertOwnDocuments(req, docIds);
    const number = body.cac_number.replace(/\s/g, '');
    const v = await prisma.identityVerification.create({
      data: {
        type: 'cac',
        userId: auth.userId,
        organizationId: org.id,
        status: 'pending',
        numberEncrypted: encrypt(number),
        numberHash: lookupHash(number),
        numberLast4: last4(number),
        nameSubmitted: body.registered_name ?? org.name,
        provider: getVerificationProvider().name,
        documentIds: docIds,
      },
    });
    await prisma.organization.update({ where: { id: org.id }, data: { cacStatus: 'pending' } });
    await audit(req, 'verification.cac_submitted', 'identity_verification', v.id);
    enqueue(v.id);
    accepted(res, serializeVerification(v));
  }),
);

// GET /verifications/cac/{requestId}
verificationsRouter.get(
  '/cac/:requestId',
  asyncHandler(async (req, res) => {
    ok(res, serializeVerification(await loadOwnOrReviewable(req, parse(uuid, req.params.requestId), 'cac')));
  }),
);

// GET /verifications/me
verificationsRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const list = await prisma.identityVerification.findMany({ where: { userId: authOf(req).userId }, orderBy: { submittedAt: 'desc' } });
    ok(res, list.map((v) => serializeVerification(v)));
  }),
);

// ── Reviewer endpoints (implementation addition: an authorized reviewer must be able to confirm) ──
adminVerificationsRouter.use(requireAuth, requirePermission('verifications.review'));

// GET /admin/verifications?status=&type=
adminVerificationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const p = getPagination(req.query);
    const q = parse(
      z.object({ status: z.enum(['pending', 'verified', 'rejected', 'manual_review']).optional(), type: z.enum(['nin', 'cac']).optional() }).passthrough(),
      req.query,
    );
    const where = { ...(q.status ? { status: q.status } : {}), ...(q.type ? { type: q.type } : {}) };
    const [total, rows] = await Promise.all([
      prisma.identityVerification.count({ where }),
      prisma.identityVerification.findMany({ where, orderBy: { submittedAt: 'asc' }, skip: p.skip, take: p.take }),
    ]);
    ok(res, rows.map((v) => serializeVerification(v)), pageMeta(p, total));
  }),
);

// GET /admin/verifications/{id} — reveals the full number to the reviewer (audited)
adminVerificationsRouter.get(
  '/:verificationId',
  asyncHandler(async (req, res) => {
    const v = await prisma.identityVerification.findUnique({ where: { id: parse(uuid, req.params.verificationId) } });
    if (!v) throw notFound('Verification request');
    await audit(req, 'verification.number_revealed', 'identity_verification', v.id);
    ok(res, serializeVerification(v, { revealNumber: true }));
  }),
);

// POST /admin/verifications/{id}/review
adminVerificationsRouter.post(
  '/:verificationId/review',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = parse(z.object({ decision: z.enum(['verified', 'rejected']), notes: z.string().max(1000).optional(), name_match: z.enum(['match', 'partial', 'mismatch']).optional() }), req.body);
    const v = await prisma.identityVerification.findUnique({ where: { id: parse(uuid, req.params.verificationId) } });
    if (!v) throw notFound('Verification request');
    if (v.userId === auth.userId) throw forbidden('You cannot review your own verification');
    if (!['pending', 'manual_review'].includes(v.status)) throw conflict(`Verification is already ${v.status}`);
    const updated = await applyVerificationResult(
      v.id,
      { status: body.decision, nameMatch: body.name_match ?? v.nameMatch ?? 'unknown', failureReason: body.decision === 'rejected' ? body.notes ?? 'Rejected by reviewer' : undefined },
      { reviewerId: auth.userId, notes: body.notes },
    );
    await audit(req, 'verification.reviewed', 'identity_verification', v.id, { decision: body.decision });
    ok(res, serializeVerification(updated));
  }),
);
