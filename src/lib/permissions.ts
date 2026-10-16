import { BaseRole } from '@prisma/client';

/** Every permission key the platform understands. Seeded into the Permission table. */
export const PERMISSIONS = {
  'users.read': 'View all users and their onboarding records',
  'users.write': 'Create and edit users',
  'users.manage_status': 'Enable or disable user accounts',
  'users.reset_password': 'Initiate password resets for users',
  'users.assign_roles': 'Assign or revoke roles for DCO users',
  'groups.manage': 'Create and manage farmer/DCO/organization groups',
  'roles.manage': 'Create and edit roles and their permissions',
  'farms.read_all': 'View every farm record',
  'farms.write_all': 'Create and edit any farm record',
  'visit_requests.read_all': 'View all DCO farm-visit requests',
  'farm_assignments.manage': 'Assign farms to DCOs and manage assignments',
  'fare_rates.manage': 'Set per-state fare rates',
  'records.read_all': 'View all crop, farmland and observation records',
  'records.write_all': 'Create and correct crop, farmland and observation records on any farm',
  'reports.read_all': 'View platform-wide reports and charts',
  'reports.export': 'Export reports as CSV',
  'imports.manage': 'Bulk import farmers, DCOs and organizations',
  'verifications.review': 'Review NIN/CAC verifications and access identity documents',
  'ai.models.manage': 'Approve, activate and roll back AI model versions',
  'ai.evaluations.read': 'View AI model QA evaluations',
  'ai.predictions.read_all': 'View every AI prediction',
  'dashboard.admin': 'View admin operational dashboard',
  'audit_logs.read': 'View the audit log',
  'organizations.read_all': 'View every organization and its memberships',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

/**
 * Default permission set for each base role (stored as system roles keyed by the base role name).
 * Farmers, DCOs and organization admins act on their own data through ownership checks;
 * granular grants (custom roles assigned to DCOs) add administrative permissions on top.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<BaseRole, PermissionKey[]> = {
  farmer: [],
  dco: [],
  organization_admin: [],
  platform_admin: ALL_PERMISSIONS,
};

export const SYSTEM_ROLES: { key: BaseRole; name: string; description: string }[] = [
  { key: 'farmer', name: 'Farmer', description: 'Default permissions for farmer accounts' },
  { key: 'dco', name: 'Data Collection Officer', description: 'Default permissions for DCO accounts' },
  { key: 'organization_admin', name: 'Organization Admin', description: 'Default permissions for organization accounts' },
  { key: 'platform_admin', name: 'Platform Admin', description: 'Full administrative access' },
];
