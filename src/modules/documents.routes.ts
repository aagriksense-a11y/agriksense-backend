import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { asyncHandler, created, noContent, ok } from '../lib/http';
import { conflict, notFound } from '../lib/errors';
import { parse, uuid } from '../lib/validation';
import { deleteObject, getObject, signedFileUrl, verifyFileToken } from '../lib/files';
import { audit } from '../lib/audit';
import { authOf, hasPermission, requireAuth } from '../middleware/auth';
import { singleFile } from '../middleware/upload';
import { serializeDocument, storeUpload } from '../services/document.service';
import { canAccessFarm } from '../services/access.service';
import { ApiError } from '../lib/errors';

export const documentsRouter = Router();
export const filesRouter = Router();

const IDENTITY_TYPES = ['nin', 'cac_certificate', 'cac_form2', 'cac_form7', 'utility_bill', 'passport_photo'];

documentsRouter.use(requireAuth);

// POST /documents (multipart: file, type)
documentsRouter.post(
  '/',
  singleFile,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { type } = parse(
      z.object({ type: z.enum(['nin', 'cac_certificate', 'cac_form2', 'cac_form7', 'utility_bill', 'passport_photo', 'observation_evidence', 'crop_image', 'other']) }),
      req.body,
    );
    const org = auth.role === 'organization_admin' ? await prisma.organization.findUnique({ where: { ownerUserId: auth.userId } }) : null;
    const doc = await storeUpload(req.file, auth.userId, type, org?.id);
    await audit(req, 'document.uploaded', 'document', doc.id, { type });
    created(res, serializeDocument(doc));
  }),
);

// GET /documents/{documentId}/access — short-lived signed download link
documentsRouter.get(
  '/:documentId/access',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const doc = await prisma.document.findUnique({ where: { id: parse(uuid, req.params.documentId) } });
    if (!doc || doc.deletedAt) throw notFound('Document');
    let allowed = doc.ownerId === auth.userId || hasPermission(req, 'verifications.review');
    if (!allowed && !IDENTITY_TYPES.includes(doc.type)) {
      // Evidence images are visible to anyone who can read the farm they were recorded against.
      const obs = await prisma.observation.findFirst({ where: { evidenceDocumentIds: { has: doc.id } }, select: { farmId: true } });
      const pred = obs ? null : await prisma.aiPrediction.findFirst({ where: { imageDocumentId: doc.id }, select: { farmId: true } });
      const farmId = obs?.farmId ?? pred?.farmId;
      if (farmId) {
        const farm = await prisma.farm.findUnique({ where: { id: farmId }, select: { id: true, ownerId: true } });
        allowed = !!farm && (await canAccessFarm(req, farm, 'read'));
      }
    }
    if (!allowed) throw notFound('Document');
    await audit(req, 'document.access_link_issued', 'document', doc.id, { type: doc.type });
    ok(res, { document_id: doc.id, ...signedFileUrl(doc.id) });
  }),
);

// DELETE /documents/{documentId} — refused while the document backs an identity verification
documentsRouter.delete(
  '/:documentId',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const doc = await prisma.document.findUnique({ where: { id: parse(uuid, req.params.documentId) } });
    if (!doc || doc.deletedAt || doc.ownerId !== auth.userId) throw notFound('Document');
    const inUse = await prisma.identityVerification.findFirst({
      where: { documentIds: { has: doc.id }, status: { in: ['pending', 'manual_review', 'verified'] } },
      select: { id: true },
    });
    if (inUse) throw conflict('Document supports an active or completed identity verification and must be retained');
    const isPhoto = await prisma.user.findFirst({ where: { photoDocumentId: doc.id }, select: { id: true } });
    if (isPhoto) throw conflict('Document is your current passport photograph; upload a replacement first');
    const isEvidence = await prisma.observation.findFirst({ where: { evidenceDocumentIds: { has: doc.id } }, select: { id: true } });
    if (isEvidence) throw conflict('Document is evidence on an observation record and must be retained');
    await prisma.document.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });
    await deleteObject(doc.storageKey);
    await audit(req, 'document.deleted', 'document', doc.id, { type: doc.type });
    noContent(res);
  }),
);

// GET /files/{token} — serves a private file for a valid, unexpired signed token
filesRouter.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const documentId = verifyFileToken(req.params.token);
    if (!documentId) throw new ApiError(403, 'INVALID_OR_EXPIRED_LINK', 'Download link is invalid or has expired');
    const doc = await prisma.document.findUnique({ where: { id: documentId } });
    if (!doc || doc.deletedAt) throw notFound('Document');
    const buf = await getObject(doc.storageKey);
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${doc.id}"`);
    res.status(200).send(buf);
  }),
);
