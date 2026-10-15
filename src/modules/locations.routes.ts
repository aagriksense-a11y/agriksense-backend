import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { asyncHandler, ok } from '../lib/http';
import { parse, intId } from '../lib/validation';

const router = Router();

// GET /locations/states
router.get(
  '/states',
  asyncHandler(async (_req, res) => {
    const states = await prisma.state.findMany({ orderBy: { name: 'asc' } });
    ok(res, states.map((s) => ({ id: s.id, name: s.name, code: s.code })));
  }),
);

// GET /locations/lgas?stateId=
router.get(
  '/lgas',
  asyncHandler(async (req, res) => {
    const { stateId } = parse(z.object({ stateId: intId }), req.query);
    const lgas = await prisma.lga.findMany({ where: { stateId }, orderBy: { name: 'asc' } });
    ok(res, lgas.map((l) => ({ id: l.id, name: l.name, state_id: l.stateId })));
  }),
);

// GET /locations/cities?lgaId=
router.get(
  '/cities',
  asyncHandler(async (req, res) => {
    const { lgaId } = parse(z.object({ lgaId: intId }), req.query);
    const cities = await prisma.city.findMany({ where: { lgaId }, orderBy: { name: 'asc' } });
    ok(res, cities.map((c) => ({ id: c.id, name: c.name, lga_id: c.lgaId })));
  }),
);

export default router;
