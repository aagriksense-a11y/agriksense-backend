import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { asyncHandler, created, ok } from '../lib/http';
import { parse, email, phone, name, isoDate, intId } from '../lib/validation';
import { serializeUser, serializeOrganization } from '../lib/serializers';
import { audit } from '../lib/audit';
import { authOf, requireAuth } from '../middleware/auth';
import { singleFile } from '../middleware/upload';
import { refreshOnboarding } from '../services/onboarding.service';
import { assertIdentifiersAvailable } from '../services/user.service';
import { assertLocation } from '../services/location.service';
import { serializeDocument, storeUpload } from '../services/document.service';

const router = Router();
router.use(requireAuth);

async function loadMe(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { state: true, lga: true, organization: true, farmerProfile: true, dcoProfile: true },
  });
}

function serializeMe(user: Awaited<ReturnType<typeof loadMe>>) {
  return {
    ...serializeUser(user),
    farmer_profile: user.farmerProfile
      ? {
          manager_name: user.farmerProfile.managerName,
          manager_phone: user.farmerProfile.managerPhone,
          manager_email: user.farmerProfile.managerEmail,
          farming_group: user.farmerProfile.farmingGroup,
          primary_crops: user.farmerProfile.primaryCrops,
          years_farming: user.farmerProfile.yearsFarming,
        }
      : undefined,
    dco_profile: user.dcoProfile
      ? { availability: user.dcoProfile.availability, has_transport: user.dcoProfile.hasTransport, education_level: user.dcoProfile.educationLevel }
      : undefined,
  };
}

const profileFields = {
  first_name: name.optional(),
  last_name: name.optional(),
  other_name: name.nullable().optional(),
  email: email.nullable().optional(),
  phone: phone.optional(),
  alt_phone: phone.nullable().optional(),
  date_of_birth: isoDate.nullable().optional(),
  gender: z.enum(['male', 'female', 'other', 'prefer_not_to_say']).nullable().optional(),
  address: z.string().trim().min(3).max(300).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  state_id: intId.optional(),
  lga_id: intId.optional(),
};

type ProfileInput = z.infer<z.ZodObject<typeof profileFields>>;

async function applyProfile(userId: string, body: ProfileInput) {
  const current = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await assertIdentifiersAvailable(body.email ?? undefined, body.phone, userId);
  const stateId = body.state_id ?? current.stateId;
  const lgaId = body.lga_id ?? (body.state_id && body.state_id !== current.stateId ? null : current.lgaId);
  await assertLocation(stateId, lgaId);
  const data: Prisma.UserUpdateInput = {
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
    state: stateId ? { connect: { id: stateId } } : undefined,
    lga: lgaId ? { connect: { id: lgaId } } : current.lgaId && !lgaId ? { disconnect: true } : undefined,
  };
  await prisma.user.update({ where: { id: userId }, data });
}

// GET /users/me
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    ok(res, serializeMe(await loadMe(authOf(req).userId)));
  }),
);

// PATCH /users/me — only self-editable profile fields (never role, ID, NIN or status)
router.patch(
  '/me',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = parse(z.object(profileFields).strict(), req.body);
    await applyProfile(auth.userId, body);
    await refreshOnboarding(auth.userId);
    await audit(req, 'user.profile_updated', 'user', auth.userId, { fields: Object.keys(body) });
    ok(res, serializeMe(await loadMe(auth.userId)));
  }),
);

// GET /users/me/onboarding
router.get(
  '/me/onboarding',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const state = await refreshOnboarding(auth.userId);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, include: { organization: true } });
    ok(res, {
      ...state,
      agriksense_id: user.agriksenseId,
      role: user.baseRole,
      identity_verification_status: user.baseRole === 'organization_admin' ? user.organization?.cacStatus ?? 'not_submitted' : user.ninStatus,
    });
  }),
);

// PATCH /users/me/onboarding — stage-two details per role
const farmerStage2 = z.object({
  ...profileFields,
  manager_name: z.string().trim().max(150).nullable().optional(),
  manager_phone: phone.nullable().optional(),
  manager_email: email.nullable().optional(),
  farming_group: z.string().trim().max(150).nullable().optional(),
  primary_crops: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  years_farming: z.number().int().min(0).max(100).nullable().optional(),
}).strict();
const dcoStage2 = z.object({
  ...profileFields,
  availability: z
    .object({
      days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).min(1),
      notes: z.string().max(500).optional(),
    })
    .optional(),
  has_transport: z.boolean().optional(),
  education_level: z.string().max(100).nullable().optional(),
}).strict();
const orgStage2 = z.object({
  organization_name: z.string().trim().min(2).max(200).optional(),
  headquarters_address: z.string().trim().min(3).max(300).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  state_id: intId.optional(),
  lga_id: intId.optional(),
  is_registered: z.boolean().optional(),
  description: z.string().max(1000).nullable().optional(),
  phone: phone.optional(),
}).strict();

router.patch(
  '/me/onboarding',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    if (auth.role === 'farmer') {
      const body = parse(farmerStage2, req.body);
      const { manager_name, manager_phone, manager_email, farming_group, primary_crops, years_farming, ...profile } = body;
      await applyProfile(auth.userId, profile);
      await prisma.farmerProfile.upsert({
        where: { userId: auth.userId },
        create: { userId: auth.userId, managerName: manager_name, managerPhone: manager_phone, managerEmail: manager_email, farmingGroup: farming_group, primaryCrops: primary_crops ?? [], yearsFarming: years_farming },
        update: { managerName: manager_name, managerPhone: manager_phone, managerEmail: manager_email, farmingGroup: farming_group, primaryCrops: primary_crops, yearsFarming: years_farming },
      });
    } else if (auth.role === 'dco') {
      const body = parse(dcoStage2, req.body);
      const { availability, has_transport, education_level, ...profile } = body;
      await applyProfile(auth.userId, profile);
      await prisma.dcoProfile.upsert({
        where: { userId: auth.userId },
        create: { userId: auth.userId, availability: availability as Prisma.InputJsonValue | undefined, hasTransport: has_transport, educationLevel: education_level },
        update: { availability: availability as Prisma.InputJsonValue | undefined, hasTransport: has_transport, educationLevel: education_level },
      });
    } else if (auth.role === 'organization_admin') {
      const body = parse(orgStage2, req.body);
      await updateOrganizationProfile(auth.userId, body);
    } else {
      await applyProfile(auth.userId, parse(z.object(profileFields).strict(), req.body));
    }
    const state = await refreshOnboarding(auth.userId);
    await audit(req, 'user.onboarding_updated', 'user', auth.userId, { fields: Object.keys(req.body ?? {}) });
    ok(res, { user: serializeMe(await loadMe(auth.userId)), onboarding: state });
  }),
);

export async function updateOrganizationProfile(userId: string, body: z.infer<typeof orgStage2>) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { ownerUserId: userId } });
  const stateId = body.state_id ?? org.stateId;
  const lgaId = body.lga_id ?? (body.state_id && body.state_id !== org.stateId ? null : org.lgaId);
  await assertLocation(stateId, lgaId);
  if (body.phone) await assertIdentifiersAvailable(undefined, body.phone, userId);
  await prisma.$transaction([
    prisma.organization.update({
      where: { id: org.id },
      data: {
        name: body.organization_name,
        headquartersAddress: body.headquarters_address,
        city: body.city,
        stateId,
        lgaId,
        isRegistered: body.is_registered,
        description: body.description,
        // Switching to "unregistered" clears any CAC requirement; switching back requires re-verification.
        ...(body.is_registered === false ? { cacStatus: 'not_submitted' as const } : {}),
      },
    }),
    ...(body.phone ? [prisma.user.update({ where: { id: userId }, data: { phone: body.phone } })] : []),
  ]);
  const updated = await prisma.organization.findUniqueOrThrow({ where: { id: org.id }, include: { owner: true, state: true, lga: true } });
  return serializeOrganization(updated);
}
export { orgStage2 as organizationUpdateSchema };

// POST /users/me/photo — passport photograph (JPEG/PNG/WebP, validated by content)
router.post(
  '/me/photo',
  singleFile,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const doc = await storeUpload(req.file, auth.userId, 'passport_photo');
    await prisma.user.update({ where: { id: auth.userId }, data: { photoDocumentId: doc.id } });
    await refreshOnboarding(auth.userId);
    await audit(req, 'user.photo_uploaded', 'document', doc.id);
    created(res, serializeDocument(doc));
  }),
);

// GET /users/me/platform-id
router.get(
  '/me/platform-id',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    ok(res, { agriksense_id: auth.agriksenseId, role: auth.role });
  }),
);

export default router;
