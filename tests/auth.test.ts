import { describe, expect, it } from 'vitest';
import { api, bearer, login, outbox, PASSWORD, prisma, registerFarmer, registerDco, registerOrganization, uniquePhone, adminToken } from './helpers';

describe('registration and identity', () => {
  it('registers a farmer with a 10-digit AgriKSense ID and records both consent scopes', async () => {
    const f = await registerFarmer();
    expect(f.agriksense_id).toMatch(/^[0-9]{10}$/);
    expect(f.onboarding_status).toBe('draft');
    expect(f.role).toBe('farmer');
    const consents = await prisma.consent.findMany({ where: { userId: f.user_id } });
    expect(consents.map((c) => c.scope).sort()).toEqual(['account_creation', 'farm_data_collection']);
    expect(outbox.some((m) => m.channel === 'sms' && m.text.includes(f.agriksense_id))).toBe(true);
  });

  it('keeps leading zeros in IDs (stored as strings) and IDs are unique', async () => {
    const ids = await prisma.user.findMany({ select: { agriksenseId: true } });
    expect(new Set(ids.map((i) => i.agriksenseId)).size).toBe(ids.length);
    ids.forEach((i) => expect(i.agriksenseId).toHaveLength(10));
  });

  it('registers a DCO (WhatsApp welcome) and an organization', async () => {
    const d = await registerDco();
    expect(outbox.some((m) => m.channel === 'whatsapp' && m.recipient === d.phone)).toBe(true);
    const o = await registerOrganization();
    expect(o.role).toBe('organization_admin');
    expect(o.organization_id).toBeTruthy();
  });

  it('records a rejected farm-data consent decision without blocking account creation', async () => {
    const f = await registerFarmer({ consent_accepted: false });
    const res = await api().get('/api/v1/consents/me').set(bearer(f.token));
    expect(res.body.data.status).toEqual({ account_creation: 'accepted', farm_data_collection: 'rejected' });
  });

  it('returns the standard 422 validation envelope', async () => {
    const res = await api().post('/api/v1/auth/register/farmers').send({ first_name: 'A' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual(expect.arrayContaining([{ field: 'phone', reason: 'Required' }]));
    expect(res.body.request_id).toBeTruthy();
  });

  it('rejects a stale consent version', async () => {
    const res = await api()
      .post('/api/v1/auth/register/farmers')
      .send({ first_name: 'Ada', last_name: 'Okoro', phone: uniquePhone(), password: PASSWORD, consent_version: 'v0', consent_accepted: true });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CONSENT_VERSION_MISMATCH');
  });

  it('rejects duplicate phone numbers with 409', async () => {
    const f = await registerFarmer();
    const res = await api()
      .post('/api/v1/auth/register/farmers')
      .send({ first_name: 'Ada', last_name: 'Okoro', phone: f.phone, password: PASSWORD, consent_version: 'v1', consent_accepted: true });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual([{ field: 'phone', reason: 'already registered' }]);
  });
});

describe('sessions', () => {
  it('logs in by phone, email or AgriKSense ID', async () => {
    const f = await registerFarmer();
    await login(f.phone);
    await login(f.agriksense_id);
    const d = await registerDco();
    await login(d.email);
    const bad = await api().post('/api/v1/auth/login').send({ identifier: f.phone, password: 'wrong-pass1' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns identity, permissions and onboarding state from /auth/me', async () => {
    const f = await registerFarmer();
    const res = await api().get('/api/v1/auth/me').set(bearer(f.token));
    expect(res.status).toBe(200);
    expect(res.body.data.user.agriksense_id).toBe(f.agriksense_id);
    expect(res.body.data.user).not.toHaveProperty('password_hash');
    expect(res.body.data.permissions).toEqual([]);
    expect(res.body.data.onboarding.checklist.map((c: { key: string }) => c.key)).toContain('nin_verified');
    expect((await api().get('/api/v1/auth/me')).status).toBe(401);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const f = await registerFarmer();
    const first = f.tokens.refresh_token;
    const r1 = await api().post('/api/v1/auth/refresh').send({ refresh_token: first });
    expect(r1.status).toBe(200);
    const second = r1.body.data.refresh_token;
    expect(second).not.toBe(first);
    const reuse = await api().post('/api/v1/auth/refresh').send({ refresh_token: first });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    const afterReuse = await api().post('/api/v1/auth/refresh').send({ refresh_token: second });
    expect(afterReuse.status).toBe(401);
  });

  it('logs out a session', async () => {
    const f = await registerFarmer();
    expect((await api().post('/api/v1/auth/logout').set(bearer(f.token)).send({ refresh_token: f.tokens.refresh_token })).status).toBe(204);
    expect((await api().post('/api/v1/auth/refresh').send({ refresh_token: f.tokens.refresh_token })).status).toBe(401);
  });

  it('resets a forgotten password with a one-time token', async () => {
    const d = await registerDco();
    const res = await api().post('/api/v1/auth/password/forgot').send({ identifier: d.email });
    expect(res.status).toBe(202);
    const unknown = await api().post('/api/v1/auth/password/forgot').send({ identifier: 'nobody@test.local' });
    expect(unknown.status).toBe(202);
    const msg = [...outbox].reverse().find((m) => m.recipient === d.email && m.template === 'password_reset')!;
    const token = /code is: (\S+)\./.exec(msg.text)![1];
    const reset = await api().post('/api/v1/auth/password/reset').send({ token, new_password: 'NewPassw0rd' });
    expect(reset.status).toBe(200);
    expect((await api().post('/api/v1/auth/password/reset').send({ token, new_password: 'NewPassw0rd2' })).status).toBe(400);
    await login(d.email, 'NewPassw0rd');
  });

  it('changes password and requires the current one', async () => {
    const f = await registerFarmer();
    const wrong = await api().post('/api/v1/auth/password/change').set(bearer(f.token)).send({ current_password: 'nope12345', new_password: 'Another1pass' });
    expect(wrong.status).toBe(400);
    const okRes = await api().post('/api/v1/auth/password/change').set(bearer(f.token)).send({ current_password: PASSWORD, new_password: 'Another1pass' });
    expect(okRes.status).toBe(200);
    await login(f.phone, 'Another1pass');
  });

  it('blocks disabled accounts at login and on existing tokens', async () => {
    const admin = await adminToken();
    const f = await registerFarmer();
    const res = await api().patch(`/api/v1/admin/users/${f.user_id}/status`).set(bearer(admin)).send({ is_active: false, reason: 'test' });
    expect(res.status).toBe(200);
    expect((await api().get('/api/v1/users/me').set(bearer(f.token))).status).toBe(403);
    const loginRes = await api().post('/api/v1/auth/login').send({ identifier: f.phone, password: PASSWORD });
    expect(loginRes.status).toBe(403);
    expect(loginRes.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('reports Google sign-in as not configured when no client ID is set', async () => {
    const res = await api().post('/api/v1/auth/oauth/google').send({ id_token: 'x'.repeat(20) });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NOT_CONFIGURED');
  });
});
