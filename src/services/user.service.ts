import bcrypt from 'bcryptjs';
import { BaseRole, ConsentDecision, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { allocateAgriksenseId } from '../lib/agriksense-id';
import { conflict, unprocessable } from '../lib/errors';
import { refreshOnboarding } from './onboarding.service';

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

export interface NewAccountInput {
  role: BaseRole;
  email?: string | null;
  phone?: string | null;
  password?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  otherName?: string | null;
  organizationName?: string | null;
  organizationIsRegistered?: boolean;
  authProvider?: 'local' | 'google';
  googleSubject?: string | null;
  createdById?: string | null;
  stateId?: number | null;
  lgaId?: number | null;
  city?: string | null;
  address?: string | null;
  /** Farmer consent decisions recorded atomically with account creation. */
  consent?: { version: string; farmDataDecision: ConsentDecision; actorId?: string; channel?: string };
}

export async function assertIdentifiersAvailable(email?: string | null, phone?: string | null, excludeUserId?: string) {
  const or: Prisma.UserWhereInput[] = [];
  if (email) or.push({ email });
  if (phone) or.push({ phone });
  if (!or.length) return;
  const existing = await prisma.user.findFirst({
    where: { OR: or, ...(excludeUserId ? { NOT: { id: excludeUserId } } : {}) },
    select: { email: true, phone: true },
  });
  if (existing) {
    const fields = [];
    if (email && existing.email === email) fields.push({ field: 'email', reason: 'already registered' });
    if (phone && existing.phone === phone) fields.push({ field: 'phone', reason: 'already registered' });
    throw conflict('An account with these details already exists', fields);
  }
}

export async function assertCurrentConsentVersion(version: string, scope: 'account_creation' | 'farm_data_collection' = 'farm_data_collection') {
  const doc = await prisma.consentDocument.findFirst({ where: { scope, isCurrent: true } });
  if (!doc) return; // no published consent document yet; accept any version string
  if (doc.version !== version) {
    throw unprocessable('Consent version is not current', [{ field: 'consent_version', reason: `current version is ${doc.version}` }], 'CONSENT_VERSION_MISMATCH');
  }
}

/** Create a user of any base role, with profile rows and its immutable 10-digit AgriKSense ID. */
export async function createAccount(input: NewAccountInput, tx?: Prisma.TransactionClient) {
  const run = async (t: Prisma.TransactionClient) => {
    const agriksenseId = await allocateAgriksenseId(t);
    const passwordHash = input.password ? await hashPassword(input.password) : null;
    const user = await t.user.create({
      data: {
        agriksenseId,
        baseRole: input.role,
        email: input.email || null,
        phone: input.phone || null,
        passwordHash,
        authProvider: input.authProvider ?? 'local',
        googleSubject: input.googleSubject ?? null,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        otherName: input.otherName ?? null,
        stateId: input.stateId ?? null,
        lgaId: input.lgaId ?? null,
        city: input.city ?? null,
        address: input.address ?? null,
        createdById: input.createdById ?? null,
        ...(input.role === 'farmer' ? { farmerProfile: { create: {} } } : {}),
        ...(input.role === 'dco' ? { dcoProfile: { create: {} } } : {}),
        ...(input.role === 'organization_admin'
          ? { organization: { create: { name: input.organizationName ?? 'Unnamed organization', isRegistered: !!input.organizationIsRegistered } } }
          : {}),
      },
    });
    if (input.consent) {
      const actorId = input.consent.actorId ?? user.id;
      await t.consent.createMany({
        data: [
          { userId: user.id, version: input.consent.version, scope: 'account_creation', decision: 'accepted', actorId, channel: input.consent.channel },
          { userId: user.id, version: input.consent.version, scope: 'farm_data_collection', decision: input.consent.farmDataDecision, actorId, channel: input.consent.channel },
        ],
      });
    }
    await refreshOnboarding(user.id, t);
    return t.user.findUniqueOrThrow({ where: { id: user.id }, include: { organization: true } });
  };
  return tx ? run(tx) : prisma.$transaction(run);
}
