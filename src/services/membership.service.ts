import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import type { OrganizationMembership, Organization, User } from '@prisma/client';
import { prisma } from '../config/prisma';
import { fullName, iso, isoDate } from '../lib/serializers';

export async function generateMembershipNumber(organizationId: string, tx: Prisma.TransactionClient = prisma): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const candidate = `AKM-${crypto.randomInt(0, 100_000_000).toString().padStart(8, '0')}`;
    const exists = await tx.organizationMembership.findUnique({
      where: { organizationId_membershipNumber: { organizationId, membershipNumber: candidate } },
      select: { id: true },
    });
    if (!exists) return candidate;
  }
  throw new Error('Unable to generate a unique membership number');
}

export function serializeMembership(m: OrganizationMembership & { farmer?: User | null; organization?: (Organization & { owner?: User }) | null }) {
  return {
    id: m.id,
    membership_id: m.membershipNumber,
    is_generated_membership_id: m.isGeneratedNumber,
    status: m.status,
    status_reason: m.statusReason,
    verified: m.status === 'verified',
    verified_at: iso(m.verifiedAt),
    joined_at: isoDate(m.joinedAt),
    member_name: m.farmer ? fullName(m.farmer) : m.memberName,
    member_phone: m.farmer ? m.farmer.phone : m.memberPhone,
    farmer: m.farmer
      ? { id: m.farmer.id, agriksense_id: m.farmer.agriksenseId, onboarding_status: m.farmer.onboardingStatus, nin_verification_status: m.farmer.ninStatus }
      : null,
    organization: m.organization
      ? { id: m.organization.id, name: m.organization.name, agriksense_id: m.organization.owner?.agriksenseId ?? null }
      : { id: m.organizationId },
    created_at: iso(m.createdAt),
    updated_at: iso(m.updatedAt),
  };
}
