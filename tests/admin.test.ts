import crypto from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminToken, api, bearer, login, outbox, prisma, registerDco, registerFarmer, registerOrganization, uniqueEmail, uniquePhone } from './helpers';

let admin: string;
beforeAll(async () => {
  admin = await adminToken();
});

describe('admin user management', () => {
  it('lists and filters users across roles', async () => {
    const f = await registerFarmer();
    const res = await api().get(`/api/v1/admin/users?role=farmer&search=${f.agriksense_id}`).set(bearer(admin));
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0].agriksense_id).toBe(f.agriksense_id);
    const page = await api().get('/api/v1/admin/users?page=1&page_size=2&sort=-created_at').set(bearer(admin));
    expect(page.body.data).toHaveLength(2);
    expect(page.body.meta).toMatchObject({ page: 1, page_size: 2 });
    expect((await api().get('/api/v1/admin/users').set(bearer(f.token))).status).toBe(403);
  });

  it('creates users without disclosing passwords and initiates resets', async () => {
    const email = uniqueEmail('dcoadmin');
    const res = await api().post('/api/v1/admin/users').set(bearer(admin)).send({ role: 'dco', first_name: 'Ngozi', last_name: 'Obi', email, phone: uniquePhone() });
    expect(res.status).toBe(201);
    expect(res.body.data.agriksense_id).toMatch(/^\d{10}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/password|token/i);
    expect(outbox.some((m) => m.recipient === email && m.template === 'password_reset')).toBe(true);
    const reset = await api().post(`/api/v1/admin/users/${res.body.data.id}/password-reset`).set(bearer(admin));
    expect(reset.status).toBe(202);
    expect(JSON.stringify(reset.body)).not.toMatch(/token/i);

    const detail = await api().get(`/api/v1/admin/users/${res.body.data.id}`).set(bearer(admin));
    expect(detail.body.data.onboarding.onboarding_status).toBe('draft');
    const patched = await api().patch(`/api/v1/admin/users/${res.body.data.id}`).set(bearer(admin)).send({ other_name: 'Ada' });
    expect(patched.body.data.other_name).toBe('Ada');
    const org = await api().post('/api/v1/admin/users').set(bearer(admin)).send({ role: 'organization_admin', organization_name: 'Admin Made Coop', email: uniqueEmail('org') });
    expect(org.status).toBe(201);
    expect(org.body.data.full_name).toBe('Admin Made Coop');
  });

  it('shows the full onboarding record with sensitive values masked', async () => {
    const f = await registerFarmer();
    const bank = await prisma.bank.findFirstOrThrow();
    await api().post('/api/v1/bank-accounts').set(bearer(f.token)).send({ bank_id: bank.id, account_number: '1111222233', account_name: 'Ada Okoro' });
    await api().post('/api/v1/verifications/nin').set(bearer(f.token)).send({ nin: '98765432100' });
    const res = await api().get(`/api/v1/admin/users/${f.user_id}`).set(bearer(admin));
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('1111222233');
    expect(body).not.toContain('98765432100');
    expect(res.body.data.bank_accounts[0].account_number_masked).toBe('******2233');
    expect(res.body.data.consents).toHaveLength(2);
    const audits = await api().get(`/api/v1/admin/audit-logs?entity_type=user&entity_id=${f.user_id}&action=admin.user_viewed`).set(bearer(admin));
    expect(audits.body.meta.total).toBe(1);
  });

  it('prevents disabling yourself and requires a reason', async () => {
    const me = await api().get('/api/v1/auth/me').set(bearer(admin));
    expect((await api().patch(`/api/v1/admin/users/${me.body.data.user.id}/status`).set(bearer(admin)).send({ is_active: false, reason: 'x' })).status).toBe(403);
    const f = await registerFarmer();
    expect((await api().patch(`/api/v1/admin/users/${f.user_id}/status`).set(bearer(admin)).send({ is_active: false })).status).toBe(422);
  });
});

describe('roles and permissions', () => {
  it('creates a role, sets permissions, and grants it only to DCOs', async () => {
    const perms = await api().get('/api/v1/admin/permissions').set(bearer(admin));
    expect(perms.body.data.map((p: { key: string }) => p.key)).toContain('farm_assignments.manage');

    const role = await api().post('/api/v1/admin/roles').set(bearer(admin)).send({ key: `assigner_${Date.now()}`, name: 'Assignment Officer', permissions: ['visit_requests.read_all'] });
    expect(role.status).toBe(201);
    const put = await api().put(`/api/v1/admin/roles/${role.body.data.id}/permissions`).set(bearer(admin)).send({ permissions: ['visit_requests.read_all', 'farm_assignments.manage'] });
    expect(put.body.data.permissions).toEqual(['farm_assignments.manage', 'visit_requests.read_all']);
    const renamed = await api().patch(`/api/v1/admin/roles/${role.body.data.id}`).set(bearer(admin)).send({ name: 'Senior Assignment Officer' });
    expect(renamed.body.data.name).toBe('Senior Assignment Officer');
    expect((await api().put(`/api/v1/admin/roles/${role.body.data.id}/permissions`).set(bearer(admin)).send({ permissions: ['not.a.permission'] })).status).toBe(422);

    const farmer = await registerFarmer();
    const toFarmer = await api().post(`/api/v1/admin/users/${farmer.user_id}/roles`).set(bearer(admin)).send({ role_id: role.body.data.id });
    expect(toFarmer.status).toBe(422);
    expect(toFarmer.body.error.code).toBe('ROLE_ASSIGNMENT_NOT_ALLOWED');

    const dco = await registerDco();
    expect((await api().get('/api/v1/admin/visit-requests').set(bearer(dco.token))).status).toBe(403);
    expect((await api().post(`/api/v1/admin/users/${dco.user_id}/roles`).set(bearer(admin)).send({ role_id: role.body.data.id })).status).toBe(201);
    const token = await login(dco.email);
    expect((await api().get('/api/v1/admin/visit-requests').set(bearer(token))).status).toBe(200);
    const me = await api().get('/api/v1/auth/me').set(bearer(token));
    expect(me.body.data.permissions).toContain('farm_assignments.manage');
    expect((await api().get('/api/v1/admin/users').set(bearer(token))).status).toBe(403);

    expect((await api().delete(`/api/v1/admin/users/${dco.user_id}/roles/${role.body.data.id}`).set(bearer(admin))).status).toBe(204);
    expect((await api().get('/api/v1/admin/visit-requests').set(bearer(token))).status).toBe(403);
  });

  it('protects the platform admin role and system role keys', async () => {
    const roles = await api().get('/api/v1/admin/roles').set(bearer(admin));
    const pa = roles.body.data.find((r: { key: string }) => r.key === 'platform_admin');
    expect(pa.is_system).toBe(true);
    expect((await api().put(`/api/v1/admin/roles/${pa.id}/permissions`).set(bearer(admin)).send({ permissions: [] })).status).toBe(409);
    expect((await api().post('/api/v1/admin/roles').set(bearer(admin)).send({ key: 'farmer', name: 'Fake' })).status).toBe(409);
    const dco = await registerDco();
    expect((await api().post(`/api/v1/admin/users/${dco.user_id}/roles`).set(bearer(admin)).send({ role_id: pa.id })).status).toBe(422);
  });
});

describe('groups', () => {
  it('creates groups and only admits members of the matching type', async () => {
    const g = await api().post('/api/v1/admin/groups').set(bearer(admin)).send({ name: `Rice farmers ${Date.now()}`, member_type: 'farmer' });
    expect(g.status).toBe(201);
    const f1 = await registerFarmer();
    const f2 = await registerFarmer();
    const o = await registerOrganization();
    const mixed = await api().post(`/api/v1/admin/groups/${g.body.data.id}/members`).set(bearer(admin)).send({ user_ids: [f1.user_id, o.user_id] });
    expect(mixed.status).toBe(422);
    const add = await api().post(`/api/v1/admin/groups/${g.body.data.id}/members`).set(bearer(admin)).send({ user_ids: [f1.user_id, f2.user_id] });
    expect(add.body.data.added).toBe(2);
    const again = await api().post(`/api/v1/admin/groups/${g.body.data.id}/members`).set(bearer(admin)).send({ user_ids: [f1.user_id] });
    expect(again.body.data.already_members).toBe(1);
    const detail = await api().get(`/api/v1/admin/groups/${g.body.data.id}`).set(bearer(admin));
    expect(detail.body.data.members).toHaveLength(2);
    expect((await api().patch(`/api/v1/admin/groups/${g.body.data.id}`).set(bearer(admin)).send({ description: 'Kebbi cluster' })).body.data.description).toBe('Kebbi cluster');
    expect((await api().delete(`/api/v1/admin/groups/${g.body.data.id}/members/${f1.user_id}`).set(bearer(admin))).status).toBe(204);
    const list = await api().get('/api/v1/admin/groups?member_type=farmer').set(bearer(admin));
    expect(list.body.data.find((x: { id: string }) => x.id === g.body.data.id).member_count).toBe(1);
    const byGroup = await api().get(`/api/v1/admin/users?group_id=${g.body.data.id}`).set(bearer(admin));
    expect(byGroup.body.meta.total).toBe(1);
  });
});

describe('notifications, webhooks and operations', () => {
  it('lists and marks in-app notifications', async () => {
    const f = await registerFarmer();
    const list = await api().get('/api/v1/notifications?unread=true').set(bearer(f.token));
    expect(list.body.meta.unread_count).toBeGreaterThan(0);
    const id = list.body.data[0].id;
    const read = await api().patch(`/api/v1/notifications/${id}/read`).set(bearer(f.token));
    expect(read.body.data.read).toBe(true);
    const other = await registerFarmer();
    expect((await api().patch(`/api/v1/notifications/${id}/read`).set(bearer(other.token))).status).toBe(404);
  });

  it('verifies webhook signatures and updates delivery status', async () => {
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({ where: { providerMessageId: { not: null } } });
    const body = JSON.stringify({ message_id: delivery.providerMessageId, status: 'delivered' });
    const bad = await api().post('/api/v1/integrations/notifications/webhooks/termii').set('Content-Type', 'application/json').set('X-Signature', 'deadbeef').send(body);
    expect(bad.status).toBe(401);
    const sig = crypto.createHmac('sha256', 'test-webhook-secret').update(body).digest('hex');
    const good = await api().post('/api/v1/integrations/notifications/webhooks/termii').set('Content-Type', 'application/json').set('X-Signature', `sha256=${sig}`).send(body);
    expect(good.status).toBe(200);
    expect(good.body.data).toMatchObject({ matched: true, status: 'delivered' });
  });

  it('exposes liveness, readiness and the OpenAPI document', async () => {
    expect((await api().get('/api/v1/health/live')).body.data.status).toBe('ok');
    const ready = await api().get('/api/v1/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.data.checks.database.status).toBe('ok');
    const spec = await api().get('/api/v1/openapi.json');
    expect(Object.keys(spec.body.paths).length).toBeGreaterThan(100);
  });

  it('propagates X-Request-Id and returns 404 envelopes for unknown routes', async () => {
    const res = await api().get('/api/v1/does-not-exist').set('X-Request-Id', 'qa-trace-12345');
    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBe('qa-trace-12345');
    expect(res.body).toEqual({ error: { code: 'ROUTE_NOT_FOUND', message: 'No route for GET /api/v1/does-not-exist' }, request_id: 'qa-trace-12345' });
  });
});
