import { OnboardingStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';

export interface ChecklistItem {
  key: string;
  label: string;
  required: boolean;
  done: boolean;
  status?: string;
}

export interface OnboardingState {
  onboarding_status: OnboardingStatus;
  checklist: ChecklistItem[];
}

/**
 * Compute the onboarding checklist and status from current data, then persist the status.
 * "complete" requires identity verification to be confirmed — it is never implied by submission.
 */
export async function refreshOnboarding(userId: string, tx: Prisma.TransactionClient = prisma): Promise<OnboardingState> {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      organization: { include: { contacts: { select: { contactType: true } } } },
      consents: { where: { scope: 'farm_data_collection' }, orderBy: { decidedAt: 'desc' }, take: 1 },
      _count: { select: { bankAccounts: { where: { deletedAt: null } } } },
    },
  });

  const checklist: ChecklistItem[] = [];
  const hasBank = user._count.bankAccounts > 0;
  let verificationItemKey: string | null = null;
  let verificationStatus: string = 'not_submitted';

  if (user.baseRole === 'farmer' || user.baseRole === 'dco') {
    const profileDone = !!(user.firstName && user.lastName && user.address && user.city && user.stateId && user.lgaId);
    if (user.baseRole === 'farmer') {
      // Informational: farm-data consent is a separate decision and does not gate onboarding.
      const latest = user.consents[0];
      const consentActive = !!latest && latest.decision === 'accepted' && !latest.withdrawnAt;
      checklist.push({ key: 'farm_data_consent', label: 'Farm visit / data collection consent', required: false, done: consentActive, status: latest ? (latest.withdrawnAt ? 'withdrawn' : latest.decision) : 'not_given' });
    }
    checklist.push(
      { key: 'profile_details', label: 'Complete personal details and residence', required: true, done: profileDone },
      { key: 'passport_photo', label: 'Upload passport photograph', required: true, done: !!user.photoDocumentId },
      { key: 'nin_submitted', label: 'Submit NIN for verification', required: true, done: user.ninStatus !== 'not_submitted' && user.ninStatus !== 'rejected', status: user.ninStatus },
      { key: 'nin_verified', label: 'NIN verified', required: true, done: user.ninStatus === 'verified', status: user.ninStatus },
      { key: 'bank_account', label: 'Add bank account', required: true, done: hasBank },
    );
    verificationItemKey = 'nin_verified';
    verificationStatus = user.ninStatus;
  } else if (user.baseRole === 'organization_admin') {
    const org = user.organization;
    const detailsDone = !!(org?.name && org.headquartersAddress && org.city && org.stateId && org.lgaId);
    const contacts = org?.contacts ?? [];
    const needsDirector = !!org?.isRegistered;
    const contactsDone = needsDirector ? contacts.some((c) => c.contactType === 'director') : contacts.length > 0;
    checklist.push(
      { key: 'organization_details', label: 'Organization headquarters details', required: true, done: detailsDone },
      { key: 'contacts', label: needsDirector ? 'Add at least one director' : 'Add a contact person', required: true, done: contactsDone },
    );
    if (org?.isRegistered) {
      checklist.push(
        { key: 'cac_submitted', label: 'Submit CAC registration for verification', required: true, done: org.cacStatus !== 'not_submitted' && org.cacStatus !== 'rejected', status: org.cacStatus },
        { key: 'cac_verified', label: 'CAC registration verified', required: true, done: org.cacStatus === 'verified', status: org.cacStatus },
      );
      verificationItemKey = 'cac_verified';
      verificationStatus = org.cacStatus;
    }
    checklist.push({ key: 'bank_account', label: 'Add bank account', required: true, done: hasBank });
  }

  let status: OnboardingStatus;
  const required = checklist.filter((c) => c.required);
  if (user.baseRole === 'platform_admin' || required.every((c) => c.done)) {
    status = 'complete';
  } else if (
    verificationItemKey &&
    required.filter((c) => c.key !== verificationItemKey).every((c) => c.done) &&
    (verificationStatus === 'pending' || verificationStatus === 'manual_review')
  ) {
    status = 'pending_verification';
  } else {
    status = 'draft';
  }

  if (status !== user.onboardingStatus) {
    await tx.user.update({ where: { id: userId }, data: { onboardingStatus: status } });
  }
  return { onboarding_status: status, checklist };
}
