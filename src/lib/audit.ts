import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';

/**
 * Record an audit entry for sensitive access or mutation. Never pass raw NIN, bank numbers,
 * passwords or tokens in metadata.
 */
export async function audit(
  req: Request | null,
  action: string,
  entityType: string,
  entityId?: string | null,
  metadata?: Record<string, unknown>,
  tx: Prisma.TransactionClient = prisma,
) {
  await tx.auditLog.create({
    data: {
      actorId: req?.auth?.userId ?? null,
      action,
      entityType,
      entityId: entityId ?? null,
      requestId: req?.requestId ?? null,
      ip: req?.ip ?? null,
      metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
