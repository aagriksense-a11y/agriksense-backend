import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { AssignmentStatus, Prisma } from '@prisma/client';
import type { FarmAssignment, FarmVisit, VisitRequest } from '@prisma/client';
import { prisma } from '../config/prisma';
import { asyncHandler, created, ok } from '../lib/http';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { parse, uuid, intId, isoDate } from '../lib/validation';
import { iso, isoDate as fmtDate, nairaStringToKobo, serializeFarm, userRef } from '../lib/serializers';
import { getPagination, pageMeta } from '../lib/pagination';
import { audit } from '../lib/audit';
import { authOf, hasPermission, requireAuth, requirePermission, requireRole } from '../middleware/auth';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { ACTIVE_ASSIGNMENT_STATUSES, canAccessFarm, getFarmWithAccess } from '../services/access.service';
import { assertLocation } from '../services/location.service';
import { NotificationService } from '../services/notification.service';
import { currentFareRate, estimateFares, requireFareRate, ROUTING_ASSUMPTIONS, serializeRate } from '../services/fare.service';

export const dcoRouter = Router();
export const adminVisitsRouter = Router();
export const assignmentsRouter = Router();
export const farmVisitsRouter = Router();

const point = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });

// ───────────── Serializers ─────────────

const serializeVisitRequest = (r: VisitRequest & { dco?: Parameters<typeof userRef>[0]; _count?: { assignments: number } }) => ({
  id: r.id,
  dco: r.dco ? userRef(r.dco) : { id: r.dcoId },
  mode: r.mode,
  status: r.status,
  known_farms: r.knownFarms,
  preference:
    r.mode === 'geographic_preference'
      ? { state_id: r.preferredStateId, lga_id: r.preferredLgaId, city: r.preferredCity, max_farms: r.maxFarms }
      : null,
  availability: r.availability,
  notes: r.notes,
  admin_notes: r.adminNotes,
  assignment_count: r._count?.assignments,
  created_at: iso(r.createdAt),
  updated_at: iso(r.updatedAt),
});

const serializeAssignment = (a: FarmAssignment & { farm?: Parameters<typeof serializeFarm>[0]; dco?: Parameters<typeof userRef>[0] }) => ({
  id: a.id,
  status: a.status,
  farm: a.farm ? serializeFarm(a.farm) : { id: a.farmId },
  dco: a.dco ? userRef(a.dco) : { id: a.dcoId },
  visit_request_id: a.visitRequestId,
  assigned_by_id: a.assignedById,
  scheduled_for: iso(a.scheduledFor),
  fare:
    a.fareKobo != null
      ? { amount_kobo: a.fareKobo, distance: a.distanceValue, distance_unit: a.distanceUnit, kobo_per_unit: a.fareRateKoboPerUnit, basis: a.fareBasis }
      : null,
  notes: a.notes,
  cancel_reason: a.cancelReason,
  created_at: iso(a.createdAt),
  updated_at: iso(a.updatedAt),
});

const serializeVisit = (v: FarmVisit) => ({
  id: v.id,
  farm_id: v.farmId,
  assignment_id: v.assignmentId,
  dco_id: v.dcoId,
  status: v.status,
  started_at: iso(v.startedAt),
  ended_at: iso(v.endedAt),
  check_in: v.checkInLat != null ? { latitude: v.checkInLat, longitude: v.checkInLng } : null,
  notes: v.notes,
  end_reason: v.endReason,
  data_collected: v.dataCollected,
  created_at: iso(v.createdAt),
  updated_at: iso(v.updatedAt),
});

// ───────────── DCO: visit requests & assignments ─────────────

dcoRouter.use(requireAuth, requireRole('dco'));

const knownFarm = z.object({
  name: z.string().trim().min(2).max(150),
  address: z.string().trim().min(3).max(300),
  landmark: z.string().trim().max(200).optional(),
  village: z.string().trim().max(100).optional(),
  city: z.string().trim().max(100).optional(),
  state_id: intId.optional(),
  lga_id: intId.optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  farmer_name: z.string().trim().max(150).optional(),
  farmer_phone: z.string().trim().max(20).optional(),
  estimated_round_trip_fare_kobo: z.number().int().min(0).max(100_000_000).optional(),
});
const visitRequestSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('known_farms'),
    known_farms: z.array(knownFarm).min(1).max(50),
    availability: z.record(z.unknown()).optional(),
    notes: z.string().max(1000).optional(),
  }),
  z.object({
    mode: z.literal('geographic_preference'),
    preferred_state_id: intId,
    preferred_lga_id: intId.optional(),
    preferred_city: z.string().trim().max(100).optional(),
    max_farms: z.number().int().min(1).max(100).optional(),
    availability: z.record(z.unknown()).optional(),
    notes: z.string().max(1000).optional(),
  }),
]);

// POST /dco/visit-requests
dcoRouter.post(
  '/visit-requests',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = parse(visitRequestSchema, req.body);
    if (body.mode === 'known_farms') {
      for (const [i, f] of body.known_farms.entries()) await assertLocation(f.state_id, f.lga_id, `known_farms.${i}.`);
    } else {
      await assertLocation(body.preferred_state_id, body.preferred_lga_id, 'preferred_');
    }
    const request = await prisma.visitRequest.create({
      data: {
        dcoId: auth.userId,
        mode: body.mode,
        knownFarms: body.mode === 'known_farms' ? (body.known_farms as Prisma.InputJsonValue) : undefined,
        preferredStateId: body.mode === 'geographic_preference' ? body.preferred_state_id : null,
        preferredLgaId: body.mode === 'geographic_preference' ? body.preferred_lga_id : null,
        preferredCity: body.mode === 'geographic_preference' ? body.preferred_city : null,
        maxFarms: body.mode === 'geographic_preference' ? body.max_farms : null,
        availability: body.availability as Prisma.InputJsonValue | undefined,
        notes: body.notes,
      },
    });
    await audit(req, 'visit_request.created', 'visit_request', request.id, { mode: body.mode });
    created(res, serializeVisitRequest(request));
  }),
);

// GET /dco/visit-requests
dcoRouter.get(
  '/visit-requests',
  asyncHandler(async (req, res) => {
    const p = getPagination(req.query);
    const where = { dcoId: authOf(req).userId };
    const [total, rows] = await Promise.all([
      prisma.visitRequest.count({ where }),
      prisma.visitRequest.findMany({ where, include: { _count: { select: { assignments: true } } }, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
    ]);
    ok(res, rows.map(serializeVisitRequest), pageMeta(p, total));
  }),
);

// GET /dco/farm-assignments?status=
dcoRouter.get(
  '/farm-assignments',
  asyncHandler(async (req, res) => {
    const p = getPagination(req.query);
    const q = parse(z.object({ status: z.nativeEnum(AssignmentStatus).optional() }).passthrough(), req.query);
    const where: Prisma.FarmAssignmentWhereInput = { dcoId: authOf(req).userId, ...(q.status ? { status: q.status } : {}) };
    const [total, rows] = await Promise.all([
      prisma.farmAssignment.count({ where }),
      prisma.farmAssignment.findMany({ where, include: { farm: { include: { state: true, lga: true, owner: true } } }, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
    ]);
    ok(res, rows.map(serializeAssignment), pageMeta(p, total));
  }),
);

// ───────────── Admin: visit request report, assignment, fare rates ─────────────

adminVisitsRouter.use(requireAuth);

// GET /admin/visit-requests?status=&mode=&state_id=&dco_id=
adminVisitsRouter.get(
  '/visit-requests',
  requirePermission('visit_requests.read_all'),
  asyncHandler(async (req, res) => {
    const p = getPagination(req.query);
    const q = parse(
      z
        .object({
          status: z.enum(['pending_assignment', 'partially_assigned', 'assigned', 'rejected', 'cancelled']).optional(),
          mode: z.enum(['known_farms', 'geographic_preference']).optional(),
          state_id: intId.optional(),
          dco_id: uuid.optional(),
        })
        .passthrough(),
      req.query,
    );
    const where: Prisma.VisitRequestWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.mode ? { mode: q.mode } : {}),
      ...(q.dco_id ? { dcoId: q.dco_id } : {}),
      ...(q.state_id ? { OR: [{ preferredStateId: q.state_id }, { dco: { stateId: q.state_id } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.visitRequest.count({ where }),
      prisma.visitRequest.findMany({ where, include: { dco: true, _count: { select: { assignments: true } } }, orderBy: { createdAt: 'asc' }, skip: p.skip, take: p.take }),
    ]);
    ok(res, rows.map(serializeVisitRequest), pageMeta(p, total));
  }),
);

// GET /admin/visit-requests/{requestId} — includes DCO residence, availability and proposed farms
adminVisitsRouter.get(
  '/visit-requests/:requestId',
  requirePermission('visit_requests.read_all'),
  asyncHandler(async (req, res) => {
    const request = await prisma.visitRequest.findUnique({
      where: { id: parse(uuid, req.params.requestId) },
      include: {
        dco: { include: { state: true, lga: true, dcoProfile: true } },
        assignments: { include: { farm: { include: { state: true, lga: true } } } },
        _count: { select: { assignments: true } },
      },
    });
    if (!request) throw notFound('Visit request');
    const d = request.dco;
    ok(res, {
      ...serializeVisitRequest(request),
      dco_profile: {
        ...userRef(d),
        phone: d.phone,
        email: d.email,
        onboarding_status: d.onboardingStatus,
        nin_verification_status: d.ninStatus,
        residence: { address: d.address, city: d.city, state: d.state ? { id: d.state.id, name: d.state.name } : null, lga: d.lga ? { id: d.lga.id, name: d.lga.name } : null },
        availability: d.dcoProfile?.availability ?? null,
        has_transport: d.dcoProfile?.hasTransport ?? null,
      },
      assignments: request.assignments.map(serializeAssignment),
    });
  }),
);

// POST /admin/farm-assignments — assign one or many farms to a DCO
const assignmentSchema = z.object({
  dco_id: uuid,
  farm_ids: z.array(uuid).min(1).max(50),
  visit_request_id: uuid.optional(),
  scheduled_for: z.string().datetime({ offset: true }).optional(),
  origin: point.optional(),
  notes: z.string().max(1000).optional(),
  override_preference: z.boolean().default(false),
  override_reason: z.string().max(500).optional(),
});
adminVisitsRouter.post(
  '/farm-assignments',
  requirePermission('farm_assignments.manage'),
  requireIdempotencyKey,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = parse(assignmentSchema, req.body);
    if (body.override_preference && !body.override_reason) {
      throw unprocessable('override_reason is required when overriding the DCO preference', [{ field: 'override_reason', reason: 'required' }]);
    }
    const dco = await prisma.user.findUnique({ where: { id: body.dco_id } });
    if (!dco || dco.baseRole !== 'dco') throw unprocessable('Assignee must be a DCO', [{ field: 'dco_id', reason: 'not a DCO' }]);
    if (!dco.isActive) throw unprocessable('DCO account is disabled', [{ field: 'dco_id', reason: 'disabled' }]);

    let request: VisitRequest | null = null;
    if (body.visit_request_id) {
      request = await prisma.visitRequest.findUnique({ where: { id: body.visit_request_id } });
      if (!request) throw unprocessable('Unknown visit request', [{ field: 'visit_request_id', reason: 'not found' }]);
      if (request.dcoId !== dco.id) throw unprocessable('Visit request belongs to a different DCO', [{ field: 'visit_request_id', reason: 'dco mismatch' }]);
      if (!['pending_assignment', 'partially_assigned'].includes(request.status)) throw conflict(`Visit request is ${request.status}`);
    }

    const uniqueFarmIds = [...new Set(body.farm_ids)];
    const farms = await prisma.farm.findMany({ where: { id: { in: uniqueFarmIds } } });
    const errors: { field: string; reason: string }[] = [];
    uniqueFarmIds.forEach((id, i) => {
      const farm = farms.find((f) => f.id === id);
      if (!farm) errors.push({ field: `farm_ids.${i}`, reason: 'farm not found' });
      else if (!farm.isActive) errors.push({ field: `farm_ids.${i}`, reason: 'farm is inactive' });
      else if (request?.mode === 'geographic_preference' && !body.override_preference) {
        if (farm.stateId !== request.preferredStateId) errors.push({ field: `farm_ids.${i}`, reason: 'farm is outside the DCO preferred state' });
        else if (request.preferredLgaId && farm.lgaId !== request.preferredLgaId) errors.push({ field: `farm_ids.${i}`, reason: 'farm is outside the DCO preferred LGA' });
        else if (request.preferredCity && farm.city.toLowerCase() !== request.preferredCity.toLowerCase()) errors.push({ field: `farm_ids.${i}`, reason: 'farm is outside the DCO preferred city/town' });
      }
    });
    if (errors.length) throw unprocessable('One or more farms cannot be assigned', errors, 'ASSIGNMENT_INVALID');

    const existing = await prisma.farmAssignment.findMany({
      where: { farmId: { in: uniqueFarmIds }, dcoId: dco.id, status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
      select: { farmId: true },
    });
    if (existing.length) {
      throw conflict('DCO already has an active assignment for some farms', existing.map((e) => ({ field: 'farm_ids', reason: `farm ${e.farmId} already assigned` })));
    }

    // Fare per farm (round trip from origin) where origin, farm coordinates and a state rate exist.
    const fareFor = async (farm: (typeof farms)[number]) => {
      if (!body.origin || farm.latitude == null || farm.longitude == null) return null;
      const rate = await currentFareRate(farm.stateId);
      if (!rate) return null;
      const est = estimateFares(body.origin, [{ key: farm.id, latitude: farm.latitude, longitude: farm.longitude }], rate.koboPerMile);
      return { rate, est: est.per_farm[0] };
    };

    const createdAssignments = await prisma.$transaction(async (tx) => {
      const out = [];
      for (const farmId of uniqueFarmIds) {
        const farm = farms.find((f) => f.id === farmId)!;
        const fare = await fareFor(farm);
        out.push(
          await tx.farmAssignment.create({
            data: {
              farmId,
              dcoId: dco.id,
              visitRequestId: request?.id,
              assignedById: auth.userId,
              scheduledFor: body.scheduled_for ? new Date(body.scheduled_for) : null,
              notes: body.notes,
              ...(fare
                ? {
                    fareKobo: fare.est.fare_kobo,
                    distanceValue: fare.est.round_trip_miles,
                    distanceUnit: 'mile',
                    fareRateKoboPerUnit: fare.rate.koboPerMile,
                    fareBasis: { ...ROUTING_ASSUMPTIONS(), trip: 'round_trip', origin: body.origin, rate_effective_from: fmtDate(fare.rate.effectiveFrom) },
                  }
                : {}),
            },
            include: { farm: { include: { state: true, lga: true, owner: true } }, dco: true },
          }),
        );
      }
      if (request) {
        const total = await tx.farmAssignment.count({ where: { visitRequestId: request.id, status: { not: 'cancelled' } } });
        const target = request.mode === 'known_farms' ? ((request.knownFarms as unknown[]) ?? []).length : request.maxFarms ?? total;
        await tx.visitRequest.update({ where: { id: request.id }, data: { status: total >= target ? 'assigned' : 'partially_assigned' } });
      }
      return out;
    });

    await NotificationService.inApp(dco.id, 'farm_assignment', 'New farm assignment', `You have been assigned ${createdAssignments.length} farm(s).`, {
      assignment_ids: createdAssignments.map((a) => a.id),
    });
    await audit(req, 'farm_assignment.created', 'farm_assignment', null, {
      dco_id: dco.id,
      assignment_ids: createdAssignments.map((a) => a.id),
      override_preference: body.override_preference,
      override_reason: body.override_reason,
    });
    created(res, createdAssignments.map(serializeAssignment));
  }),
);

// GET /admin/fare-rates — current and scheduled rate per state
adminVisitsRouter.get(
  '/fare-rates',
  requirePermission('fare_rates.manage'),
  asyncHandler(async (_req, res) => {
    const states = await prisma.state.findMany({ orderBy: { name: 'asc' }, include: { fareRates: { orderBy: { effectiveFrom: 'desc' } } } });
    const today = new Date();
    ok(
      res,
      states.map((s) => {
        const current = s.fareRates.find((r) => r.effectiveFrom <= today) ?? null;
        const scheduled = s.fareRates.filter((r) => r.effectiveFrom > today).reverse();
        return {
          state: { id: s.id, name: s.name },
          distance_unit: 'mile',
          current: current ? serializeRate(current) : null,
          scheduled: scheduled.map(serializeRate),
        };
      }),
    );
  }),
);

// PUT /admin/fare-rates/{stateId} — NGN per mile, effective from a date (default today)
adminVisitsRouter.put(
  '/fare-rates/:stateId',
  requirePermission('fare_rates.manage'),
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const stateId = parse(intId, req.params.stateId);
    const body = parse(
      z.object({ naira_per_mile: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'must be a decimal string such as "250.00"'), effective_from: isoDate.optional() }),
      req.body,
    );
    const state = await prisma.state.findUnique({ where: { id: stateId } });
    if (!state) throw notFound('State');
    const koboPerMile = nairaStringToKobo(body.naira_per_mile);
    if (koboPerMile <= 0) throw unprocessable('Rate must be greater than zero', [{ field: 'naira_per_mile', reason: 'must be > 0' }]);
    const effectiveFrom = new Date(body.effective_from ?? new Date().toISOString().slice(0, 10));
    const rate = await prisma.fareRate.upsert({
      where: { stateId_effectiveFrom: { stateId, effectiveFrom } },
      create: { stateId, koboPerMile, effectiveFrom, setById: auth.userId },
      update: { koboPerMile, setById: auth.userId },
    });
    await audit(req, 'fare_rate.set', 'state', String(stateId), { kobo_per_mile: koboPerMile, effective_from: fmtDate(effectiveFrom) });
    ok(res, { ...serializeRate(rate), state_name: state.name, distance_unit: 'mile' });
  }),
);

// ───────────── Assignments (shared) ─────────────

assignmentsRouter.use(requireAuth);

async function loadAssignment(req: Request, id: string) {
  const a = await prisma.farmAssignment.findUnique({
    where: { id },
    include: { farm: { include: { state: true, lga: true, owner: true } }, dco: true },
  });
  if (!a) throw notFound('Assignment');
  const auth = authOf(req);
  const allowed =
    a.dcoId === auth.userId ||
    hasPermission(req, 'farm_assignments.manage') ||
    hasPermission(req, 'visit_requests.read_all') ||
    (await canAccessFarm(req, a.farm, 'read'));
  if (!allowed) throw notFound('Assignment');
  return a;
}

// GET /farm-assignments/{assignmentId}
assignmentsRouter.get(
  '/:assignmentId',
  asyncHandler(async (req, res) => {
    const a = await loadAssignment(req, parse(uuid, req.params.assignmentId));
    const visits = await prisma.farmVisit.findMany({ where: { assignmentId: a.id }, orderBy: { startedAt: 'desc' } });
    ok(res, { ...serializeAssignment(a), visits: visits.map(serializeVisit) });
  }),
);

const TRANSITIONS: Record<AssignmentStatus, AssignmentStatus[]> = {
  assigned: ['accepted', 'cancelled'],
  accepted: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

// PATCH /farm-assignments/{assignmentId}/status
assignmentsRouter.patch(
  '/:assignmentId/status',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = parse(z.object({ status: z.enum(['accepted', 'in_progress', 'completed', 'cancelled']), reason: z.string().max(500).optional() }), req.body);
    const a = await loadAssignment(req, parse(uuid, req.params.assignmentId));
    const isDco = a.dcoId === auth.userId;
    const isManager = hasPermission(req, 'farm_assignments.manage');
    if (!isDco && !(isManager && body.status === 'cancelled')) throw forbidden('Only the assigned DCO can progress this assignment; managers may cancel it');
    if (!TRANSITIONS[a.status].includes(body.status)) {
      throw new ApiError(409, 'INVALID_TRANSITION', `Cannot change assignment from ${a.status} to ${body.status}`);
    }
    if (body.status === 'cancelled' && !body.reason) throw unprocessable('A reason is required to cancel', [{ field: 'reason', reason: 'required' }]);
    if (body.status === 'completed') {
      const open = await prisma.farmVisit.count({ where: { assignmentId: a.id, status: 'in_progress' } });
      if (open) throw conflict('Close the in-progress farm visit first');
      const finished = await prisma.farmVisit.count({ where: { assignmentId: a.id, status: { in: ['completed', 'ended_early'] } } });
      if (!finished) throw unprocessable('Record and close at least one farm visit before completing the assignment', undefined, 'VISIT_REQUIRED');
    }
    const updated = await prisma.farmAssignment.update({
      where: { id: a.id },
      data: { status: body.status, cancelReason: body.status === 'cancelled' ? body.reason : undefined },
      include: { farm: { include: { state: true, lga: true, owner: true } }, dco: true },
    });
    if (!isDco) await NotificationService.inApp(a.dcoId, 'farm_assignment', 'Assignment cancelled', `Your assignment for ${a.farm.name} was cancelled.`, { assignment_id: a.id });
    await audit(req, 'farm_assignment.status_changed', 'farm_assignment', a.id, { from: a.status, to: body.status });
    ok(res, serializeAssignment(updated));
  }),
);

// ───────────── Farm visits & fare estimates ─────────────

farmVisitsRouter.use(requireAuth);

// POST /farm-visits/fare-estimates
const estimateSchema = z.object({
  state_id: intId,
  origin: point,
  farms: z
    .array(z.union([z.object({ farm_id: uuid }), point.extend({ label: z.string().max(100).optional() })]))
    .min(1)
    .max(25),
});
farmVisitsRouter.post(
  '/fare-estimates',
  asyncHandler(async (req, res) => {
    const body = parse(estimateSchema, req.body);
    const rate = await requireFareRate(body.state_id);
    const stops = [];
    for (const [i, f] of body.farms.entries()) {
      if ('farm_id' in f) {
        const farm = await getFarmWithAccess(req, f.farm_id, 'read').catch(() => null);
        if (!farm && !hasPermission(req, 'farm_assignments.manage')) throw unprocessable('Farm not found', [{ field: `farms.${i}.farm_id`, reason: 'not found' }]);
        const target = farm ?? (await prisma.farm.findUnique({ where: { id: f.farm_id } }));
        if (!target) throw unprocessable('Farm not found', [{ field: `farms.${i}.farm_id`, reason: 'not found' }]);
        if (target.latitude == null || target.longitude == null) {
          throw unprocessable('Farm has no coordinates', [{ field: `farms.${i}.farm_id`, reason: 'missing latitude/longitude' }]);
        }
        stops.push({ key: target.id, latitude: target.latitude, longitude: target.longitude });
      } else {
        stops.push({ key: f.label ?? `stop_${i + 1}`, latitude: f.latitude, longitude: f.longitude });
      }
    }
    const est = estimateFares(body.origin, stops, rate.koboPerMile);
    ok(res, { rate: serializeRate(rate), assumptions: ROUTING_ASSUMPTIONS(), ...est });
  }),
);

// POST /farm-visits — start a visit on an assigned farm
farmVisitsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = parse(
      z.object({ assignment_id: uuid.optional(), farm_id: uuid.optional(), check_in: point.optional(), notes: z.string().max(2000).optional() }).refine((b) => b.assignment_id || b.farm_id, {
        message: 'assignment_id or farm_id is required',
        path: ['assignment_id'],
      }),
      req.body,
    );
    let assignment = null;
    if (body.assignment_id) {
      assignment = await prisma.farmAssignment.findUnique({ where: { id: body.assignment_id } });
      if (!assignment || assignment.dcoId !== auth.userId) throw notFound('Assignment');
      if (!['accepted', 'in_progress'].includes(assignment.status)) {
        throw new ApiError(409, 'INVALID_TRANSITION', `Accept the assignment before starting a visit (current status: ${assignment.status})`);
      }
      if (body.farm_id && body.farm_id !== assignment.farmId) throw unprocessable('farm_id does not match the assignment', [{ field: 'farm_id', reason: 'mismatch' }]);
    } else if (!hasPermission(req, 'records.write_all')) {
      throw forbidden('Visits are recorded against an assignment');
    }
    const farmId = assignment?.farmId ?? body.farm_id!;
    await getFarmWithAccess(req, farmId, 'collect');
    if (assignment) {
      const open = await prisma.farmVisit.findFirst({ where: { assignmentId: assignment.id, status: 'in_progress' } });
      if (open) throw conflict('A visit for this assignment is already in progress', { visit_id: open.id });
    }
    const visit = await prisma.$transaction(async (tx) => {
      if (assignment && assignment.status === 'accepted') {
        await tx.farmAssignment.update({ where: { id: assignment.id }, data: { status: 'in_progress' } });
      }
      return tx.farmVisit.create({
        data: { farmId, assignmentId: assignment?.id, dcoId: auth.userId, checkInLat: body.check_in?.latitude, checkInLng: body.check_in?.longitude, notes: body.notes },
      });
    });
    await audit(req, 'farm_visit.started', 'farm_visit', visit.id, { farm_id: farmId });
    created(res, serializeVisit(visit));
  }),
);

async function loadVisit(req: Request, id: string) {
  const v = await prisma.farmVisit.findUnique({ where: { id }, include: { farm: true } });
  if (!v) throw notFound('Farm visit');
  if (v.dcoId !== authOf(req).userId && !(await canAccessFarm(req, v.farm, 'read'))) throw notFound('Farm visit');
  return v;
}

// GET /farm-visits/{visitId} — includes the records captured during the visit
farmVisitsRouter.get(
  '/:visitId',
  asyncHandler(async (req, res) => {
    const v = await loadVisit(req, parse(uuid, req.params.visitId));
    const [crops, farmland, observations] = await Promise.all([
      prisma.cropRecord.count({ where: { visitId: v.id } }),
      prisma.farmlandMeasurement.count({ where: { visitId: v.id } }),
      prisma.observation.count({ where: { visitId: v.id } }),
    ]);
    ok(res, { ...serializeVisit(v), data_collection: { crop_records: crops, farmland_measurements: farmland, observations } });
  }),
);

// PATCH /farm-visits/{visitId} — notes, collected data, completion or voluntary early end
farmVisitsRouter.patch(
  '/:visitId',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const v = await loadVisit(req, parse(uuid, req.params.visitId));
    if (v.dcoId !== auth.userId && !hasPermission(req, 'records.write_all')) throw forbidden();
    const body = parse(
      z
        .object({
          notes: z.string().max(2000).optional(),
          data_collected: z.record(z.unknown()).optional(),
          status: z.enum(['completed', 'ended_early']).optional(),
          end_reason: z.string().max(500).optional(),
        })
        .strict()
        .refine((b) => b.status !== 'ended_early' || !!b.end_reason, { message: 'required when ending a visit early', path: ['end_reason'] }),
      req.body,
    );
    if (v.status !== 'in_progress') throw conflict(`Visit is already ${v.status}`);
    const updated = await prisma.farmVisit.update({
      where: { id: v.id },
      data: {
        notes: body.notes,
        dataCollected: body.data_collected as Prisma.InputJsonValue | undefined,
        status: body.status,
        endReason: body.end_reason,
        endedAt: body.status ? new Date() : undefined,
      },
    });
    await audit(req, 'farm_visit.updated', 'farm_visit', v.id, { status: body.status });
    ok(res, serializeVisit(updated));
  }),
);
