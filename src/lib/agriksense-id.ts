import crypto from 'crypto';
import { Prisma } from '@prisma/client';

/**
 * Allocate a unique, immutable, zero-padded 10-digit AgriKSense ID.
 *
 * IDs are random (not sequential) so they cannot be enumerated, and every issued ID is
 * recorded in IssuedAgriksenseId, which is never pruned — so an ID is never recycled even if
 * the account that held it is removed. Must run inside the transaction that creates the user.
 */
export async function allocateAgriksenseId(tx: Prisma.TransactionClient): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = crypto.randomInt(0, 10_000_000_000).toString().padStart(10, '0');
    const inserted = await tx.$executeRaw`
      INSERT INTO "IssuedAgriksenseId" ("id", "issuedAt") VALUES (${candidate}, now())
      ON CONFLICT ("id") DO NOTHING`;
    if (inserted === 1) return candidate;
  }
  throw new Error('Unable to allocate a unique AgriKSense ID');
}
