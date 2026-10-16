import type { BankAccount, Bank, Organization, User, Farm, State, Lga } from '@prisma/client';

export const isoDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function fullName(u: Pick<User, 'firstName' | 'lastName' | 'otherName'>): string | null {
  const parts = [u.firstName, u.otherName, u.lastName].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

type UserWithLocation = User & { state?: State | null; lga?: Lga | null; organization?: Organization | null };

/** Public user shape. Never includes password hash, NIN or bank numbers. */
export function serializeUser(u: UserWithLocation) {
  return {
    id: u.id,
    agriksense_id: u.agriksenseId,
    role: u.baseRole,
    first_name: u.firstName,
    last_name: u.lastName,
    other_name: u.otherName,
    full_name: u.baseRole === 'organization_admin' && u.organization ? u.organization.name : fullName(u),
    email: u.email,
    phone: u.phone,
    alt_phone: u.altPhone,
    date_of_birth: isoDate(u.dateOfBirth),
    gender: u.gender,
    address: u.address,
    city: u.city,
    state: u.state ? { id: u.state.id, name: u.state.name } : u.stateId ? { id: u.stateId } : null,
    lga: u.lga ? { id: u.lga.id, name: u.lga.name } : u.lgaId ? { id: u.lgaId } : null,
    photo_document_id: u.photoDocumentId,
    auth_provider: u.authProvider,
    is_active: u.isActive,
    onboarding_status: u.onboardingStatus,
    nin_verification_status: u.ninStatus,
    organization_id: u.organization?.id ?? null,
    last_login_at: iso(u.lastLoginAt),
    created_at: iso(u.createdAt),
    updated_at: iso(u.updatedAt),
  };
}

/** Compact reference to a user for embedding in other resources. */
export function userRef(u: Pick<User, 'id' | 'agriksenseId' | 'firstName' | 'lastName' | 'otherName' | 'baseRole'>) {
  return { id: u.id, agriksense_id: u.agriksenseId, name: fullName(u), role: u.baseRole };
}

export function serializeBankAccount(a: BankAccount & { bank: Bank }) {
  return {
    id: a.id,
    bank: { id: a.bank.id, name: a.bank.name, code: a.bank.code },
    account_name: a.accountName,
    account_number_masked: `******${a.accountNumberLast4}`,
    is_primary: a.isPrimary,
    created_at: iso(a.createdAt),
    updated_at: iso(a.updatedAt),
  };
}

export function serializeOrganization(o: Organization & { owner?: User; state?: State | null; lga?: Lga | null }) {
  return {
    id: o.id,
    agriksense_id: o.owner?.agriksenseId ?? null,
    name: o.name,
    email: o.owner?.email ?? null,
    phone: o.owner?.phone ?? null,
    is_registered: o.isRegistered,
    cac_verification_status: o.cacStatus,
    headquarters: {
      address: o.headquartersAddress,
      city: o.city,
      state: o.state ? { id: o.state.id, name: o.state.name } : o.stateId ? { id: o.stateId } : null,
      lga: o.lga ? { id: o.lga.id, name: o.lga.name } : o.lgaId ? { id: o.lgaId } : null,
    },
    description: o.description,
    created_at: iso(o.createdAt),
    updated_at: iso(o.updatedAt),
  };
}

export function serializeFarm(f: Farm & { state?: State; lga?: Lga; owner?: User | null }) {
  return {
    id: f.id,
    name: f.name,
    address: f.address,
    landmark: f.landmark,
    village: f.village,
    city: f.city,
    state: f.state ? { id: f.state.id, name: f.state.name } : { id: f.stateId },
    lga: f.lga ? { id: f.lga.id, name: f.lga.name } : { id: f.lgaId },
    latitude: f.latitude,
    longitude: f.longitude,
    owner: f.owner ? userRef(f.owner) : f.ownerId ? { id: f.ownerId } : null,
    is_active: f.isActive,
    created_at: iso(f.createdAt),
    updated_at: iso(f.updatedAt),
  };
}

/** NGN helpers: rates displayed as decimal strings, computed amounts as integer kobo. */
export const koboToNairaString = (kobo: number) => (kobo / 100).toFixed(2);
export function nairaStringToKobo(value: string): number {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error('Invalid naira amount');
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}
