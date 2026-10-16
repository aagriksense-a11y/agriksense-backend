import { describe, expect, it } from 'vitest';
import { api, bearer, flushVerifications, png, pdf, prisma, registerFarmer, registerDco, stateAndLga, adminToken } from './helpers';

async function completeProfile(token: string, role: 'farmer' | 'dco' = 'farmer') {
  const { stateId, lgaId } = await stateAndLga();
  const extra = role === 'farmer' ? { manager_name: 'Uche', primary_crops: ['rice'] } : { availability: { days: ['mon', 'wed'] }, has_transport: true };
  const res = await api()
    .patch('/api/v1/users/me/onboarding')
    .set(bearer(token))
    .send({ address: '12 Farm Road', city: 'Gwagwalada', state_id: stateId, lga_id: lgaId, ...extra });
  expect(res.status).toBe(200);
  return res.body.data.onboarding;
}

async function addBank(token: string) {
  const bank = await prisma.bank.findFirstOrThrow({ where: { code: '058' } });
  return api().post('/api/v1/bank-accounts').set(bearer(token)).send({ bank_id: bank.id, account_number: '0123456789', account_name: 'Ada Okoro' });
}

describe('profile and onboarding', () => {
  it('reads and updates the profile; never lets users change role or ID', async () => {
    const f = await registerFarmer();
    const me = await api().get('/api/v1/users/me').set(bearer(f.token));
    expect(me.body.data.agriksense_id).toBe(f.agriksense_id);
    const pid = await api().get('/api/v1/users/me/platform-id').set(bearer(f.token));
    expect(pid.body.data).toEqual({ agriksense_id: f.agriksense_id, role: 'farmer' });
    const bad = await api().patch('/api/v1/users/me').set(bearer(f.token)).send({ role: 'platform_admin' });
    expect(bad.status).toBe(422);
    const okRes = await api().patch('/api/v1/users/me').set(bearer(f.token)).send({ other_name: 'Chi' });
    expect(okRes.body.data.other_name).toBe('Chi');
  });

  it('validates that the LGA belongs to the state', async () => {
    const f = await registerFarmer();
    const { stateId } = await stateAndLga('LA', 'Ikeja');
    const { lgaId } = await stateAndLga('FC', 'Bwari');
    const res = await api().patch('/api/v1/users/me').set(bearer(f.token)).send({ state_id: stateId, lga_id: lgaId });
    expect(res.status).toBe(422);
  });

  it('walks a farmer to "complete" only after NIN is verified', async () => {
    const f = await registerFarmer();
    await completeProfile(f.token);
    const photo = await api().post('/api/v1/users/me/photo').set(bearer(f.token)).attach('file', png(), 'me.png');
    expect(photo.status).toBe(201);
    expect((await addBank(f.token)).status).toBe(201);

    let ob = await api().get('/api/v1/users/me/onboarding').set(bearer(f.token));
    expect(ob.body.data.onboarding_status).toBe('draft');

    const sub = await api().post('/api/v1/verifications/nin').set(bearer(f.token)).send({ nin: '12345670000' });
    expect(sub.status).toBe(202);
    expect(sub.body.data.status).toBe('pending'); // never verified on submission
    expect(sub.body.data.number_masked).toBe('*******0000');
    expect(JSON.stringify(sub.body)).not.toContain('12345670000');

    await flushVerifications();
    const result = await api().get(`/api/v1/verifications/nin/${sub.body.data.request_id}`).set(bearer(f.token));
    expect(result.body.data.status).toBe('verified');
    expect(result.body.data.name_match).toBe('match');
    ob = await api().get('/api/v1/users/me/onboarding').set(bearer(f.token));
    expect(ob.body.data.onboarding_status).toBe('complete');
  });

  it('routes name mismatches and provider timeouts to manual review, then a reviewer decides', async () => {
    const d = await registerDco();
    await completeProfile(d.token, 'dco');
    const sub = await api().post('/api/v1/verifications/nin').set(bearer(d.token)).send({ nin: '22222221111' });
    await flushVerifications();
    const r = await api().get(`/api/v1/verifications/nin/${sub.body.data.request_id}`).set(bearer(d.token));
    expect(r.body.data.status).toBe('manual_review');
    expect(r.body.data.name_match).toBe('mismatch');

    // Another user cannot read this verification
    const other = await registerFarmer();
    expect((await api().get(`/api/v1/verifications/nin/${sub.body.data.request_id}`).set(bearer(other.token))).status).toBe(404);

    const admin = await adminToken();
    const queue = await api().get('/api/v1/admin/verifications?status=manual_review').set(bearer(admin));
    expect(queue.body.data.some((v: { id: string }) => v.id === sub.body.data.request_id)).toBe(true);
    const detail = await api().get(`/api/v1/admin/verifications/${sub.body.data.request_id}`).set(bearer(admin));
    expect(detail.body.data.number).toBe('22222221111');
    const review = await api().post(`/api/v1/admin/verifications/${sub.body.data.request_id}/review`).set(bearer(admin)).send({ decision: 'verified', notes: 'Checked against slip' });
    expect(review.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: d.user_id } })).ninStatus).toBe('verified');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'verification.number_revealed', entityId: sub.body.data.request_id } });
    expect(audit).toBeTruthy();
  });

  it('marks provider rejections explicitly and allows resubmission', async () => {
    const f = await registerFarmer();
    const sub = await api().post('/api/v1/verifications/nin').set(bearer(f.token)).send({ nin: '33333339999' });
    await flushVerifications();
    const r = await api().get(`/api/v1/verifications/nin/${sub.body.data.request_id}`).set(bearer(f.token));
    expect(r.body.data.status).toBe('rejected');
    const again = await api().post('/api/v1/verifications/nin').set(bearer(f.token)).send({ nin: '33333330000' });
    expect(again.status).toBe(202);
    await flushVerifications();
    const list = await api().get('/api/v1/verifications/me').set(bearer(f.token));
    expect(list.body.data).toHaveLength(2);
  });

  it('never auto-verifies a NIN already used by another account', async () => {
    const a = await registerFarmer();
    await api().post('/api/v1/verifications/nin').set(bearer(a.token)).send({ nin: '44444440000' });
    await flushVerifications();
    const b = await registerFarmer();
    const sub = await api().post('/api/v1/verifications/nin').set(bearer(b.token)).send({ nin: '44444440000' });
    await flushVerifications();
    const r = await api().get(`/api/v1/verifications/nin/${sub.body.data.request_id}`).set(bearer(b.token));
    expect(r.body.data.status).toBe('manual_review');
    expect(r.body.data.failure_reason).toMatch(/another account/);
  });
});

describe('documents', () => {
  it('stores private documents, issues short-lived signed links, and enforces ownership', async () => {
    const f = await registerFarmer();
    const up = await api().post('/api/v1/documents').set(bearer(f.token)).field('type', 'nin').attach('file', pdf(), 'nin.pdf');
    expect(up.status).toBe(201);
    expect(up.body.data.mime_type).toBe('application/pdf');
    const link = await api().get(`/api/v1/documents/${up.body.data.id}/access`).set(bearer(f.token));
    expect(link.status).toBe(200);
    const path = new URL(link.body.data.url).pathname;
    const file = await api().get(path);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect((await api().get(path.slice(0, -3) + 'abc')).status).toBe(403);

    const other = await registerFarmer();
    expect((await api().get(`/api/v1/documents/${up.body.data.id}/access`).set(bearer(other.token))).status).toBe(404);
  });

  it('rejects files whose content is not an allowed type, regardless of declared MIME', async () => {
    const f = await registerFarmer();
    const res = await api().post('/api/v1/documents').set(bearer(f.token)).field('type', 'nin').attach('file', Buffer.from('MZ fake exe'), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(415);
    const photo = await api().post('/api/v1/users/me/photo').set(bearer(f.token)).attach('file', pdf(), 'photo.pdf');
    expect(photo.status).toBe(415);
  });

  it('retains documents that support a verification', async () => {
    const f = await registerFarmer();
    const up = await api().post('/api/v1/documents').set(bearer(f.token)).field('type', 'nin').attach('file', pdf(), 'nin.pdf');
    await api().post('/api/v1/verifications/nin').set(bearer(f.token)).send({ nin: '55555550000', document_id: up.body.data.id });
    await flushVerifications();
    expect((await api().delete(`/api/v1/documents/${up.body.data.id}`).set(bearer(f.token))).status).toBe(409);
    const spare = await api().post('/api/v1/documents').set(bearer(f.token)).field('type', 'other').attach('file', pdf(), 'x.pdf');
    expect((await api().delete(`/api/v1/documents/${spare.body.data.id}`).set(bearer(f.token))).status).toBe(204);
  });
});

describe('bank accounts and consents', () => {
  it('masks account numbers, keeps a primary account and soft-deletes', async () => {
    const f = await registerFarmer();
    const a = await addBank(f.token);
    expect(a.body.data.account_number_masked).toBe('******6789');
    expect(JSON.stringify(a.body)).not.toContain('0123456789');
    expect(a.body.data.is_primary).toBe(true);
    expect((await addBank(f.token)).status).toBe(409);
    expect((await api().delete(`/api/v1/bank-accounts/${a.body.data.id}`).set(bearer(f.token))).status).toBe(409);
    const banks = await api().get('/api/v1/banks');
    const b2 = await api().post('/api/v1/bank-accounts').set(bearer(f.token)).send({ bank_id: banks.body.data[0].id, account_number: '9876543210', account_name: 'Ada Okoro', is_primary: true });
    expect(b2.body.data.is_primary).toBe(true);
    expect((await api().delete(`/api/v1/bank-accounts/${a.body.data.id}`).set(bearer(f.token))).status).toBe(204);
    const list = await api().get('/api/v1/bank-accounts').set(bearer(f.token));
    expect(list.body.data).toHaveLength(1);
    const stored = await prisma.bankAccount.findUniqueOrThrow({ where: { id: a.body.data.id } });
    expect(stored.deletedAt).not.toBeNull();
    expect(stored.accountNumberEncrypted).not.toContain('0123456789');
  });

  it('serves the current consent wording and records withdrawal', async () => {
    const cur = await api().get('/api/v1/consents/current?scope=farm_data_collection');
    expect(cur.body.data[0].version).toBe('v1');
    const f = await registerFarmer();
    const me = await api().get('/api/v1/consents/me').set(bearer(f.token));
    const farmConsent = me.body.data.history.find((c: { scope: string }) => c.scope === 'farm_data_collection');
    const w = await api().post(`/api/v1/consents/${farmConsent.id}/withdraw`).set(bearer(f.token)).send({ reason: 'changed my mind' });
    expect(w.status).toBe(200);
    expect(w.body.data.status).toBe('withdrawn');
    const after = await api().get('/api/v1/consents/me').set(bearer(f.token));
    expect(after.body.data.status.farm_data_collection).toBe('withdrawn');
    const re = await api().post('/api/v1/consents').set(bearer(f.token)).send({ version: 'v1', scope: 'farm_data_collection', decision: 'accepted' });
    expect(re.status).toBe(201);
  });

  it('lists locations', async () => {
    const states = await api().get('/api/v1/locations/states');
    expect(states.body.data).toHaveLength(37);
    const fct = states.body.data.find((s: { code: string }) => s.code === 'FC');
    const lgas = await api().get(`/api/v1/locations/lgas?stateId=${fct.id}`);
    expect(lgas.body.data.map((l: { name: string }) => l.name)).toContain('Bwari');
    const bwari = lgas.body.data.find((l: { name: string }) => l.name === 'Bwari');
    const cities = await api().get(`/api/v1/locations/cities?lgaId=${bwari.id}`);
    expect(cities.body.data.map((c: { name: string }) => c.name)).toContain('Kubwa');
  });
});
