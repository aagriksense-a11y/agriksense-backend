import { Router } from 'express';
import { prisma } from '../config/prisma';
import { asyncHandler, ok } from '../lib/http';
import { authOf, requireAuth, requirePermission } from '../middleware/auth';
import { refreshOnboarding } from '../services/onboarding.service';
import { ACTIVE_ASSIGNMENT_STATUSES } from '../services/access.service';

export const dashboardRouter = Router();
export const adminDashboardRouter = Router();

// GET /dashboard/me — role-specific summary
dashboardRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const onboarding = await refreshOnboarding(auth.userId);
    const unread = await prisma.notification.count({ where: { userId: auth.userId, readAt: null } });
    const base = { agriksense_id: auth.agriksenseId, role: auth.role, onboarding_status: onboarding.onboarding_status, unread_notifications: unread };

    if (auth.role === 'farmer') {
      const farmWhere = { ownerId: auth.userId };
      const [farms, crops, observations, memberships, predictions, activeAssignments] = await Promise.all([
        prisma.farm.count({ where: farmWhere }),
        prisma.cropRecord.count({ where: { farm: farmWhere } }),
        prisma.observation.count({ where: { farm: farmWhere } }),
        prisma.organizationMembership.groupBy({ by: ['status'], where: { farmerId: auth.userId }, _count: true }),
        prisma.aiPrediction.count({ where: { userId: auth.userId } }),
        prisma.farmAssignment.count({ where: { farm: farmWhere, status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } } }),
      ]);
      return ok(res, {
        ...base,
        farms,
        crop_records: crops,
        disease_pest_observations: observations,
        upcoming_dco_visits: activeAssignments,
        ai_predictions: predictions,
        memberships: Object.fromEntries(memberships.map((m) => [m.status, m._count])),
      });
    }
    if (auth.role === 'dco') {
      const [requests, assignments, visits, predictions] = await Promise.all([
        prisma.visitRequest.groupBy({ by: ['status'], where: { dcoId: auth.userId }, _count: true }),
        prisma.farmAssignment.groupBy({ by: ['status'], where: { dcoId: auth.userId }, _count: true }),
        prisma.farmVisit.count({ where: { dcoId: auth.userId } }),
        prisma.aiPrediction.count({ where: { userId: auth.userId } }),
      ]);
      const fare = await prisma.farmAssignment.aggregate({ where: { dcoId: auth.userId, status: 'completed' }, _sum: { fareKobo: true } });
      return ok(res, {
        ...base,
        visit_requests: Object.fromEntries(requests.map((r) => [r.status, r._count])),
        assignments: Object.fromEntries(assignments.map((a) => [a.status, a._count])),
        farm_visits: visits,
        completed_fare_kobo: fare._sum.fareKobo ?? 0,
        ai_predictions: predictions,
      });
    }
    if (auth.role === 'organization_admin') {
      const org = await prisma.organization.findUnique({ where: { ownerUserId: auth.userId } });
      const members = org ? await prisma.organizationMembership.groupBy({ by: ['status'], where: { organizationId: org.id }, _count: true }) : [];
      const memberFarms = org ? await prisma.farm.count({ where: { owner: { memberships: { some: { organizationId: org.id, status: 'verified' } } } } }) : 0;
      return ok(res, {
        ...base,
        organization_id: org?.id ?? null,
        cac_verification_status: org?.cacStatus ?? null,
        members: Object.fromEntries(members.map((m) => [m.status, m._count])),
        member_farms: memberFarms,
      });
    }
    return ok(res, { ...base, hint: 'See /admin/dashboard for operational metrics' });
  }),
);

// GET /admin/dashboard — operational metrics
adminDashboardRouter.get(
  '/',
  requireAuth,
  requirePermission('dashboard.admin'),
  asyncHandler(async (_req, res) => {
    const since = new Date(Date.now() - 7 * 86400_000);
    const [usersByRole, onboarding, verificationsPending, newUsers, requests, assignments, farms, crops, observations, predictions, failedPredictions, imports] = await Promise.all([
      prisma.user.groupBy({ by: ['baseRole'], _count: true }),
      prisma.user.groupBy({ by: ['onboardingStatus'], _count: true }),
      prisma.identityVerification.groupBy({ by: ['type'], where: { status: { in: ['pending', 'manual_review'] } }, _count: true }),
      prisma.user.count({ where: { createdAt: { gte: since } } }),
      prisma.visitRequest.groupBy({ by: ['status'], _count: true }),
      prisma.farmAssignment.groupBy({ by: ['status'], _count: true }),
      prisma.farm.count({ where: { isActive: true } }),
      prisma.cropRecord.count(),
      prisma.observation.count(),
      prisma.aiPrediction.count({ where: { createdAt: { gte: since } } }),
      prisma.aiPrediction.count({ where: { createdAt: { gte: since }, status: 'failed' } }),
      prisma.importJob.groupBy({ by: ['status'], _count: true }),
    ]);
    ok(res, {
      users_by_role: Object.fromEntries(usersByRole.map((u) => [u.baseRole, u._count])),
      onboarding_status: Object.fromEntries(onboarding.map((o) => [o.onboardingStatus, o._count])),
      verifications_awaiting_review: Object.fromEntries(verificationsPending.map((v) => [v.type, v._count])),
      new_users_last_7_days: newUsers,
      visit_requests: Object.fromEntries(requests.map((r) => [r.status, r._count])),
      farm_assignments: Object.fromEntries(assignments.map((a) => [a.status, a._count])),
      active_farms: farms,
      crop_records: crops,
      disease_pest_observations: observations,
      ai_predictions_last_7_days: { total: predictions, failed: failedPredictions },
      import_jobs: Object.fromEntries(imports.map((i) => [i.status, i._count])),
      generated_at: new Date().toISOString(),
    });
  }),
);
