import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { ApiError, unauthorized } from '../lib/errors';
import { sha256 } from '../lib/crypto';

/**
 * Enforces an Idempotency-Key header. The first request with a key is executed and its response
 * stored; retries with the same key and identical payload replay the stored response; reuse of a
 * key with a different payload is rejected. Must run after auth (and after multer for uploads).
 */
export function requireIdempotencyKey(req: Request, res: Response, next: NextFunction) {
  (async () => {
    if (!req.auth) throw unauthorized();
    const key = req.header('idempotency-key');
    if (!key || !/^[A-Za-z0-9_\-:.]{8,128}$/.test(key)) {
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header (8-128 chars) is required');
    }
    const fingerprint = sha256(
      JSON.stringify({
        method: req.method,
        path: req.originalUrl.split('?')[0],
        body: req.body ?? null,
        file: req.file ? sha256(req.file.buffer) : null,
      }),
    );

    const existing = await prisma.idempotencyKey.findUnique({ where: { userId_key: { userId: req.auth.userId, key } } });
    if (existing) {
      if (existing.requestHash !== fingerprint) {
        throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
      }
      if (existing.statusCode == null) {
        throw new ApiError(409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
      }
      res.setHeader('Idempotent-Replayed', 'true');
      const body = { ...(existing.responseBody as Record<string, unknown>), request_id: req.requestId };
      res.status(existing.statusCode).json(body);
      return;
    }

    let record;
    try {
      record = await prisma.idempotencyKey.create({
        data: { key, userId: req.auth.userId, method: req.method, path: req.originalUrl.split('?')[0], requestHash: fingerprint },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ApiError(409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
      }
      throw err;
    }

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      const persist =
        status < 500
          ? prisma.idempotencyKey.update({
              where: { id: record.id },
              data: { statusCode: status, responseBody: body as Prisma.InputJsonValue },
            })
          : prisma.idempotencyKey.delete({ where: { id: record.id } });
      persist.catch(() => undefined).finally(() => originalJson(body));
      return res;
    };
    next();
  })().catch(next);
}
