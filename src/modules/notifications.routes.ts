import crypto from 'crypto';
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { asyncHandler, ok } from '../lib/http';
import { ApiError, notFound, serviceUnavailable } from '../lib/errors';
import { parse, uuid, booleanish } from '../lib/validation';
import { iso } from '../lib/serializers';
import { getPagination, pageMeta } from '../lib/pagination';
import { authOf, requireAuth } from '../middleware/auth';
import { logger } from '../lib/logger';

export const notificationsRouter = Router();
export const webhooksRouter = Router();

// GET /notifications?unread=true
notificationsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const p = getPagination(req.query);
    const q = parse(z.object({ unread: booleanish.optional() }).passthrough(), req.query);
    const where = { userId: auth.userId, ...(q.unread ? { readAt: null } : {}) };
    const [total, unread, rows] = await Promise.all([
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId: auth.userId, readAt: null } }),
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
    ]);
    ok(
      res,
      rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, data: n.data, read: !!n.readAt, read_at: iso(n.readAt), created_at: iso(n.createdAt) })),
      { ...pageMeta(p, total), unread_count: unread },
    );
  }),
);

// PATCH /notifications/{notificationId}/read
notificationsRouter.patch(
  '/:notificationId/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.notificationId);
    const n = await prisma.notification.findUnique({ where: { id } });
    if (!n || n.userId !== authOf(req).userId) throw notFound('Notification');
    const updated = n.readAt ? n : await prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
    ok(res, { id: updated.id, read: true, read_at: iso(updated.readAt) });
  }),
);

/** HMAC-SHA256 (hex) of the raw request body, sent in X-Signature (optionally prefixed "sha256="). */
function verifySignature(req: Request): boolean {
  const header = (req.header('x-signature') ?? '').replace(/^sha256=/, '');
  const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
  const expected = crypto.createHmac('sha256', env.notificationWebhookSecret).update(raw).digest('hex');
  return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

const STATUS_MAP: Record<string, 'sent' | 'delivered' | 'failed'> = {
  sent: 'sent',
  accepted: 'sent',
  queued: 'sent',
  delivered: 'delivered',
  read: 'delivered',
  failed: 'failed',
  undelivered: 'failed',
  rejected: 'failed',
  bounced: 'failed',
};

// POST /integrations/notifications/webhooks/{provider}
webhooksRouter.post(
  '/notifications/webhooks/:provider',
  asyncHandler(async (req, res) => {
    const provider = parse(z.string().regex(/^[a-z0-9_-]{2,40}$/), req.params.provider);
    if (!env.notificationWebhookSecret) throw serviceUnavailable('Webhook verification is not configured', 'NOT_CONFIGURED');
    if (!verifySignature(req)) throw new ApiError(401, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
    const body = parse(
      z.object({ message_id: z.string().min(1).max(200), status: z.string().min(1).max(40), error: z.string().max(500).optional() }).passthrough(),
      req.body,
    );
    const status = STATUS_MAP[body.status.toLowerCase()];
    const delivery = await prisma.notificationDelivery.findUnique({ where: { providerMessageId: body.message_id } });
    if (!delivery) {
      logger.warn('webhook_unknown_message', { provider, message_id: body.message_id });
      return ok(res, { received: true, matched: false });
    }
    if (status) {
      await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { status, errorMessage: status === 'failed' ? body.error ?? 'delivery failed' : null } });
    }
    ok(res, { received: true, matched: true, status: status ?? delivery.status });
  }),
);
