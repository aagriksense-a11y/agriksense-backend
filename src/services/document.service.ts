import type { Request } from 'express';
import { DocumentType, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { assertFileType, DOCUMENT_TYPES, extensionFor, IMAGE_TYPES, putObject } from '../lib/files';
import { sha256 } from '../lib/crypto';
import { iso } from '../lib/serializers';
import { forbidden, notFound } from '../lib/errors';
import { authOf } from '../middleware/auth';

const IMAGE_ONLY: DocumentType[] = ['passport_photo', 'crop_image', 'observation_evidence'];

export async function storeUpload(
  file: Express.Multer.File | undefined,
  ownerId: string,
  type: DocumentType,
  organizationId?: string | null,
  tx: Prisma.TransactionClient = prisma,
) {
  const mime = assertFileType(file, IMAGE_ONLY.includes(type) ? IMAGE_TYPES : DOCUMENT_TYPES);
  const storageKey = await putObject(file!.buffer, extensionFor(mime));
  return tx.document.create({
    data: {
      ownerId,
      organizationId: organizationId ?? null,
      type,
      storageKey,
      originalName: file!.originalname?.slice(0, 255) || null,
      mimeType: mime,
      sizeBytes: file!.size,
      sha256: sha256(file!.buffer),
    },
  });
}

export const serializeDocument = (d: { id: string; type: string; mimeType: string; sizeBytes: number; originalName: string | null; createdAt: Date; ownerId: string }) => ({
  id: d.id,
  type: d.type,
  mime_type: d.mimeType,
  size_bytes: d.sizeBytes,
  original_name: d.originalName,
  owner_id: d.ownerId,
  created_at: iso(d.createdAt),
});

/** Ensure every referenced document exists, is not deleted and belongs to the caller. */
export async function assertOwnDocuments(req: Request, ids: (string | null | undefined)[]) {
  const wanted = ids.filter((id): id is string => !!id);
  if (!wanted.length) return;
  const docs = await prisma.document.findMany({ where: { id: { in: wanted }, deletedAt: null } });
  for (const id of wanted) {
    const doc = docs.find((d) => d.id === id);
    if (!doc) throw notFound(`Document ${id}`);
    if (doc.ownerId !== authOf(req).userId) throw forbidden(`Document ${id} does not belong to you`);
  }
}
