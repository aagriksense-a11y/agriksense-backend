import { Router } from 'express';
import { z } from 'zod';
import { BaseRole, GroupMemberType, OnboardingStatus, Prisma } from '@prisma/client';
import type { Role, Group } from '@prisma/client';
import { prisma } from '../config/prisma';
import { asyncHandler, accepted, created, noContent, ok } from '../lib/http';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { parse, uuid, email, phone, name, password, intId, booleanish, isoDate } from '../lib/validation';
import { iso, serializeBankAccount, serializeOrganization, serializeUser, userRef } from '../lib/serializers';
import { getPagination, orderBy, pageMeta } from '../lib/pagination';
import { audit } from '../lib/audit';
import { revokeAllSessions } from '../lib/tokens';
import { PERMISSIONS, ALL_PERMISSIONS } from '../lib/permissions';
import { authOf, requireAuth, requirePermission } from '../middleware/auth';
import { assertIdentifiersAvailable, createAccount } from '../services/user.service';
import { refreshOnboarding } from '../services/onboarding.service';
import { assertLocation } from '../services/location.service';
import { serializeMembership } from '../services/membership.service';
import { NotificationService } from '../services/notification.service';
import { serializeVerification } from './verifications.routes';
import { issuePasswordReset } from './auth.routes';

const router = Router();
router.use(requireAuth);

// ───────────── Users ─────────────

// GET /admin/users?role=&is_active=&onboarding_status=&state_id=&lga_id=&group_id=&search=
router.get(
  '/users',
  requirePermission('users.read'),
  asyncHandler(async (req, res) => {
    const p = getPagination(req.query);
    const q = parse(
      z
        .object({
          role: z.nativeEnum(BaseRole).optional(),
          is_active: booleanish.optional(),
          onboarding_status: z.nativeEnum(OnboardingStatus).optional(),
          nin_verification_status: z.enum(['not_submitted', 'pending', 'verified', 'rejected', 'manual_review']).optional(),
          state_id: intId.optional(),
          lga_id: intId.optional(),
          group_id: uuid.optional(),
        })
        .passthrough(),
      req.query,
    );
    const where: Prisma.UserWhereInput = {
      ...(q.role ? { baseRole: q.role } : {}),
      ...(q.is_active !== undefined ? { isActive: q.is_active } : {}),
      ...(q.onboarding_status ? { onboardingStatus: q.onboarding_status } : {}),
      ...(q.nin_verification_status ? { ninStatus: q.nin_verification_status } : {}),
      ...(q.state_id ? { OR: [{ stateId: q.state_id }, { organization: { stateId: q.state_id } }] } : {}),
      ...(q.lga_id ? { lgaId: q.lga_id } : {}),
      ...(q.group_id ? { groupMemberships: { some: { groupId: q.group_id } } } : {}),
      ...(p.search
        ? {
            AND: [
              {
                OR: [
                  { firstName: { contains: p.search, mode: 'insensitive' } },
                  { lastName: { contains: p.search, mode: 'insensitive' } },
                  { email: { contains: p.search, mode: 'insensitive' } },
                  { phone: { contains: p.search } },
                  { agriksenseId: p.search },
                  { organization: { name: { contains: p.search, mode: 'insensitive' } } },
                ],
              },
            ],
          }
        : {}),
    };
    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        include: { state: true, lga: true, organization: true },
        orderBy: orderBy(p.sort, { created_at: 'createdAt', last_name: 'lastName', agriksense_id: 'agriksenseId', role: 'baseRole' }),
        skip: p.skip,
        take: p.take,
      }),
    ]);
    ok(res, users.map(serializeUser), pageMeta(p, total));
  }),
);

// POST /admin/users — create a user for a selected role
const adminCreateSchema = z
  .object({
    role: z.nativeEnum(BaseRole),
    first_name: name.optional(),
    last_name: name.optional(),
    other_name: name.optional(),
    organization_name: z.string().trim().min(2).max(200).optional(),
    is_registered: z.boolean().optional(),
    email: email.optional(),
    phone: phone.optional(),
    password: password.optional(),
    state_id: intId.optional(),
    lga_id: intId.optional(),
    city: z.string().trim().max(100).optional(),
    address: z.string().trim().max(300).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.role === 'organization_admin') {
      if (!b.organization_name) ctx.addIssue({ code: 'custom', path: ['organization_name'], message: 'required' });
      if (!b.email) ctx.addIssue({ code: 'custom', path: ['email'], message: 'required' });
    } else {
      if (!b.first_name) ctx.addIssue({ code: 'custom', path: ['first_name'], message: 'required' });
      if (!b.last_name) ctx.addIssue({ code: 'custom', path: ['last_name'], message: 'required' });
    }
    if (b.role === 'farmer' && !b.phone) ctx.addIssue({ code: 'custom', path: ['phone'], message: 'required' });
    if (b.role === 'dco' && (!b.phone || !b.email)) ctx.addIssue({ code: 'custom', path: [b.phone ? 'email' : 'phone'], message: 'required' });
    if (b.role === 'platform_admin' && !b.email) ctx.addIssue({ code: 'custom', path: ['email'], message: 'required' });
  });
router.post(
  '/users',
  requirePermission('users.write'),
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = parse(adminCreateSchema, req.body);
    if (body.role === 'platform_admin' && auth.role !== 'platform_admin') throw forbidden('Only platform admins can create platform admin accounts');
    await assertIdentifiersAvailable(body.email, body.phone);
    await assertLocation(body.state_id, body.lga_id);
    const user = await createAccount({
      role: body.role,
      firstName: body.first_name,
      lastName: body.last_name,
      otherName: body.other_name,
      organizationName: body.organization_name,
      organizationIsRegistered: body.is_registered,
      email: body.email,
      phone: body.phone,
      password: body.password,
      createdById: auth.userId,
      stateId: body.role === 'organization_admin' ? null : body.state_id,
      lgaId: body.role === 'organization_admin' ? null : body.lga_id,
      city: body.role === 'organization_admin' ? null : body.city,
      address: body.role === 'organization_admin' ? null : body.address,
    });
    if (body.role === 'organization_admin' && (body.state_id || body.city || body.address)) {
      await prisma.organization.update({
        where: { ownerUserId: user.id },
        data: { stateId: body.state_id, lgaId: body.lga_id, city: body.city, headquartersAddress: body.address },
      });
    }
    await NotificationService.welcome(user);
    // Without an initial password the user activates the account through a reset link.
    if (!body.password) await issuePasswordReset(user, auth.userId);
    await audit(req, 'admin.user_created', 'user', user.id, { role: body.role });
    const full = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { state: true, lga: true, organization: true } });
    created(res, serializeUser(full));
  }),
);

// GET /admin/users/{userId} — full authorized onboarding record (sensitive numbers stay masked)
router.get(
  '/users/:userId',
  requirePermission('users.read'),
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.userId);
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        state: true,
        lga: true,
        farmerProfile: true,
        dcoProfile: true,
        organization: { include: { owner: true, state: true, lga: true, contacts: true } },
        verifications: { orderBy: { submittedAt: 'desc' } },
        bankAccounts: { where: { deletedAt: null }, include: { bank: true } },
        memberships: { include: { organization: { include: { owner: true } } } },
        consents: { orderBy: { decidedAt: 'desc' } },
        roleAssignments: { include: { role: true } },
        groupMemberships: { include: { group: true } },
        documents: { where: { deletedAt: null }, select: { id: true, type: true, mimeType: true, sizeBytes: true, createdAt: true } },
      },
    });
    if (!user) throw notFound('User');
    const onboarding = await refreshOnboarding(user.id);
    await audit(req, 'admin.user_viewed', 'user', user.id);
    ok(res, {
      ...serializeUser({ ...user, onboardingStatus: onboarding.onboarding_status }),
      onboarding,
      farmer_profile: user.farmerProfile
        ? { manager_name: user.farmerProfile.managerName, manager_phone: user.farmerProfile.managerPhone, manager_email: user.farmerProfile.managerEmail, farming_group: user.farmerProfile.farmingGroup, primary_crops: user.farmerProfile.primaryCrops, years_farming: user.farmerProfile.yearsFarming }
        : null,
      dco_profile: user.dcoProfile ? { availability: user.dcoProfile.availability, has_transport: user.dcoProfile.hasTransport, education_level: user.dcoProfile.educationLevel } : null,
      organization: user.organization
        ? {
            ...serializeOrganization(user.organization),
            contacts: user.organization.contacts.map((c) => ({
              id: c.id,
              contact_type: c.contactType,
              full_name: c.fullName,
              phone: c.phone,
              email: c.email,
              position: c.position,
              nin_masked: c.ninLast4 ? `*******${c.ninLast4}` : null,
              nin_document_id: c.ninDocumentId,
              utility_bill_document_id: c.utilityBillDocumentId,
            })),
          }
        : null,
      verifications: user.verifications.map((v) => serializeVerification(v)),
      bank_accounts: user.bankAccounts.map(serializeBankAccount),
      memberships: user.memberships.map((m) => serializeMembership({ ...m, farmer: null })),
      consents: user.consents.map((c) => ({ id: c.id, scope: c.scope, version: c.version, decision: c.decision, decided_at: iso(c.decidedAt), withdrawn_at: iso(c.withdrawnAt) })),
      roles: user.roleAssignments.map((ra) => ({ id: ra.role.id, key: ra.role.key, name: ra.role.name, assigned_at: iso(ra.createdAt) })),
      groups: user.groupMemberships.map((gm) => ({ id: gm.group.id, name: gm.group.name })),
      documents: user.documents.map((d) => ({ id: d.id, type: d.type, mime_type: d.mimeType, size_bytes: d.sizeBytes, created_at: iso(d.createdAt) })),
    });
  }),
);

// PATCH /admin/users/{userId}
router.patch(
  '/users/:userId',
  requirePermission('users.write'),
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const id = parse(uuid, req.params.userId);
    const body = parse(
      z
        .object({
          first_name: name,
          last_name: name,
          other_name: name.nullable(),
          email: email.nullable(),
          phone: phone.nullable(),
          alt_phone: phone.nullable(),
          date_of_birth: isoDate.nullable(),
          gender: z.enum(['male', 'female', 'other', 'prefer_not_to_say']).nullable(),
          address: z.string().trim().max(300).nullable(),
          city: z.string().trim().max(100).nullable(),
          state_id: intId.nullable(),
          lga_id: intId.nullable(),
          organization_name: z.string().trim().min(2).max(200),
        })
        .partial()
        .strict(),
      req.body,
    );
    const user = await prisma.user.findUnique({ where: { id }, include: { organization: true } });
    if (!user) throw notFound('User');
    if (user.baseRole === 'platform_admin' && auth.role !== 'platform_admin') throw forbidden('Only platform admins can edit platform admin accounts');
    await assertIdentifiersAvailable(body.email ?? undefined, body.phone ?? undefined, id);
    const stateId = body.state_id === undefined ? user.stateId : body.state_id;
    const lgaId = body.lga_id === undefined ? (body.state_id !== undefined && body.state_id !== user.stateId ? null : user.lgaId) : body.lga_id;
    await assertLocation(stateId, lgaId);
    await prisma.$transaction([
      prisma.user.update({
        where: { id },
        data: {
          firstName: body.first_name,
          lastName: body.last_name,
          otherName: body.other_name,
          email: body.email,
          phone: body.phone,
          altPhone: body.alt_phone,
          dateOfBirth: body.date_of_birth === undefined ? undefined : body.date_of_birth ? new Date(body.date_of_birth) : null,
          gender: body.gender,
          address: body.address,
          city: body.city,
          stateId,
          lgaId,
        },
      }),
      ...(body.organization_name && user.organization ? [prisma.organization.update({ where: { id: user.organization.id }, data: { name: body.organization_name } })] : []),
    ]);
    await refreshOnboarding(id);
    await audit(req, 'admin.user_updated', 'user', id, { fields: Object.keys(body) });
    const full = await prisma.user.findUniqueOrThrow({ where: { id }, include: { state: true, lga: true, organization: true } });
    ok(res, serializeUser(full));
  }),
);

// PATCH /admin/users/{userId}/status — enable/disable; disabling revokes all sessions
router.patch(
  '/users/:userId/status',
  requirePermission('users.manage_status'),
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const id = parse(uuid, req.params.userId);
    const body = parse(z.object({ is_active: z.boolean(), reason: z.string().max(500).optional() }), req.body);
    if (id === auth.userId) throw forbidden('You cannot change your own account status');
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw notFound('User');
    if (user.baseRole === 'platform_admin' && auth.role !== 'platform_admin') throw forbidden('Only platform admins can change platform admin status');
    if (!body.is_active && !body.reason) throw unprocessable('A reason is required to disable an account', [{ field: 'reason', reason: 'required' }]);
    const updated = await prisma.user.update({ where: { id }, data: { isActive: body.is_active }, include: { state: true, lga: true, organization: true } });
    if (!body.is_active) await revokeAllSessions(id);
    await audit(req, body.is_active ? 'admin.user_enabled' : 'admin.user_disabled', 'user', id, { reason: body.reason });
    ok(res, serializeUser(updated));
  }),
);

// POST /admin/users/{userId}/password-reset — sends a reset link to the user; never returns a password/token
router.post(
  '/users/:userId/password-reset',
  requirePermission('users.reset_password'),
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const id = parse(uuid, req.params.userId);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw notFound('User');
    if (user.baseRole === 'platform_admin' && auth.role !== 'platform_admin') throw forbidden();
    if (!user.email && !user.phone) throw unprocessable('User has no email or phone to receive a reset link');
    await issuePasswordReset(user, auth.userId);
    await audit(req, 'admin.password_reset_initiated', 'user', id);
    accepted(res, { message: 'Password reset instructions have been sent to the user.', delivered_via: user.email ? 'email' : 'sms' });
  }),
);

// POST /admin/users/{userId}/roles — granular roles are assignable to DCO users only (PRD)
router.post(
  '/users/:userId/roles',
  requirePermission('users.assign_roles'),
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const id = parse(uuid, req.params.userId);
    const { role_id } = parse(z.object({ role_id: uuid }), req.body);
    const [user, role] = await Promise.all([prisma.user.findUnique({ where: { id } }), prisma.role.findUnique({ where: { id: role_id } })]);
    if (!user) throw notFound('User');
    if (!role) throw unprocessable('Unknown role', [{ field: 'role_id', reason: 'not found' }]);
    if (user.baseRole !== 'dco') throw unprocessable('Roles can only be assigned to DCO users', [{ field: 'userId', reason: 'not a DCO' }], 'ROLE_ASSIGNMENT_NOT_ALLOWED');
    if (role.isSystem) throw unprocessable('System roles are base-role defaults and cannot be assigned', [{ field: 'role_id', reason: 'system role' }]);
    const exists = await prisma.userRoleAssignment.findUnique({ where: { userId_roleId: { userId: id, roleId: role.id } } });
    if (exists) throw conflict('Role is already assigned to this user');
    await prisma.userRoleAssignment.create({ data: { userId: id, roleId: role.id, assignedById: auth.userId } });
    await NotificationService.inApp(id, 'role_assigned', 'New role assigned', `You have been granted the "${role.name}" role.`, { role_id: role.id });
    await audit(req, 'admin.role_assigned', 'user', id, { role_id: role.id, role_key: role.key });
    created(res, { user_id: id, role: { id: role.id, key: role.key, name: role.name } });
  }),
);

// DELETE /admin/users/{userId}/roles/{roleId}
router.delete(
  '/users/:userId/roles/:roleId',
  requirePermission('users.assign_roles'),
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.userId);
    const roleId = parse(uuid, req.params.roleId);
    const deleted = await prisma.userRoleAssignment.deleteMany({ where: { userId: id, roleId } });
    if (!deleted.count) throw notFound('Role assignment');
    await audit(req, 'admin.role_revoked', 'user', id, { role_id: roleId });
    noContent(res);
  }),
);

// ───────────── Groups ─────────────

const serializeGroup = (g: Group & { _count?: { members: number } }) => ({
  id: g.id,
  name: g.name,
  description: g.description,
  member_type: g.memberType,
  member_count: g._count?.members,
  created_by_id: g.createdById,
  created_at: iso(g.createdAt),
  updated_at: iso(g.updatedAt),
});
const ROLE_FOR_GROUP: Record<GroupMemberType, BaseRole> = { farmer: 'farmer', dco: 'dco', organization: 'organization_admin' };

// GET /admin/groups?member_type=
router.get(
  '/groups',
  requirePermission('groups.manage'),
  asyncHandler(async (req, res) => {
    const p = getPagination(req.query);
    const q = parse(z.object({ member_type: z.nativeEnum(GroupMemberType).optional() }).passthrough(), req.query);
    const where: Prisma.GroupWhereInput = {
      ...(q.member_type ? { memberType: q.member_type } : {}),
      ...(p.search ? { name: { contains: p.search, mode: 'insensitive' } } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.group.count({ where }),
      prisma.group.findMany({ where, include: { _count: { select: { members: true } } }, orderBy: orderBy(p.sort, { name: 'name', created_at: 'createdAt' }, { name: 'asc' }), skip: p.skip, take: p.take }),
    ]);
    ok(res, rows.map(serializeGroup), pageMeta(p, total));
  }),
);

// POST /admin/groups
router.post(
  '/groups',
  requirePermission('groups.manage'),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(2).max(100), description: z.string().max(500).optional(), member_type: z.nativeEnum(GroupMemberType) }), req.body);
    const group = await prisma.group.create({ data: { name: body.name, description: body.description, memberType: body.member_type, createdById: authOf(req).userId } });
    await audit(req, 'admin.group_created', 'group', group.id);
    created(res, serializeGroup(group));
  }),
);

// GET /admin/groups/{groupId} — details and (paginated) members
router.get(
  '/groups/:groupId',
  requirePermission('groups.manage'),
  asyncHandler(async (req, res) => {
    const group = await prisma.group.findUnique({ where: { id: parse(uuid, req.params.groupId) }, include: { _count: { select: { members: true } } } });
    if (!group) throw notFound('Group');
    const p = getPagination(req.query);
    const members = await prisma.groupMember.findMany({ where: { groupId: group.id }, include: { user: { include: { organization: true } } }, orderBy: { createdAt: 'asc' }, skip: p.skip, take: p.take });
    ok(
      res,
      { ...serializeGroup(group), members: members.map((m) => ({ ...userRef(m.user), organization_name: m.user.organization?.name ?? null, added_at: iso(m.createdAt) })) },
      pageMeta(p, group._count.members),
    );
  }),
);

// PATCH /admin/groups/{groupId}
router.patch(
  '/groups/:groupId',
  requirePermission('groups.manage'),
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.groupId);
    const body = parse(z.object({ name: z.string().trim().min(2).max(100), description: z.string().max(500).nullable() }).partial().strict(), req.body);
    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) throw notFound('Group');
    const updated = await prisma.group.update({ where: { id }, data: body, include: { _count: { select: { members: true } } } });
    await audit(req, 'admin.group_updated', 'group', id, { fields: Object.keys(body) });
    ok(res, serializeGroup(updated));
  }),
);

// POST /admin/groups/{groupId}/members
router.post(
  '/groups/:groupId/members',
  requirePermission('groups.manage'),
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const id = parse(uuid, req.params.groupId);
    const { user_ids } = parse(z.object({ user_ids: z.array(uuid).min(1).max(500) }), req.body);
    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) throw notFound('Group');
    const users = await prisma.user.findMany({ where: { id: { in: user_ids } }, select: { id: true, baseRole: true } });
    const expected = ROLE_FOR_GROUP[group.memberType];
    const errors = user_ids.flatMap((uid, i) => {
      const u = users.find((x) => x.id === uid);
      if (!u) return [{ field: `user_ids.${i}`, reason: 'user not found' }];
      if (u.baseRole !== expected) return [{ field: `user_ids.${i}`, reason: `group only accepts ${group.memberType} accounts` }];
      return [];
    });
    if (errors.length) throw unprocessable('Some users cannot be added to this group', errors);
    const result = await prisma.groupMember.createMany({ data: user_ids.map((userId) => ({ groupId: id, userId, addedById: auth.userId })), skipDuplicates: true });
    await audit(req, 'admin.group_members_added', 'group', id, { added: result.count });
    ok(res, { group_id: id, added: result.count, already_members: user_ids.length - result.count });
  }),
);

// DELETE /admin/groups/{groupId}/members/{userId}
router.delete(
  '/groups/:groupId/members/:userId',
  requirePermission('groups.manage'),
  asyncHandler(async (req, res) => {
    const groupId = parse(uuid, req.params.groupId);
    const userId = parse(uuid, req.params.userId);
    const deleted = await prisma.groupMember.deleteMany({ where: { groupId, userId } });
    if (!deleted.count) throw notFound('Group member');
    await audit(req, 'admin.group_member_removed', 'group', groupId, { user_id: userId });
    noContent(res);
  }),
);

// ───────────── Roles & permissions ─────────────

const serializeRole = (r: Role & { permissions?: { permissionKey: string }[]; _count?: { assignments: number } }) => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  is_system: r.isSystem,
  permissions: r.permissions?.map((p) => p.permissionKey).sort() ?? [],
  assigned_user_count: r._count?.assignments,
  created_at: iso(r.createdAt),
  updated_at: iso(r.updatedAt),
});
const roleInclude = { permissions: { select: { permissionKey: true } }, _count: { select: { assignments: true } } } as const;

// GET /admin/roles
router.get(
  '/roles',
  requirePermission('roles.manage'),
  asyncHandler(async (_req, res) => {
    const roles = await prisma.role.findMany({ include: roleInclude, orderBy: [{ isSystem: 'desc' }, { name: 'asc' }] });
    ok(res, roles.map(serializeRole));
  }),
);

const permissionKeys = z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).max(ALL_PERMISSIONS.length);

// POST /admin/roles
router.post(
  '/roles',
  requirePermission('roles.manage'),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{2,49}$/, 'lowercase letters, digits and underscores (3-50 chars)'),
        name: z.string().trim().min(2).max(100),
        description: z.string().max(500).optional(),
        permissions: permissionKeys.default([]),
      }),
      req.body,
    );
    if ((Object.values(BaseRole) as string[]).includes(body.key)) throw conflict('Role key is reserved for a system role');
    const role = await prisma.role.create({
      data: { key: body.key, name: body.name, description: body.description, permissions: { create: [...new Set(body.permissions)].map((k) => ({ permissionKey: k })) } },
      include: roleInclude,
    });
    await audit(req, 'admin.role_created', 'role', role.id, { key: role.key, permissions: body.permissions });
    created(res, serializeRole(role));
  }),
);

// PATCH /admin/roles/{roleId}
router.patch(
  '/roles/:roleId',
  requirePermission('roles.manage'),
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.roleId);
    const body = parse(z.object({ name: z.string().trim().min(2).max(100), description: z.string().max(500).nullable() }).partial().strict(), req.body);
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) throw notFound('Role');
    const updated = await prisma.role.update({ where: { id }, data: body, include: roleInclude });
    await audit(req, 'admin.role_updated', 'role', id, { fields: Object.keys(body) });
    ok(res, serializeRole(updated));
  }),
);

// GET /admin/permissions
router.get(
  '/permissions',
  requirePermission('roles.manage'),
  asyncHandler(async (_req, res) => {
    ok(res, Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description })));
  }),
);

// PUT /admin/roles/{roleId}/permissions — replace the permission set
router.put(
  '/roles/:roleId/permissions',
  requirePermission('roles.manage'),
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.roleId);
    const { permissions } = parse(z.object({ permissions: permissionKeys }), req.body);
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) throw notFound('Role');
    if (role.key === 'platform_admin') throw new ApiError(409, 'ROLE_LOCKED', 'The platform admin role always holds every permission');
    const unique = [...new Set(permissions)];
    const updated = await prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      if (unique.length) await tx.rolePermission.createMany({ data: unique.map((k) => ({ roleId: id, permissionKey: k })) });
      return tx.role.findUniqueOrThrow({ where: { id }, include: roleInclude });
    });
    await audit(req, 'admin.role_permissions_replaced', 'role', id, { permissions: unique });
    ok(res, serializeRole(updated));
  }),
);

// ───────────── Audit log ─────────────

// GET /admin/audit-logs?actor_id=&entity_type=&entity_id=&action=&date_from=&date_to=
router.get(
  '/audit-logs',
  requirePermission('audit_logs.read'),
  asyncHandler(async (req, res) => {
    const p = getPagination(req.query);
    const q = parse(
      z
        .object({
          actor_id: uuid.optional(),
          entity_type: z.string().max(50).optional(),
          entity_id: z.string().max(100).optional(),
          action: z.string().max(100).optional(),
          date_from: isoDate.optional(),
          date_to: isoDate.optional(),
        })
        .passthrough(),
      req.query,
    );
    const where: Prisma.AuditLogWhereInput = {
      ...(q.actor_id ? { actorId: q.actor_id } : {}),
      ...(q.entity_type ? { entityType: q.entity_type } : {}),
      ...(q.entity_id ? { entityId: q.entity_id } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.date_from || q.date_to
        ? { createdAt: { ...(q.date_from ? { gte: new Date(q.date_from) } : {}), ...(q.date_to ? { lt: new Date(new Date(q.date_to).getTime() + 86400_000) } : {}) } }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
    ]);
    ok(
      res,
      rows.map((r) => ({ id: r.id, actor_id: r.actorId, action: r.action, entity_type: r.entityType, entity_id: r.entityId, request_id: r.requestId, ip: r.ip, metadata: r.metadata, created_at: iso(r.createdAt) })),
      pageMeta(p, total),
    );
  }),
);

export default router;
