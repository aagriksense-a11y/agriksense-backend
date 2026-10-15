import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { asyncHandler, created, ok } from '../lib/http';
import { forbidden, unprocessable } from '../lib/errors';
import { parse, uuid, intId, booleanish } from '../lib/validation';
import { serializeFarm } from '../lib/serializers';
import { getPagination, orderBy, pageMeta } from '../lib/pagination';
import { audit } from '../lib/audit';
import { authOf, hasPermission, requireAuth, requireRole } from '../middleware/auth';
import { ACTIVE_ASSIGNMENT_STATUSES, farmScopeFilter, getFarmWithAccess } from '../services/access.service';
import { assertLocation } from '../services/location.service';

export const farmsRouter = Router();
export const farmerFarmsRouter = Router();

const farmInclude = { state: true, lga: true, owner: true } as const;

const farmFields = {
  name: z.string().trim().min(2).max(150),
  address: z.string().trim().min(3).max(300),
  landmark: z.string().trim().max(200).nullable().optional(),
  village: z.string().trim().max(100).nullable().optional(),
  city: z.string().trim().min(1).max(100),
  state_id: intId,
  lga_id: intId,
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
};

farmsRouter.use(requireAuth);

// GET /farms?state_id=&lga_id=&city=&farmer_id=&dco_id=&assigned=&search=
farmsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const p = getPagination(req.query);
    const q = parse(
      z
        .object({
          state_id: intId.optional(),
          lga_id: intId.optional(),
          city: z.string().max(100).optional(),
          farmer_id: uuid.optional(),
          dco_id: uuid.optional(),
          assigned: booleanish.optional(),
        })
        .passthrough(),
      req.query,
    );
    const filters: Prisma.FarmWhereInput[] = [await farmScopeFilter(req), { isActive: true }];
    if (q.state_id) filters.push({ stateId: q.state_id });
    if (q.lga_id) filters.push({ lgaId: q.lga_id });
    if (q.city) filters.push({ city: { equals: q.city, mode: 'insensitive' } });
    if (q.farmer_id) filters.push({ ownerId: q.farmer_id });
    if (q.dco_id) filters.push({ assignments: { some: { dcoId: q.dco_id, status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } } } });
    if (q.assigned !== undefined) {
      const active = { assignments: { some: { status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } } } };
      filters.push(q.assigned ? active : { NOT: active });
    }
    if (p.search) {
      filters.push({
        OR: [
          { name: { contains: p.search, mode: 'insensitive' } },
          { address: { contains: p.search, mode: 'insensitive' } },
          { village: { contains: p.search, mode: 'insensitive' } },
          { landmark: { contains: p.search, mode: 'insensitive' } },
        ],
      });
    }
    const where = { AND: filters };
    const [total, farms] = await Promise.all([
      prisma.farm.count({ where }),
      prisma.farm.findMany({
        where,
        include: { ...farmInclude, assignments: { where: { status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } }, select: { id: true, dcoId: true, status: true } } },
        orderBy: orderBy(p.sort, { name: 'name', created_at: 'createdAt', city: 'city' }),
        skip: p.skip,
        take: p.take,
      }),
    ]);
    ok(
      res,
      farms.map((f) => ({ ...serializeFarm(f), active_assignments: f.assignments.map((a) => ({ id: a.id, dco_id: a.dcoId, status: a.status })) })),
      pageMeta(p, total),
    );
  }),
);

// POST /farms — farmers create their own farms; admins (farms.write_all) may create for any farmer or unowned
farmsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = parse(z.object({ ...farmFields, owner_id: uuid.nullable().optional() }), req.body);
    const isAdmin = hasPermission(req, 'farms.write_all');
    if (!isAdmin && auth.role !== 'farmer') throw forbidden('Only farmers or authorized administrators can create farms');
    let ownerId: string | null = auth.role === 'farmer' && !isAdmin ? auth.userId : null;
    if (body.owner_id !== undefined) {
      if (!isAdmin && body.owner_id !== auth.userId) throw forbidden('You may only create farms you own');
      if (body.owner_id) {
        const owner = await prisma.user.findUnique({ where: { id: body.owner_id }, select: { baseRole: true } });
        if (!owner || owner.baseRole !== 'farmer') throw unprocessable('Farm owner must be a farmer', [{ field: 'owner_id', reason: 'not a farmer' }]);
      }
      ownerId = body.owner_id;
    } else if (auth.role === 'farmer') {
      ownerId = auth.userId;
    }
    await assertLocation(body.state_id, body.lga_id);
    const farm = await prisma.farm.create({
      data: {
        name: body.name,
        address: body.address,
        landmark: body.landmark,
        village: body.village,
        city: body.city,
        stateId: body.state_id,
        lgaId: body.lga_id,
        latitude: body.latitude,
        longitude: body.longitude,
        ownerId,
        createdById: auth.userId,
      },
      include: farmInclude,
    });
    await audit(req, 'farm.created', 'farm', farm.id);
    created(res, serializeFarm(farm));
  }),
);

// GET /farms/{farmId}
farmsRouter.get(
  '/:farmId',
  asyncHandler(async (req, res) => {
    const farm = await getFarmWithAccess(req, parse(uuid, req.params.farmId), 'read');
    const [assignments, counts, latestLand] = await Promise.all([
      prisma.farmAssignment.findMany({
        where: { farmId: farm.id, status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
        include: { dco: { select: { id: true, agriksenseId: true, firstName: true, lastName: true } } },
      }),
      prisma.farm.findUniqueOrThrow({ where: { id: farm.id }, select: { _count: { select: { crops: true, observations: true, visits: true } } } }),
      prisma.farmlandMeasurement.findFirst({ where: { farmId: farm.id }, orderBy: { measuredAt: 'desc' } }),
    ]);
    ok(res, {
      ...serializeFarm(farm),
      area_hectares: latestLand?.areaHectares ?? null,
      counts: { crops: counts._count.crops, observations: counts._count.observations, visits: counts._count.visits },
      active_assignments: assignments.map((a) => ({
        id: a.id,
        status: a.status,
        scheduled_for: a.scheduledFor?.toISOString() ?? null,
        dco: { id: a.dco.id, agriksense_id: a.dco.agriksenseId, name: [a.dco.firstName, a.dco.lastName].filter(Boolean).join(' ') },
      })),
    });
  }),
);

// PATCH /farms/{farmId}
farmsRouter.patch(
  '/:farmId',
  asyncHandler(async (req, res) => {
    const farm = await getFarmWithAccess(req, parse(uuid, req.params.farmId), 'write');
    const schema = z.object({ ...farmFields, is_active: z.boolean(), owner_id: uuid.nullable() }).partial().strict();
    const body = parse(schema, req.body);
    if ((body.owner_id !== undefined || body.is_active !== undefined) && !hasPermission(req, 'farms.write_all')) {
      throw forbidden('Only administrators can change farm ownership or deactivate farms');
    }
    if (body.owner_id) {
      const owner = await prisma.user.findUnique({ where: { id: body.owner_id }, select: { baseRole: true } });
      if (!owner || owner.baseRole !== 'farmer') throw unprocessable('Farm owner must be a farmer', [{ field: 'owner_id', reason: 'not a farmer' }]);
    }
    const stateId = body.state_id ?? farm.stateId;
    const lgaId = body.lga_id ?? farm.lgaId;
    await assertLocation(stateId, lgaId);
    const updated = await prisma.farm.update({
      where: { id: farm.id },
      data: {
        name: body.name,
        address: body.address,
        landmark: body.landmark,
        village: body.village,
        city: body.city,
        stateId,
        lgaId,
        latitude: body.latitude,
        longitude: body.longitude,
        isActive: body.is_active,
        ownerId: body.owner_id,
      },
      include: farmInclude,
    });
    await audit(req, 'farm.updated', 'farm', farm.id, { fields: Object.keys(body) });
    ok(res, serializeFarm(updated));
  }),
);

// GET /farmers/me/farms
farmerFarmsRouter.get(
  '/me/farms',
  requireAuth,
  requireRole('farmer'),
  asyncHandler(async (req, res) => {
    const p = getPagination(req.query);
    const where = { ownerId: authOf(req).userId };
    const [total, farms] = await Promise.all([
      prisma.farm.count({ where }),
      prisma.farm.findMany({ where, include: farmInclude, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
    ]);
    ok(res, farms.map(serializeFarm), pageMeta(p, total));
  }),
);
