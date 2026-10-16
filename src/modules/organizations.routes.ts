import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { OrganizationContact } from '@prisma/client';
import { prisma } from '../config/prisma';
import { asyncHandler, created, ok } from '../lib/http';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { parse, uuid, phone, email, nin, isoDate } from '../lib/validation';
import { encrypt, last4 } from '../lib/crypto';
import { iso, serializeOrganization } from '../lib/serializers';
import { getPagination, orderBy, pageMeta } from '../lib/pagination';
import { audit } from '../lib/audit';
import { authOf, requireAuth, requireRole } from '../middleware/auth';
import { getMyOrganization } from '../services/access.service';
import { assertOwnDocuments } from '../services/document.service';
import { refreshOnboarding } from '../services/onboarding.service';
import { assertIdentifiersAvailable, createAccount } from '../services/user.service';
import { generateMembershipNumber, serializeMembership } from '../services/membership.service';
import { NotificationService } from '../services/notification.service';
import { organizationUpdateSchema, updateOrganizationProfile } from './users.routes';

export const organizationsRouter = Router();
export const farmerMembershipsRouter = Router();

organizationsRouter.use(requireAuth, requireRole('organization_admin'));

// GET /organizations/me
organizationsRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUnique({
      where: { ownerUserId: authOf(req).userId },
      include: { owner: true, state: true, lga: true, _count: { select: { memberships: true, contacts: true } } },
    });
    if (!org) throw notFound('Organization');
    ok(res, { ...serializeOrganization(org), member_count: org._count.memberships, contact_count: org._count.contacts });
  }),
);

// PATCH /organizations/me
organizationsRouter.patch(
  '/me',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = parse(organizationUpdateSchema, req.body);
    const org = await updateOrganizationProfile(auth.userId, body);
    await refreshOnboarding(auth.userId);
    await audit(req, 'organization.updated', 'organization', org.id, { fields: Object.keys(body) });
    ok(res, org);
  }),
);

// ── Contacts (directors / contact persons) ──
const serializeContact = (c: OrganizationContact) => ({
  id: c.id,
  contact_type: c.contactType,
  full_name: c.fullName,
  phone: c.phone,
  email: c.email,
  address: c.address,
  position: c.position,
  nin_masked: c.ninLast4 ? `*******${c.ninLast4}` : null,
  nin_document_id: c.ninDocumentId,
  utility_bill_document_id: c.utilityBillDocumentId,
  created_at: iso(c.createdAt),
  updated_at: iso(c.updatedAt),
});

const contactFields = {
  contact_type: z.enum(['director', 'contact_person']),
  full_name: z.string().trim().min(2).max(150),
  phone: phone.nullable().optional(),
  email: email.nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  position: z.string().trim().max(100).nullable().optional(),
  nin: nin.nullable().optional(),
  nin_document_id: uuid.nullable().optional(),
  utility_bill_document_id: uuid.nullable().optional(),
};

function contactData(body: Partial<z.infer<z.ZodObject<typeof contactFields>>>): Prisma.OrganizationContactUncheckedUpdateInput {
  return {
    contactType: body.contact_type,
    fullName: body.full_name,
    phone: body.phone,
    email: body.email,
    address: body.address,
    position: body.position,
    ninDocumentId: body.nin_document_id,
    utilityBillDocumentId: body.utility_bill_document_id,
    ...(body.nin === undefined ? {} : body.nin === null ? { ninEncrypted: null, ninLast4: null } : { ninEncrypted: encrypt(body.nin), ninLast4: last4(body.nin) }),
  };
}

// GET /organizations/me/contacts
organizationsRouter.get(
  '/me/contacts',
  asyncHandler(async (req, res) => {
    const org = await getMyOrganization(authOf(req).userId);
    const contacts = await prisma.organizationContact.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } });
    ok(res, contacts.map(serializeContact));
  }),
);

// POST /organizations/me/contacts
organizationsRouter.post(
  '/me/contacts',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const org = await getMyOrganization(auth.userId);
    const body = parse(
      z.object(contactFields).superRefine((b, ctx) => {
        if (b.contact_type === 'director' && !b.utility_bill_document_id) {
          ctx.addIssue({ code: 'custom', path: ['utility_bill_document_id'], message: 'required for directors' });
        }
        if (!b.phone && !b.email) ctx.addIssue({ code: 'custom', path: ['phone'], message: 'phone or email is required' });
      }),
      req.body,
    );
    await assertOwnDocuments(req, [body.nin_document_id, body.utility_bill_document_id]);
    const contact = await prisma.organizationContact.create({
      data: { ...(contactData(body) as Prisma.OrganizationContactUncheckedCreateInput), organizationId: org.id },
    });
    await refreshOnboarding(auth.userId);
    await audit(req, 'organization.contact_created', 'organization_contact', contact.id);
    created(res, serializeContact(contact));
  }),
);

// PATCH /organizations/me/contacts/{contactId}
organizationsRouter.patch(
  '/me/contacts/:contactId',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const org = await getMyOrganization(auth.userId);
    const id = parse(uuid, req.params.contactId);
    const body = parse(z.object(contactFields).partial().strict(), req.body);
    const contact = await prisma.organizationContact.findFirst({ where: { id, organizationId: org.id } });
    if (!contact) throw notFound('Contact');
    await assertOwnDocuments(req, [body.nin_document_id, body.utility_bill_document_id]);
    const updated = await prisma.organizationContact.update({ where: { id }, data: contactData(body) });
    await refreshOnboarding(auth.userId);
    await audit(req, 'organization.contact_updated', 'organization_contact', id, { fields: Object.keys(body) });
    ok(res, serializeContact(updated));
  }),
);

// ── Members ──
const memberInclude = { farmer: true } as const;

// GET /organizations/me/members?status=&search=&page=&page_size=&sort=
organizationsRouter.get(
  '/me/members',
  asyncHandler(async (req, res) => {
    const org = await getMyOrganization(authOf(req).userId);
    const p = getPagination(req.query);
    const q = parse(z.object({ status: z.enum(['not_verified', 'pending', 'verified', 'rejected']).optional() }).passthrough(), req.query);
    const where: Prisma.OrganizationMembershipWhereInput = {
      organizationId: org.id,
      ...(q.status ? { status: q.status } : {}),
      ...(p.search
        ? {
            OR: [
              { membershipNumber: { contains: p.search, mode: 'insensitive' } },
              { memberName: { contains: p.search, mode: 'insensitive' } },
              { farmer: { OR: [{ firstName: { contains: p.search, mode: 'insensitive' } }, { lastName: { contains: p.search, mode: 'insensitive' } }, { agriksenseId: p.search }, { phone: p.search }] } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.organizationMembership.count({ where }),
      prisma.organizationMembership.findMany({
        where,
        include: memberInclude,
        orderBy: orderBy(p.sort, { created_at: 'createdAt', membership_id: 'membershipNumber', status: 'status' }),
        skip: p.skip,
        take: p.take,
      }),
    ]);
    ok(res, rows.map((m) => serializeMembership(m)), pageMeta(p, total));
  }),
);

// POST /organizations/me/members — link an existing farmer by AgriKSense ID or register a new farmer
const newMemberSchema = z
  .object({
    membership_id: z.string().trim().min(1).max(50).optional(),
    joined_at: isoDate.optional(),
    farmer_agriksense_id: z.string().regex(/^[0-9]{10}$/).optional(),
    farmer: z
      .object({
        first_name: z.string().trim().min(1).max(100),
        last_name: z.string().trim().min(1).max(100),
        other_name: z.string().trim().max(100).optional(),
        phone,
        email: email.optional(),
      })
      .optional(),
  })
  .refine((b) => !!b.farmer_agriksense_id !== !!b.farmer, { message: 'provide exactly one of farmer_agriksense_id or farmer', path: ['farmer'] });

organizationsRouter.post(
  '/me/members',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const org = await getMyOrganization(auth.userId);
    const body = parse(newMemberSchema, req.body);
    const membership = await createMembership(org.id, auth.userId, body);
    await audit(req, 'organization.member_created', 'organization_membership', membership.id);
    created(res, serializeMembership(membership));
  }),
);

export async function createMembership(
  organizationId: string,
  actorId: string,
  body: z.infer<typeof newMemberSchema>,
  tx?: Prisma.TransactionClient,
) {
  const db = tx ?? prisma;
  let farmerId: string;
  let newFarmer = null;
  if (body.farmer_agriksense_id) {
    const farmer = await db.user.findUnique({ where: { agriksenseId: body.farmer_agriksense_id } });
    if (!farmer || farmer.baseRole !== 'farmer') {
      throw unprocessable('No farmer with that AgriKSense ID', [{ field: 'farmer_agriksense_id', reason: 'not found' }]);
    }
    farmerId = farmer.id;
  } else {
    await assertIdentifiersAvailable(body.farmer!.email, body.farmer!.phone);
    newFarmer = await createAccount(
      {
        role: 'farmer',
        firstName: body.farmer!.first_name,
        lastName: body.farmer!.last_name,
        otherName: body.farmer!.other_name,
        phone: body.farmer!.phone,
        email: body.farmer!.email,
        createdById: actorId,
      },
      tx,
    );
    farmerId = newFarmer.id;
  }
  const existing = await db.organizationMembership.findUnique({ where: { organizationId_farmerId: { organizationId, farmerId } } });
  if (existing) throw conflict('Farmer is already a member of this organization', [{ field: 'farmer', reason: 'duplicate member' }]);
  if (body.membership_id) {
    const taken = await db.organizationMembership.findUnique({
      where: { organizationId_membershipNumber: { organizationId, membershipNumber: body.membership_id } },
    });
    if (taken) throw conflict('Membership ID is already in use', [{ field: 'membership_id', reason: 'duplicate' }]);
  }
  const membership = await db.organizationMembership.create({
    data: {
      organizationId,
      farmerId,
      membershipNumber: body.membership_id ?? (await generateMembershipNumber(organizationId, db)),
      isGeneratedNumber: !body.membership_id,
      joinedAt: body.joined_at ? new Date(body.joined_at) : null,
    },
    include: memberInclude,
  });
  if (newFarmer && !tx) await NotificationService.welcome(newFarmer);
  return membership;
}
export { newMemberSchema };

async function loadMember(orgId: string, memberId: string) {
  const m = await prisma.organizationMembership.findFirst({ where: { id: memberId, organizationId: orgId }, include: memberInclude });
  if (!m) throw notFound('Member');
  return m;
}

// GET /organizations/me/members/{memberId}
organizationsRouter.get(
  '/me/members/:memberId',
  asyncHandler(async (req, res) => {
    const org = await getMyOrganization(authOf(req).userId);
    ok(res, serializeMembership(await loadMember(org.id, parse(uuid, req.params.memberId))));
  }),
);

// PATCH /organizations/me/members/{memberId}
organizationsRouter.patch(
  '/me/members/:memberId',
  asyncHandler(async (req, res) => {
    const org = await getMyOrganization(authOf(req).userId);
    const member = await loadMember(org.id, parse(uuid, req.params.memberId));
    const body = parse(z.object({ membership_id: z.string().trim().min(1).max(50).optional(), joined_at: isoDate.nullable().optional() }).strict(), req.body);
    if (body.membership_id && body.membership_id !== member.membershipNumber) {
      const taken = await prisma.organizationMembership.findUnique({
        where: { organizationId_membershipNumber: { organizationId: org.id, membershipNumber: body.membership_id } },
      });
      if (taken) throw conflict('Membership ID is already in use', [{ field: 'membership_id', reason: 'duplicate' }]);
    }
    const changedNumber = !!body.membership_id && body.membership_id !== member.membershipNumber;
    const updated = await prisma.organizationMembership.update({
      where: { id: member.id },
      data: {
        membershipNumber: body.membership_id,
        isGeneratedNumber: changedNumber ? false : undefined,
        joinedAt: body.joined_at === undefined ? undefined : body.joined_at ? new Date(body.joined_at) : null,
        // A changed membership ID must be re-verified.
        ...(changedNumber ? { status: 'not_verified' as const, verifiedAt: null, verifiedById: null } : {}),
      },
      include: memberInclude,
    });
    await audit(req, 'organization.member_updated', 'organization_membership', member.id, { fields: Object.keys(body) });
    ok(res, serializeMembership(updated));
  }),
);

// POST /organizations/me/members/{memberId}/verify — the organization attests the membership
organizationsRouter.post(
  '/me/members/:memberId/verify',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const org = await getMyOrganization(auth.userId);
    const member = await loadMember(org.id, parse(uuid, req.params.memberId));
    const body = parse(z.object({ decision: z.enum(['verified', 'rejected']).default('verified'), reason: z.string().max(500).optional() }), req.body ?? {});
    if (!member.farmer) throw unprocessable('Membership is not linked to a farmer account');
    if (!member.farmer.isActive) throw unprocessable('Farmer account is disabled');
    if (member.status === body.decision) throw conflict(`Membership is already ${body.decision}`);
    const updated = await prisma.organizationMembership.update({
      where: { id: member.id },
      data: {
        status: body.decision,
        statusReason: body.reason ?? null,
        verifiedAt: body.decision === 'verified' ? new Date() : null,
        verifiedById: auth.userId,
      },
      include: memberInclude,
    });
    await NotificationService.inApp(
      member.farmer.id,
      'membership_update',
      `Membership ${body.decision}`,
      `${org.name} has ${body.decision === 'verified' ? 'verified' : 'rejected'} your membership (${member.membershipNumber}).`,
      { membership_id: member.id, status: body.decision },
    );
    await audit(req, 'organization.member_verified', 'organization_membership', member.id, { decision: body.decision });
    ok(res, serializeMembership(updated));
  }),
);

// GET /farmers/me/memberships
farmerMembershipsRouter.get(
  '/me/memberships',
  requireAuth,
  requireRole('farmer'),
  asyncHandler(async (req, res) => {
    const rows = await prisma.organizationMembership.findMany({
      where: { farmerId: authOf(req).userId },
      include: { organization: { include: { owner: true } } },
      orderBy: { createdAt: 'asc' },
    });
    ok(res, rows.map((m) => serializeMembership(m)));
  }),
);
