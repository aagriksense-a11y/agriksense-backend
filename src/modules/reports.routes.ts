import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { stringify } from 'csv-stringify/sync';
import { prisma } from '../config/prisma';
import { asyncHandler, ok } from '../lib/http';
import { forbidden } from '../lib/errors';
import { parse, uuid, intId, isoDate } from '../lib/validation';
import { iso, isoDate as fmtDate } from '../lib/serializers';
import { getPagination, pageMeta } from '../lib/pagination';
import { audit } from '../lib/audit';
import { authOf, hasPermission, requireAuth } from '../middleware/auth';
import { farmScopeFilter } from '../services/access.service';

const router = Router();
router.use(requireAuth);

const REPORT_TYPES = ['crops', 'farmland', 'diseases-pests', 'farm-visits'] as const;
type ReportType = (typeof REPORT_TYPES)[number];

const filterSchema = z
  .object({
    farmer_id: uuid.optional(),
    farm_id: uuid.optional(),
    state_id: intId.optional(),
    lga_id: intId.optional(),
    city: z.string().max(100).optional(),
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
    crop: z.string().trim().toLowerCase().max(50).optional(),
  })
  .passthrough();
type Filters = z.infer<typeof filterSchema>;

/** Farm filter = caller's scope ∩ geographic/farmer/farm filters. */
async function farmWhere(req: Request, f: Filters): Promise<Prisma.FarmWhereInput> {
  const scope = hasPermission(req, 'reports.read_all') ? {} : await farmScopeFilter(req);
  return {
    AND: [
      scope,
      f.farmer_id ? { ownerId: f.farmer_id } : {},
      f.farm_id ? { id: f.farm_id } : {},
      f.state_id ? { stateId: f.state_id } : {},
      f.lga_id ? { lgaId: f.lga_id } : {},
      f.city ? { city: { equals: f.city, mode: 'insensitive' as const } } : {},
    ],
  };
}

function dateRange(f: Filters) {
  if (!f.date_from && !f.date_to) return undefined;
  return {
    ...(f.date_from ? { gte: new Date(f.date_from) } : {}),
    ...(f.date_to ? { lt: new Date(new Date(f.date_to).getTime() + 86400_000) } : {}),
  };
}

const farmSelect = { id: true, name: true, city: true, owner: { select: { agriksenseId: true } }, state: { select: { id: true, name: true } }, lga: { select: { id: true, name: true } } } as const;
type FarmSummary = Prisma.FarmGetPayload<{ select: typeof farmSelect }>;
// Sensitive fields (phones, NIN, bank data, private images) are never part of report rows.
const farmCols = (f: FarmSummary) => ({
  farm_id: f.id,
  farm_name: f.name,
  farmer_agriksense_id: f.owner?.agriksenseId ?? null,
  state: f.state.name,
  lga: f.lga.name,
  city: f.city,
});

interface ReportQuery {
  count: () => Promise<number>;
  rows: (skip?: number, take?: number) => Promise<Record<string, unknown>[]>;
  charts: () => Promise<{ bar: { title: string; data: { label: string; value: number }[] }; pie: { title: string; data: { label: string; value: number }[] } }>;
}

function tally<T>(items: T[], key: (t: T) => string | null | undefined, value: (t: T) => number = () => 1) {
  const map = new Map<string, number>();
  for (const it of items) {
    const k = key(it) ?? 'unspecified';
    map.set(k, (map.get(k) ?? 0) + value(it));
  }
  return [...map.entries()].map(([label, v]) => ({ label, value: Math.round(v * 100) / 100 })).sort((a, b) => b.value - a.value);
}

async function buildReport(req: Request, type: ReportType, f: Filters): Promise<ReportQuery> {
  const farm = await farmWhere(req, f);
  const range = dateRange(f);
  const auth = authOf(req);

  if (type === 'crops') {
    const where: Prisma.CropRecordWhereInput = { farm, ...(range ? { createdAt: range } : {}), ...(f.crop ? { cropType: f.crop } : {}) };
    return {
      count: () => prisma.cropRecord.count({ where }),
      rows: async (skip, take) =>
        (await prisma.cropRecord.findMany({ where, include: { farm: { select: farmSelect } }, orderBy: { createdAt: 'desc' }, skip, take })).map((c) => ({
          id: c.id,
          crop_type: c.cropType,
          variety: c.variety,
          season: c.season,
          planting_date: fmtDate(c.plantingDate),
          expected_harvest_date: fmtDate(c.expectedHarvestDate),
          area_planted: c.areaPlanted,
          area_unit: c.areaUnit,
          growth_stage: c.growthStage,
          ...farmCols(c.farm),
          recorded_at: iso(c.createdAt),
        })),
      charts: async () => {
        const items = await prisma.cropRecord.findMany({ where, select: { cropType: true, farm: { select: { state: { select: { name: true } } } } } });
        return {
          bar: { title: 'Crop records by state', data: tally(items, (i) => i.farm.state.name) },
          pie: { title: 'Crop records by crop type', data: tally(items, (i) => i.cropType) },
        };
      },
    };
  }

  if (type === 'farmland') {
    const where: Prisma.FarmlandMeasurementWhereInput = { farm: f.crop ? { AND: [farm, { crops: { some: { cropType: f.crop } } }] } : farm, ...(range ? { measuredAt: range } : {}) };
    return {
      count: () => prisma.farmlandMeasurement.count({ where }),
      rows: async (skip, take) =>
        (await prisma.farmlandMeasurement.findMany({ where, include: { farm: { select: farmSelect } }, orderBy: { measuredAt: 'desc' }, skip, take })).map((m) => ({
          id: m.id,
          area: m.area,
          area_unit: m.areaUnit,
          area_hectares: Math.round(m.areaHectares * 10000) / 10000,
          soil_type: m.soilType,
          terrain: m.terrain,
          irrigation: m.irrigation,
          measurement_method: m.measurementMethod,
          ...farmCols(m.farm),
          measured_at: iso(m.measuredAt),
        })),
      charts: async () => {
        const items = await prisma.farmlandMeasurement.findMany({ where, select: { areaHectares: true, soilType: true, farm: { select: { state: { select: { name: true } } } } } });
        return {
          bar: { title: 'Measured farmland (hectares) by state', data: tally(items, (i) => i.farm.state.name, (i) => i.areaHectares) },
          pie: { title: 'Measurements by soil type', data: tally(items, (i) => i.soilType) },
        };
      },
    };
  }

  if (type === 'diseases-pests') {
    const where: Prisma.ObservationWhereInput = { farm, ...(range ? { observedAt: range } : {}), ...(f.crop ? { cropType: f.crop } : {}) };
    return {
      count: () => prisma.observation.count({ where }),
      rows: async (skip, take) =>
        (await prisma.observation.findMany({ where, include: { farm: { select: farmSelect } }, orderBy: { observedAt: 'desc' }, skip, take })).map((o) => ({
          id: o.id,
          type: o.type,
          name: o.name,
          crop_type: o.cropType,
          severity: o.severity,
          affected_area_percent: o.affectedAreaPercent,
          ai_assisted: !!o.predictionId,
          ...farmCols(o.farm),
          observed_at: iso(o.observedAt),
        })),
      charts: async () => {
        const items = await prisma.observation.findMany({ where, select: { type: true, name: true, severity: true, farm: { select: { state: { select: { name: true } } } } } });
        return {
          bar: { title: 'Top diseases and pests', data: tally(items, (i) => `${i.name} (${i.type})`).slice(0, 15) },
          pie: { title: 'Observations by severity', data: tally(items, (i) => i.severity) },
        };
      },
    };
  }

  // farm-visits: DCO visit requests / assignments. DCOs see their own; farmers/orgs see their scoped farms.
  const where: Prisma.FarmAssignmentWhereInput = {
    ...(hasPermission(req, 'reports.read_all') || hasPermission(req, 'visit_requests.read_all') ? { farm } : auth.role === 'dco' ? { dcoId: auth.userId, farm } : { farm }),
    ...(range ? { createdAt: range } : {}),
    ...(f.crop ? { farm: { AND: [farm, { crops: { some: { cropType: f.crop } } }] } } : {}),
  };
  return {
    count: () => prisma.farmAssignment.count({ where }),
    rows: async (skip, take) =>
      (
        await prisma.farmAssignment.findMany({
          where,
          include: { farm: { select: farmSelect }, dco: { select: { agriksenseId: true } }, visitRequest: { select: { id: true, mode: true, status: true } }, _count: { select: { visits: true } } },
          orderBy: { createdAt: 'desc' },
          skip,
          take,
        })
      ).map((a) => ({
        assignment_id: a.id,
        status: a.status,
        dco_agriksense_id: a.dco.agriksenseId,
        visit_request_id: a.visitRequest?.id ?? null,
        visit_request_mode: a.visitRequest?.mode ?? null,
        scheduled_for: iso(a.scheduledFor),
        fare_kobo: a.fareKobo,
        distance: a.distanceValue,
        distance_unit: a.distanceUnit,
        visits: a._count.visits,
        ...farmCols(a.farm),
        assigned_at: iso(a.createdAt),
      })),
    charts: async () => {
      const items = await prisma.farmAssignment.findMany({ where, select: { status: true, farm: { select: { state: { select: { name: true } } } } } });
      return {
        bar: { title: 'Farm assignments by state', data: tally(items, (i) => i.farm.state.name) },
        pie: { title: 'Assignments by status', data: tally(items, (i) => i.status) },
      };
    },
  };
}

async function summary(req: Request, type: ReportType, f: Filters) {
  if (type !== 'farm-visits') return undefined;
  if (!hasPermission(req, 'reports.read_all') && !hasPermission(req, 'visit_requests.read_all')) return undefined;
  const range = dateRange(f);
  const requests = await prisma.visitRequest.groupBy({ by: ['status'], where: range ? { createdAt: range } : {}, _count: true });
  return { visit_requests_by_status: Object.fromEntries(requests.map((r) => [r.status, r._count])) };
}

function reportRoute(type: ReportType) {
  return asyncHandler(async (req: Request, res: Response) => {
    const f = parse(filterSchema, req.query);
    const p = getPagination(req.query);
    const report = await buildReport(req, type, f);
    const [total, rows, extra] = await Promise.all([report.count(), report.rows(p.skip, p.take), summary(req, type, f)]);
    ok(res, rows, { ...pageMeta(p, total), filters: f, ...(extra ? { summary: extra } : {}) });
  });
}

// GET /reports/crops | /reports/farmland | /reports/diseases-pests | /reports/farm-visits
router.get('/crops', reportRoute('crops'));
router.get('/farmland', reportRoute('farmland'));
router.get('/diseases-pests', reportRoute('diseases-pests'));
router.get('/farm-visits', reportRoute('farm-visits'));

const reportType = z.enum(REPORT_TYPES, { errorMap: () => ({ message: `report type must be one of ${REPORT_TYPES.join(', ')}` }) });

// GET /reports/{reportType}/charts — bar and pie aggregations
router.get(
  '/:reportType/charts',
  asyncHandler(async (req, res) => {
    const type = parse(reportType, req.params.reportType);
    const f = parse(filterSchema, req.query);
    const report = await buildReport(req, type, f);
    ok(res, { report_type: type, ...(await report.charts()) }, { filters: f });
  }),
);

// GET /reports/{reportType}/export — CSV (max 50,000 rows)
router.get(
  '/:reportType/export',
  asyncHandler(async (req, res) => {
    const type = parse(reportType, req.params.reportType);
    if (hasPermission(req, 'reports.read_all') && !hasPermission(req, 'reports.export')) throw forbidden('Missing permission: reports.export');
    const f = parse(filterSchema, req.query);
    const report = await buildReport(req, type, f);
    const rows = await report.rows(0, 50_000);
    const columns = rows.length ? Object.keys(rows[0]) : ['id'];
    const csv = stringify([columns, ...rows.map((r) => columns.map((c) => (r[c] == null ? '' : String(r[c]))))]);
    await audit(req, 'report.exported', 'report', type, { rows: rows.length, filters: f });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agriksense-${type}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.status(200).send(csv);
  }),
);

export default router;
