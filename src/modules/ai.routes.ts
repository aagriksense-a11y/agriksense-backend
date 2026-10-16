import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AiCrop, Prisma } from '@prisma/client';
import type { AiModelVersion, AiPrediction, AiFeedback } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { asyncHandler, created, ok } from '../lib/http';
import { ApiError, conflict, notFound, serviceUnavailable, unprocessable } from '../lib/errors';
import { parse, uuid } from '../lib/validation';
import { iso } from '../lib/serializers';
import { imageDimensions } from '../lib/files';
import { getPagination, pageMeta } from '../lib/pagination';
import { audit } from '../lib/audit';
import { authOf, hasPermission, requireAuth, requirePermission } from '../middleware/auth';
import { singleFile } from '../middleware/upload';
import { canAccessFarm, farmScopeFilter, getFarmWithAccess } from '../services/access.service';
import { storeUpload } from '../services/document.service';
import { InferenceError, inferenceClient } from '../services/inference.service';

export const aiRouter = Router();
export const adminAiRouter = Router();

const crop = z.nativeEnum(AiCrop, { errorMap: () => ({ message: 'crop must be one of rice, maize, tomato' }) });

const serializeModel = (m: AiModelVersion) => ({
  id: m.id,
  crop: m.crop,
  version: m.version,
  status: m.status,
  class_count: m.classes.length,
  service_url: m.serviceUrl,
  approved_at: iso(m.approvedAt),
  activated_at: iso(m.activatedAt),
  created_at: iso(m.createdAt),
});

const serializePrediction = (p: AiPrediction & { modelVersion?: AiModelVersion; feedback?: AiFeedback[] }) => ({
  prediction_id: p.id,
  id: p.id,
  crop: p.crop,
  status: p.status,
  model_version: p.modelVersion?.version ?? null,
  model_version_id: p.modelVersionId,
  farm_id: p.farmId,
  image_document_id: p.imageDocumentId,
  image: p.imageWidth ? { width: p.imageWidth, height: p.imageHeight } : null,
  detections: p.detections,
  detection_count: Array.isArray(p.detections) ? p.detections.length : 0,
  latency_ms: p.latencyMs,
  error: p.errorMessage,
  user_id: p.userId,
  feedback: p.feedback?.map((f) => ({
    id: f.id,
    is_correct: f.isCorrect,
    corrected_class_name: f.correctedClassName,
    detection_index: f.detectionIndex,
    notes: f.notes,
    is_verified: f.isVerified,
    created_at: iso(f.createdAt),
  })),
  created_at: iso(p.createdAt),
});

const activeModel = (c: AiCrop) => prisma.aiModelVersion.findFirst({ where: { crop: c, status: 'active' } });

aiRouter.use(requireAuth);

// GET /ai/models
aiRouter.get(
  '/models',
  asyncHandler(async (_req, res) => {
    const versions = await prisma.aiModelVersion.findMany({ orderBy: [{ crop: 'asc' }, { createdAt: 'desc' }] });
    ok(
      res,
      Object.values(AiCrop).map((c) => {
        const forCrop = versions.filter((v) => v.crop === c);
        const active = forCrop.find((v) => v.status === 'active');
        return { crop: c, active_version: active ? serializeModel(active) : null, versions: forCrop.map(serializeModel) };
      }),
    );
  }),
);

// GET /ai/models/{crop}/classes — the approved ordered class list (index == class_id)
aiRouter.get(
  '/models/:crop/classes',
  asyncHandler(async (req, res) => {
    const c = parse(crop, req.params.crop);
    const model = await activeModel(c);
    if (!model) throw new ApiError(503, 'MODEL_NOT_ACTIVE', `No approved ${c} model is active`);
    ok(res, { crop: c, model_version: model.version, classes: model.classes.map((name, class_id) => ({ class_id, class_name: name })) });
  }),
);

// GET /ai/models/{crop}/status
aiRouter.get(
  '/models/:crop/status',
  asyncHandler(async (req, res) => {
    const c = parse(crop, req.params.crop);
    const model = await activeModel(c);
    if (!model) return ok(res, { crop: c, ready: false, active_version: null, reason: 'no active model', checked_at: new Date().toISOString() });
    const health = await inferenceClient.health(model.serviceUrl);
    ok(res, { crop: c, active_version: model.version, ready: health.ready, latency_ms: health.latency_ms, error: health.error ?? null, inference_mode: env.ai.mode, checked_at: new Date().toISOString() });
  }),
);

// POST /ai/predictions (multipart: crop, file, farm_id?)
aiRouter.post(
  '/predictions',
  singleFile,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = parse(z.object({ crop, farm_id: uuid.optional() }), req.body);
    if (body.farm_id) await getFarmWithAccess(req, body.farm_id, 'read');
    const model = await activeModel(body.crop);
    if (!model) throw new ApiError(503, 'MODEL_NOT_ACTIVE', `No approved ${body.crop} model is active`);
    // Validates content type by magic bytes and that the image header decodes.
    const doc = await storeUpload(req.file, auth.userId, 'crop_image');
    const dims = imageDimensions(req.file!.buffer)!;
    if (dims.width < 32 || dims.height < 32 || dims.width > 10000 || dims.height > 10000) {
      throw unprocessable('Image dimensions must be between 32 and 10000 pixels', [{ field: 'file', reason: `${dims.width}x${dims.height}` }]);
    }
    let output;
    try {
      output = await inferenceClient.predict(model, req.file!.buffer, doc.mimeType, dims.width, dims.height);
    } catch (err) {
      const message = err instanceof InferenceError ? err.message : 'Inference failed';
      await prisma.aiPrediction.create({
        data: { userId: auth.userId, farmId: body.farm_id, crop: body.crop, modelVersionId: model.id, imageDocumentId: doc.id, status: 'failed', detections: [], imageWidth: dims.width, imageHeight: dims.height, errorMessage: message },
      });
      throw serviceUnavailable('The inference service is unavailable. Please retry shortly.', 'INFERENCE_UNAVAILABLE');
    }
    const prediction = await prisma.aiPrediction.create({
      data: {
        userId: auth.userId,
        farmId: body.farm_id,
        crop: body.crop,
        modelVersionId: model.id,
        imageDocumentId: doc.id,
        status: 'succeeded',
        detections: output.detections as unknown as Prisma.InputJsonValue,
        imageWidth: dims.width,
        imageHeight: dims.height,
        latencyMs: output.latency_ms,
      },
      include: { modelVersion: true },
    });
    await audit(req, 'ai.prediction_created', 'ai_prediction', prediction.id, { crop: body.crop, model_version: model.version, detections: output.detections.length, dropped: output.dropped.length });
    ok(res, { ...serializePrediction(prediction), dropped_detections: output.dropped.length });
  }),
);

async function loadPrediction(req: Request) {
  const p = await prisma.aiPrediction.findUnique({
    where: { id: parse(uuid, req.params.predictionId) },
    include: { modelVersion: true, feedback: { orderBy: { createdAt: 'asc' } }, farm: { select: { id: true, ownerId: true } } },
  });
  if (!p) throw notFound('Prediction');
  const auth = authOf(req);
  const allowed = p.userId === auth.userId || hasPermission(req, 'ai.predictions.read_all') || (p.farm ? await canAccessFarm(req, p.farm, 'read') : false);
  if (!allowed) throw notFound('Prediction');
  return p;
}

// GET /ai/predictions/{predictionId}
aiRouter.get(
  '/predictions/:predictionId',
  asyncHandler(async (req, res) => {
    ok(res, serializePrediction(await loadPrediction(req)));
  }),
);

// GET /ai/predictions?crop=&farm_id=&status=
aiRouter.get(
  '/predictions',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const p = getPagination(req.query);
    const q = parse(z.object({ crop: crop.optional(), farm_id: uuid.optional(), status: z.enum(['succeeded', 'failed']).optional() }).passthrough(), req.query);
    const filters: Prisma.AiPredictionWhereInput[] = [];
    if (q.farm_id) {
      await getFarmWithAccess(req, q.farm_id, 'read');
      filters.push({ farmId: q.farm_id });
    } else if (!hasPermission(req, 'ai.predictions.read_all')) {
      filters.push({ OR: [{ userId: auth.userId }, { farm: await farmScopeFilter(req) }] });
    }
    if (q.crop) filters.push({ crop: q.crop });
    if (q.status) filters.push({ status: q.status });
    const where = { AND: filters };
    const [total, rows] = await Promise.all([
      prisma.aiPrediction.count({ where }),
      prisma.aiPrediction.findMany({ where, include: { modelVersion: true }, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
    ]);
    ok(res, rows.map(serializePrediction), pageMeta(p, total));
  }),
);

// POST /ai/predictions/{predictionId}/feedback
aiRouter.post(
  '/predictions/:predictionId/feedback',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const p = await loadPrediction(req);
    const body = parse(
      z
        .object({
          is_correct: z.boolean(),
          corrected_class_name: z.string().max(100).optional(),
          detection_index: z.number().int().min(0).optional(),
          notes: z.string().max(2000).optional(),
        })
        .refine((b) => b.is_correct || !!b.corrected_class_name || !!b.notes, { message: 'corrected_class_name or notes is required when is_correct is false', path: ['corrected_class_name'] }),
      req.body,
    );
    if (body.corrected_class_name && !p.modelVersion.classes.includes(body.corrected_class_name)) {
      throw unprocessable('corrected_class_name must be one of the approved classes', [{ field: 'corrected_class_name', reason: 'not in class map' }]);
    }
    const detections = (p.detections as unknown[]) ?? [];
    if (body.detection_index !== undefined && body.detection_index >= detections.length) {
      throw unprocessable('detection_index is out of range', [{ field: 'detection_index', reason: `prediction has ${detections.length} detections` }]);
    }
    const fb = await prisma.aiFeedback.create({
      data: {
        predictionId: p.id,
        userId: auth.userId,
        isCorrect: body.is_correct,
        correctedClassName: body.corrected_class_name,
        detectionIndex: body.detection_index,
        notes: body.notes,
        // Corrections from model reviewers count as verified labels.
        isVerified: hasPermission(req, 'ai.models.manage'),
      },
    });
    await audit(req, 'ai.feedback_submitted', 'ai_prediction', p.id, { is_correct: body.is_correct, verified: fb.isVerified });
    created(res, { id: fb.id, prediction_id: p.id, is_correct: fb.isCorrect, corrected_class_name: fb.correctedClassName, detection_index: fb.detectionIndex, notes: fb.notes, is_verified: fb.isVerified, created_at: iso(fb.createdAt) });
  }),
);

// ───────────── Model governance ─────────────

adminAiRouter.use(requireAuth);

// POST /admin/ai/models/{crop}/approve — QA sign-off; registers the version if new
adminAiRouter.post(
  '/models/:crop/approve',
  requirePermission('ai.models.manage'),
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const c = parse(crop, req.params.crop);
    const body = parse(
      z.object({
        version: z.string().trim().min(1).max(50),
        service_url: z.string().url().optional(),
        classes: z.array(z.string().trim().min(1).max(100)).min(1).max(500).optional(),
        metrics: z.record(z.union([z.number(), z.string(), z.boolean(), z.null()])).refine((m) => Object.keys(m).length > 0, 'at least one QA metric is required'),
        evidence_url: z.string().url().optional(),
        notes: z.string().max(2000).optional(),
      }),
      req.body,
    );
    if (body.classes && new Set(body.classes).size !== body.classes.length) {
      throw unprocessable('Class names must be unique', [{ field: 'classes', reason: 'duplicate class name' }]);
    }
    const existing = await prisma.aiModelVersion.findUnique({ where: { crop_version: { crop: c, version: body.version } } });
    if (existing && ['approved', 'active'].includes(existing.status)) throw conflict(`Version ${body.version} is already ${existing.status}`);
    const classes = body.classes ?? existing?.classes ?? [];
    if (!classes.length) throw unprocessable('An approved ordered class list is required', [{ field: 'classes', reason: 'required' }]);
    if (existing && body.classes && existing.classes.length && existing.classes.join('\u0000') !== body.classes.join('\u0000')) {
      throw conflict('Class map differs from the registered version; register a new version instead');
    }
    const model = await prisma.$transaction(async (tx) => {
      const m = existing
        ? await tx.aiModelVersion.update({
            where: { id: existing.id },
            data: { status: 'approved', classes, serviceUrl: body.service_url ?? existing.serviceUrl, approvedById: auth.userId, approvedAt: new Date() },
          })
        : await tx.aiModelVersion.create({
            data: { crop: c, version: body.version, serviceUrl: body.service_url ?? env.ai.serviceUrls[c], classes, status: 'approved', approvedById: auth.userId, approvedAt: new Date() },
          });
      await tx.aiModelEvaluation.create({
        data: { modelVersionId: m.id, metrics: body.metrics, evidenceUrl: body.evidence_url, notes: body.notes, signedOffById: auth.userId },
      });
      return m;
    });
    await audit(req, 'ai.model_approved', 'ai_model_version', model.id, { crop: c, version: model.version });
    ok(res, serializeModel(model));
  }),
);

// POST /admin/ai/models/{crop}/activate
adminAiRouter.post(
  '/models/:crop/activate',
  requirePermission('ai.models.manage'),
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const c = parse(crop, req.params.crop);
    const { version } = parse(z.object({ version: z.string().trim().min(1).max(50) }), req.body);
    const target = await prisma.aiModelVersion.findUnique({ where: { crop_version: { crop: c, version } } });
    if (!target) throw notFound('Model version');
    if (target.status === 'active') throw conflict('Version is already active');
    if (target.status !== 'approved') throw new ApiError(409, 'MODEL_NOT_APPROVED', 'Only approved versions can be activated');
    const model = await prisma.$transaction(async (tx) => {
      await tx.aiModelVersion.updateMany({ where: { crop: c, status: 'active' }, data: { status: 'approved' } });
      return tx.aiModelVersion.update({ where: { id: target.id }, data: { status: 'active', activatedAt: new Date(), activatedById: auth.userId } });
    });
    await audit(req, 'ai.model_activated', 'ai_model_version', model.id, { crop: c, version });
    ok(res, serializeModel(model));
  }),
);

// POST /admin/ai/models/{crop}/rollback — restore the previously active approved version
adminAiRouter.post(
  '/models/:crop/rollback',
  requirePermission('ai.models.manage'),
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const c = parse(crop, req.params.crop);
    const body = parse(z.object({ version: z.string().trim().min(1).max(50).optional(), reason: z.string().max(1000).optional() }), req.body ?? {});
    const current = await activeModel(c);
    if (!current) throw conflict('No active version to roll back from');
    const target = body.version
      ? await prisma.aiModelVersion.findUnique({ where: { crop_version: { crop: c, version: body.version } } })
      : await prisma.aiModelVersion.findFirst({
          where: { crop: c, status: 'approved', activatedAt: { not: null }, id: { not: current.id } },
          orderBy: { activatedAt: 'desc' },
        });
    if (!target) throw conflict('No previously active approved version is available for rollback');
    if (target.id === current.id) throw conflict('Target version is already active');
    if (target.status !== 'approved') throw new ApiError(409, 'MODEL_NOT_APPROVED', 'Rollback target must be an approved version');
    const model = await prisma.$transaction(async (tx) => {
      await tx.aiModelVersion.update({ where: { id: current.id }, data: { status: 'retired' } });
      return tx.aiModelVersion.update({ where: { id: target.id }, data: { status: 'active', activatedAt: new Date(), activatedById: auth.userId } });
    });
    await audit(req, 'ai.model_rolled_back', 'ai_model_version', model.id, { crop: c, from: current.version, to: model.version, reason: body.reason });
    ok(res, { ...serializeModel(model), rolled_back_from: current.version });
  }),
);

// GET /admin/ai/model-evaluations?crop=&version=
adminAiRouter.get(
  '/model-evaluations',
  requirePermission('ai.evaluations.read'),
  asyncHandler(async (req, res) => {
    const p = getPagination(req.query);
    const q = parse(z.object({ crop: crop.optional(), version: z.string().max(50).optional() }).passthrough(), req.query);
    const where: Prisma.AiModelEvaluationWhereInput = { modelVersion: { ...(q.crop ? { crop: q.crop } : {}), ...(q.version ? { version: q.version } : {}) } };
    const [total, rows] = await Promise.all([
      prisma.aiModelEvaluation.count({ where }),
      prisma.aiModelEvaluation.findMany({ where, include: { modelVersion: true }, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
    ]);
    const feedbackStats = await prisma.aiFeedback.groupBy({
      by: ['isCorrect'],
      where: { prediction: { modelVersionId: { in: rows.map((r) => r.modelVersionId) } } },
      _count: true,
    });
    ok(
      res,
      rows.map((e) => ({
        id: e.id,
        model: serializeModel(e.modelVersion),
        metrics: e.metrics,
        evidence_url: e.evidenceUrl,
        notes: e.notes,
        signed_off_by_id: e.signedOffById,
        created_at: iso(e.createdAt),
      })),
      { ...pageMeta(p, total), field_feedback: Object.fromEntries(feedbackStats.map((f) => [f.isCorrect ? 'correct' : 'incorrect', f._count])) },
    );
  }),
);
