import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { CropRecord, FarmlandMeasurement, Observation } from '@prisma/client';
import { prisma } from '../config/prisma';
import { asyncHandler, created, ok } from '../lib/http';
import { forbidden, notFound, unprocessable } from '../lib/errors';
import { parse, uuid, isoDate } from '../lib/validation';
import { iso, isoDate as fmtDate } from '../lib/serializers';
import { getPagination, pageMeta } from '../lib/pagination';
import { audit } from '../lib/audit';
import { authOf, hasPermission, requireAuth } from '../middleware/auth';
import { getFarmWithAccess } from '../services/access.service';
import { assertOwnDocuments } from '../services/document.service';

export const farmRecordsRouter = Router(); // mounted at /farms
export const cropsRouter = Router(); // /crops
export const observationsRouter = Router(); // /observations

farmRecordsRouter.use(requireAuth);
cropsRouter.use(requireAuth);
observationsRouter.use(requireAuth);

const HECTARES_PER = { hectare: 1, acre: 0.40468564224, square_meter: 0.0001 } as const;
const areaUnit = z.enum(['hectare', 'acre', 'square_meter']);

const serializeCrop = (c: CropRecord) => ({
  id: c.id,
  farm_id: c.farmId,
  visit_id: c.visitId,
  crop_type: c.cropType,
  variety: c.variety,
  season: c.season,
  planting_date: fmtDate(c.plantingDate),
  expected_harvest_date: fmtDate(c.expectedHarvestDate),
  area_planted: c.areaPlanted,
  area_unit: c.areaUnit,
  growth_stage: c.growthStage,
  notes: c.notes,
  recorded_by_id: c.recordedById,
  created_at: iso(c.createdAt),
  updated_at: iso(c.updatedAt),
});

const serializeLand = (m: FarmlandMeasurement) => ({
  id: m.id,
  farm_id: m.farmId,
  visit_id: m.visitId,
  area: m.area,
  area_unit: m.areaUnit,
  area_hectares: Math.round(m.areaHectares * 10000) / 10000,
  perimeter_meters: m.perimeterMeters,
  soil_type: m.soilType,
  terrain: m.terrain,
  irrigation: m.irrigation,
  measurement_method: m.measurementMethod,
  boundary: m.boundary,
  measured_at: iso(m.measuredAt),
  recorded_by_id: m.recordedById,
  created_at: iso(m.createdAt),
});

const serializeObservation = (o: Observation) => ({
  id: o.id,
  farm_id: o.farmId,
  crop_record_id: o.cropRecordId,
  visit_id: o.visitId,
  prediction_id: o.predictionId,
  type: o.type,
  name: o.name,
  crop_type: o.cropType,
  severity: o.severity,
  affected_area_percent: o.affectedAreaPercent,
  description: o.description,
  evidence_document_ids: o.evidenceDocumentIds,
  annotations: o.annotations ?? [],
  observed_at: iso(o.observedAt),
  recorded_by_id: o.recordedById,
  created_at: iso(o.createdAt),
  updated_at: iso(o.updatedAt),
});

/** A visit referenced by a record must be the caller's in-progress visit on the same farm. */
async function assertVisit(req: Request, farmId: string, visitId?: string) {
  if (!visitId) return;
  const visit = await prisma.farmVisit.findUnique({ where: { id: visitId } });
  if (!visit || visit.farmId !== farmId) throw unprocessable('Visit does not belong to this farm', [{ field: 'visit_id', reason: 'farm mismatch' }]);
  if (visit.dcoId !== authOf(req).userId && !hasPermission(req, 'records.write_all')) throw forbidden('Visit belongs to another DCO');
  if (visit.status !== 'in_progress') throw unprocessable('Visit is closed', [{ field: 'visit_id', reason: `visit is ${visit.status}` }]);
}

// ───────────── Crops ─────────────

const cropFields = {
  crop_type: z.string().trim().toLowerCase().min(2).max(50),
  variety: z.string().trim().max(100).nullable().optional(),
  season: z.string().trim().max(50).nullable().optional(),
  planting_date: isoDate.nullable().optional(),
  expected_harvest_date: isoDate.nullable().optional(),
  area_planted: z.number().positive().max(1_000_000).nullable().optional(),
  area_unit: areaUnit.nullable().optional(),
  growth_stage: z.string().trim().max(50).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
};
const toDate = (v: string | null | undefined) => (v === undefined ? undefined : v ? new Date(v) : null);

// GET /farms/{farmId}/crops
farmRecordsRouter.get(
  '/:farmId/crops',
  asyncHandler(async (req, res) => {
    const farm = await getFarmWithAccess(req, parse(uuid, req.params.farmId), 'read');
    const p = getPagination(req.query);
    const where = { farmId: farm.id };
    const [total, rows] = await Promise.all([
      prisma.cropRecord.count({ where }),
      prisma.cropRecord.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
    ]);
    ok(res, rows.map(serializeCrop), pageMeta(p, total));
  }),
);

// POST /farms/{farmId}/crops
farmRecordsRouter.post(
  '/:farmId/crops',
  asyncHandler(async (req, res) => {
    const farm = await getFarmWithAccess(req, parse(uuid, req.params.farmId), 'collect');
    const body = parse(
      z.object({ ...cropFields, visit_id: uuid.optional() }).refine((b) => !b.area_planted || !!b.area_unit, { message: 'required with area_planted', path: ['area_unit'] }),
      req.body,
    );
    await assertVisit(req, farm.id, body.visit_id);
    const crop = await prisma.cropRecord.create({
      data: {
        farmId: farm.id,
        visitId: body.visit_id,
        cropType: body.crop_type,
        variety: body.variety,
        season: body.season,
        plantingDate: toDate(body.planting_date),
        expectedHarvestDate: toDate(body.expected_harvest_date),
        areaPlanted: body.area_planted,
        areaUnit: body.area_unit,
        growthStage: body.growth_stage,
        notes: body.notes,
        recordedById: authOf(req).userId,
      },
    });
    await audit(req, 'crop.created', 'crop_record', crop.id, { farm_id: farm.id });
    created(res, serializeCrop(crop));
  }),
);

// PATCH /crops/{cropId}
cropsRouter.patch(
  '/:cropId',
  asyncHandler(async (req, res) => {
    const crop = await prisma.cropRecord.findUnique({ where: { id: parse(uuid, req.params.cropId) } });
    if (!crop) throw notFound('Crop record');
    await getFarmWithAccess(req, crop.farmId, 'collect');
    const body = parse(z.object(cropFields).partial().strict(), req.body);
    const updated = await prisma.cropRecord.update({
      where: { id: crop.id },
      data: {
        cropType: body.crop_type,
        variety: body.variety,
        season: body.season,
        plantingDate: toDate(body.planting_date),
        expectedHarvestDate: toDate(body.expected_harvest_date),
        areaPlanted: body.area_planted,
        areaUnit: body.area_unit,
        growthStage: body.growth_stage,
        notes: body.notes,
      },
    });
    await audit(req, 'crop.updated', 'crop_record', crop.id, { fields: Object.keys(body) });
    ok(res, serializeCrop(updated));
  }),
);

// ───────────── Farmland ─────────────

// GET /farms/{farmId}/farmland — latest measurement and history
farmRecordsRouter.get(
  '/:farmId/farmland',
  asyncHandler(async (req, res) => {
    const farm = await getFarmWithAccess(req, parse(uuid, req.params.farmId), 'read');
    const history = await prisma.farmlandMeasurement.findMany({ where: { farmId: farm.id }, orderBy: { measuredAt: 'desc' }, take: 50 });
    const cropArea = await prisma.cropRecord.findMany({ where: { farmId: farm.id, areaPlanted: { not: null } }, select: { areaPlanted: true, areaUnit: true } });
    const plantedHa = cropArea.reduce((sum, c) => sum + (c.areaPlanted ?? 0) * HECTARES_PER[c.areaUnit ?? 'hectare'], 0);
    const latest = history[0] ?? null;
    ok(res, {
      farm_id: farm.id,
      latest: latest ? serializeLand(latest) : null,
      metrics: latest
        ? {
            area_hectares: Math.round(latest.areaHectares * 10000) / 10000,
            area_acres: Math.round((latest.areaHectares / HECTARES_PER.acre) * 10000) / 10000,
            planted_hectares: Math.round(plantedHa * 10000) / 10000,
            utilization_percent: latest.areaHectares > 0 ? Math.round((plantedHa / latest.areaHectares) * 1000) / 10 : null,
          }
        : null,
      history: history.map(serializeLand),
    });
  }),
);

// POST /farms/{farmId}/farmland
farmRecordsRouter.post(
  '/:farmId/farmland',
  asyncHandler(async (req, res) => {
    const farm = await getFarmWithAccess(req, parse(uuid, req.params.farmId), 'collect');
    const body = parse(
      z.object({
        area: z.number().positive().max(10_000_000),
        area_unit: areaUnit,
        perimeter_meters: z.number().positive().max(10_000_000).optional(),
        soil_type: z.string().trim().max(50).optional(),
        terrain: z.string().trim().max(50).optional(),
        irrigation: z.string().trim().max(50).optional(),
        measurement_method: z.enum(['gps_walk', 'tape', 'satellite', 'estimate', 'other']).optional(),
        boundary: z
          .object({ type: z.literal('Polygon'), coordinates: z.array(z.array(z.tuple([z.number(), z.number()])).min(4)).min(1) })
          .optional(),
        measured_at: z.string().datetime({ offset: true }).optional(),
        visit_id: uuid.optional(),
      }),
      req.body,
    );
    await assertVisit(req, farm.id, body.visit_id);
    const m = await prisma.farmlandMeasurement.create({
      data: {
        farmId: farm.id,
        visitId: body.visit_id,
        area: body.area,
        areaUnit: body.area_unit,
        areaHectares: body.area * HECTARES_PER[body.area_unit],
        perimeterMeters: body.perimeter_meters,
        soilType: body.soil_type,
        terrain: body.terrain,
        irrigation: body.irrigation,
        measurementMethod: body.measurement_method,
        boundary: body.boundary as Prisma.InputJsonValue | undefined,
        measuredAt: body.measured_at ? new Date(body.measured_at) : undefined,
        recordedById: authOf(req).userId,
      },
    });
    await audit(req, 'farmland.recorded', 'farmland_measurement', m.id, { farm_id: farm.id });
    created(res, serializeLand(m));
  }),
);

// ───────────── Observations (disease / pest) ─────────────

const observationFields = {
  type: z.enum(['disease', 'pest']),
  name: z.string().trim().min(2).max(150),
  crop_type: z.string().trim().toLowerCase().max(50).nullable().optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).nullable().optional(),
  affected_area_percent: z.number().min(0).max(100).nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
};

// GET /farms/{farmId}/observations?type=
farmRecordsRouter.get(
  '/:farmId/observations',
  asyncHandler(async (req, res) => {
    const farm = await getFarmWithAccess(req, parse(uuid, req.params.farmId), 'read');
    const p = getPagination(req.query);
    const q = parse(z.object({ type: z.enum(['disease', 'pest']).optional() }).passthrough(), req.query);
    const where = { farmId: farm.id, ...(q.type ? { type: q.type } : {}) };
    const [total, rows] = await Promise.all([
      prisma.observation.count({ where }),
      prisma.observation.findMany({ where, orderBy: { observedAt: 'desc' }, skip: p.skip, take: p.take }),
    ]);
    ok(res, rows.map(serializeObservation), pageMeta(p, total));
  }),
);

// POST /farms/{farmId}/observations
farmRecordsRouter.post(
  '/:farmId/observations',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const farm = await getFarmWithAccess(req, parse(uuid, req.params.farmId), 'collect');
    const body = parse(
      z.object({
        ...observationFields,
        crop_record_id: uuid.optional(),
        prediction_id: uuid.optional(),
        visit_id: uuid.optional(),
        evidence_document_ids: z.array(uuid).max(10).default([]),
        observed_at: z.string().datetime({ offset: true }).optional(),
      }),
      req.body,
    );
    await assertVisit(req, farm.id, body.visit_id);
    await assertOwnDocuments(req, body.evidence_document_ids);
    if (body.crop_record_id) {
      const crop = await prisma.cropRecord.findUnique({ where: { id: body.crop_record_id } });
      if (!crop || crop.farmId !== farm.id) throw unprocessable('Crop record does not belong to this farm', [{ field: 'crop_record_id', reason: 'farm mismatch' }]);
    }
    if (body.prediction_id) {
      const pred = await prisma.aiPrediction.findUnique({ where: { id: body.prediction_id } });
      if (!pred || pred.userId !== auth.userId) throw unprocessable('Unknown prediction', [{ field: 'prediction_id', reason: 'not found' }]);
    }
    const o = await prisma.observation.create({
      data: {
        farmId: farm.id,
        type: body.type,
        name: body.name,
        cropType: body.crop_type,
        severity: body.severity,
        affectedAreaPercent: body.affected_area_percent,
        description: body.description,
        cropRecordId: body.crop_record_id,
        predictionId: body.prediction_id,
        visitId: body.visit_id,
        evidenceDocumentIds: body.evidence_document_ids,
        observedAt: body.observed_at ? new Date(body.observed_at) : undefined,
        recordedById: auth.userId,
      },
    });
    await audit(req, 'observation.created', 'observation', o.id, { farm_id: farm.id });
    created(res, serializeObservation(o));
  }),
);

async function loadObservation(req: Request, mode: 'read' | 'collect') {
  const o = await prisma.observation.findUnique({ where: { id: parse(uuid, req.params.observationId) } });
  if (!o) throw notFound('Observation');
  await getFarmWithAccess(req, o.farmId, mode);
  return o;
}

// GET /observations/{observationId}
observationsRouter.get(
  '/:observationId',
  asyncHandler(async (req, res) => {
    ok(res, serializeObservation(await loadObservation(req, 'read')));
  }),
);

// PATCH /observations/{observationId} — correct fields (recorder or records.write_all) and/or add an annotation
observationsRouter.patch(
  '/:observationId',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const o = await loadObservation(req, 'collect');
    const body = parse(z.object({ ...observationFields, annotation: z.string().trim().min(1).max(2000) }).partial().strict(), req.body);
    const { annotation, ...fields } = body;
    if (Object.keys(fields).length && o.recordedById !== auth.userId && !hasPermission(req, 'records.write_all')) {
      throw forbidden('Only the original recorder or an authorized administrator can correct this observation; add an annotation instead');
    }
    const annotations = (o.annotations as Prisma.JsonArray | null) ?? [];
    const updated = await prisma.observation.update({
      where: { id: o.id },
      data: {
        type: fields.type,
        name: fields.name,
        cropType: fields.crop_type,
        severity: fields.severity,
        affectedAreaPercent: fields.affected_area_percent,
        description: fields.description,
        ...(annotation ? { annotations: [...annotations, { by: auth.userId, at: new Date().toISOString(), note: annotation }] } : {}),
      },
    });
    await audit(req, 'observation.updated', 'observation', o.id, { fields: Object.keys(fields), annotated: !!annotation });
    ok(res, serializeObservation(updated));
  }),
);
