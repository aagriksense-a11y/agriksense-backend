import type { Request } from 'express';
import type { Farm, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { ApiError, forbidden, notFound } from '../lib/errors';
import { authOf, hasPermission } from '../middleware/auth';

export const ACTIVE_ASSIGNMENT_STATUSES = ['assigned', 'accepted', 'in_progress'] as const;

export type FarmAccessMode = 'read' | 'write' | 'collect';

/**
 * Farm-level authorization:
 *  - owner farmer: read / write / collect
 *  - DCO with an active assignment on the farm: read / collect
 *  - organization admin: read farms owned by its *verified* members
 *  - admins: farms.read_all / records.read_all (read), farms.write_all (write), records.write_all (collect)
 * "collect" additionally requires the owner's farm-data-collection consent to be in force.
 */
export async function getFarmWithAccess(req: Request, farmId: string, mode: FarmAccessMode) {
  const farm = await prisma.farm.findUnique({ where: { id: farmId }, include: { state: true, lga: true, owner: true } });
  if (!farm) throw notFound('Farm');

  const allowed = await canAccessFarm(req, farm, mode);
  if (!allowed) {
    // Do not leak existence of farms the caller has no read access to.
    if (!(await canAccessFarm(req, farm, 'read'))) throw notFound('Farm');
    throw forbidden();
  }

  if (mode === 'collect' && farm.ownerId && !(await hasActiveFarmDataConsent(farm.ownerId))) {
    throw new ApiError(403, 'CONSENT_REQUIRED', 'The farm owner has not granted (or has withdrawn) farm data collection consent');
  }
  return farm;
}

export async function canAccessFarm(req: Request, farm: Pick<Farm, 'id' | 'ownerId'>, mode: FarmAccessMode): Promise<boolean> {
  const auth = authOf(req);
  if (mode === 'read' && (hasPermission(req, 'farms.read_all') || hasPermission(req, 'records.read_all'))) return true;
  if (mode === 'write' && hasPermission(req, 'farms.write_all')) return true;
  if (mode === 'collect' && hasPermission(req, 'records.write_all')) return true;

  if (farm.ownerId === auth.userId) return true;

  if (auth.role === 'dco' && mode !== 'write') {
    const assignment = await prisma.farmAssignment.findFirst({
      where: { farmId: farm.id, dcoId: auth.userId, status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
      select: { id: true },
    });
    if (assignment) return true;
  }

  if (auth.role === 'organization_admin' && mode === 'read' && farm.ownerId) {
    const membership = await prisma.organizationMembership.findFirst({
      where: { farmerId: farm.ownerId, status: 'verified', organization: { ownerUserId: auth.userId } },
      select: { id: true },
    });
    if (membership) return true;
  }
  return false;
}

/** Prisma filter restricting farms to those the caller may read. */
export async function farmScopeFilter(req: Request): Promise<Prisma.FarmWhereInput> {
  const auth = authOf(req);
  if (hasPermission(req, 'farms.read_all') || hasPermission(req, 'records.read_all')) return {};
  if (auth.role === 'farmer') return { ownerId: auth.userId };
  if (auth.role === 'dco') {
    return {
      OR: [
        { ownerId: auth.userId },
        { assignments: { some: { dcoId: auth.userId, status: { in: [...ACTIVE_ASSIGNMENT_STATUSES, 'completed'] } } } },
      ],
    };
  }
  if (auth.role === 'organization_admin') {
    return { owner: { memberships: { some: { status: 'verified', organization: { ownerUserId: auth.userId } } } } };
  }
  return { id: '00000000-0000-0000-0000-000000000000' };
}

export async function hasActiveFarmDataConsent(userId: string): Promise<boolean> {
  const latest = await prisma.consent.findFirst({
    where: { userId, scope: 'farm_data_collection' },
    orderBy: { decidedAt: 'desc' },
  });
  return !!latest && latest.decision === 'accepted' && !latest.withdrawnAt;
}

export async function getMyOrganization(userId: string) {
  const org = await prisma.organization.findUnique({ where: { ownerUserId: userId } });
  if (!org) throw notFound('Organization');
  return org;
}
