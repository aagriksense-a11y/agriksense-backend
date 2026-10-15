import { describe, expect, it } from 'vitest';
import { adminToken, api, bearer, flushVerifications, pdf, prisma, registerFarmer, registerOrganization, stateAndLga, uniquePhone, uniqueEmail } from './helpers';

describe('organization onboarding', () => {
  it('updates headquarters, manages contacts and completes CAC verification', async () => {
    const o = await registerOrganization(true);
    const { stateId, lgaId } = await stateAndLga('KD', 'Zaria');
    const patch = await api().patch('/api/v1/organizations/me').set(bearer(o.token)).send({ headquarters_address: '1 Coop Way', city: 'Zaria', state_id: stateId, lga_id: lgaId });
    expect(patch.status).toBe(200);
    expect(patch.body.data.headquarters.state.name).toBe('Kaduna');

    const bill = await api().post('/api/v1/documents').set(bearer(o.token)).field('type', 'utility_bill').attach('file', pdf(), 'bill.pdf');
    const missingBill = await api().post('/api/v1/organizations/me/contacts').set(bearer(o.token)).send({ contact_type: 'director', full_name: 'Jane Director', phone: uniquePhone() });
    expect(missingBill.status).toBe(422);
    const dir = await api()
      .post('/api/v1/organizations/me/contacts')
      .set(bearer(o.token))
      .send({ contact_type: 'director', full_name: 'Jane Director', phone: uniquePhone(), nin: '12312312312', utility_bill_document_id: bill.body.data.id });
    expect(dir.status).toBe(201);
    expect(dir.body.data.nin_masked).toBe('*******2312');
    const upd = await api().patch(`/api/v1/organizations/me/contacts/${dir.body.data.id}`).set(bearer(o.token)).send({ position: 'Chair' });
    expect(upd.body.data.position).toBe('Chair');
    expect((await api().get('/api/v1/organizations/me/contacts').set(bearer(o.token))).body.data).toHaveLength(1);

    const cert = await api().post('/api/v1/documents').set(bearer(o.token)).field('type', 'cac_certificate').attach('file', pdf(), 'cac.pdf');
    const sub = await api().post('/api/v1/verifications/cac').set(bearer(o.token)).send({ cac_number: 'RC1230000', certificate_document_id: cert.body.data.id });
    expect(sub.status).toBe(202);
    await flushVerifications();
    const res = await api().get(`/api/v1/verifications/cac/${sub.body.data.request_id}`).set(bearer(o.token));
    expect(res.body.data.status).toBe('verified');
    const org = await api().get('/api/v1/organizations/me').set(bearer(o.token));
    expect(org.body.data.cac_verification_status).toBe('verified');
  });

  it('refuses CAC verification for unregistered organizations', async () => {
    const o = await registerOrganization(false);
    const cert = await api().post('/api/v1/documents').set(bearer(o.token)).field('type', 'cac_certificate').attach('file', pdf(), 'cac.pdf');
    const res = await api().post('/api/v1/verifications/cac').set(bearer(o.token)).send({ cac_number: 'RC1234567', certificate_document_id: cert.body.data.id });
    expect(res.status).toBe(422);
  });

  it('blocks non-organization users from organization endpoints', async () => {
    const f = await registerFarmer();
    expect((await api().get('/api/v1/organizations/me').set(bearer(f.token))).status).toBe(403);
  });
});

describe('membership', () => {
  it('registers members (existing and new farmers), verifies, and shows them to the farmer', async () => {
    const o = await registerOrganization();
    const existing = await registerFarmer();
    const m1 = await api().post('/api/v1/organizations/me/members').set(bearer(o.token)).send({ farmer_agriksense_id: existing.agriksense_id, membership_id: 'MEM-001' });
    expect(m1.status).toBe(201);
    expect(m1.body.data.status).toBe('not_verified');
    const dup = await api().post('/api/v1/organizations/me/members').set(bearer(o.token)).send({ farmer_agriksense_id: existing.agriksense_id });
    expect(dup.status).toBe(409);

    const m2 = await api().post('/api/v1/organizations/me/members').set(bearer(o.token)).send({ farmer: { first_name: 'New', last_name: 'Member', phone: uniquePhone() } });
    expect(m2.status).toBe(201);
    expect(m2.body.data.membership_id).toMatch(/^AKM-\d{8}$/);
    expect(m2.body.data.is_generated_membership_id).toBe(true);
    expect(m2.body.data.farmer.agriksense_id).toMatch(/^\d{10}$/);

    const v = await api().post(`/api/v1/organizations/me/members/${m1.body.data.id}/verify`).set(bearer(o.token)).send({});
    expect(v.body.data.status).toBe('verified');

    const list = await api().get('/api/v1/organizations/me/members?status=verified').set(bearer(o.token));
    expect(list.body.meta.total).toBe(1);
    const detail = await api().get(`/api/v1/organizations/me/members/${m2.body.data.id}`).set(bearer(o.token));
    expect(detail.body.data.member_name).toBe('New Member');
    const renumber = await api().patch(`/api/v1/organizations/me/members/${m1.body.data.id}`).set(bearer(o.token)).send({ membership_id: 'MEM-002' });
    expect(renumber.body.data.status).toBe('not_verified'); // changed IDs require re-verification

    const mine = await api().get('/api/v1/farmers/me/memberships').set(bearer(existing.token));
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).toMatchObject({ membership_id: 'MEM-002', status: 'not_verified' });
    expect(mine.body.data[0].organization.agriksense_id).toBe(o.agriksense_id);

    // Other organizations cannot see this member
    const other = await registerOrganization();
    expect((await api().get(`/api/v1/organizations/me/members/${m1.body.data.id}`).set(bearer(other.token))).status).toBe(404);
  });
});

describe('bulk CSV import', () => {
  it('serves templates without password columns', async () => {
    const o = await registerOrganization();
    const res = await api().get('/api/v1/imports/templates/member').set(bearer(o.token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.trim()).toBe('membership_id,farmer_agriksense_id,first_name,last_name,other_name,phone,email,joined_at');
    for (const t of ['farmer', 'dco', 'organization']) {
      const tpl = await api().get(`/api/v1/imports/templates/${t}`).set(bearer(o.token));
      expect(tpl.text).not.toContain('password');
    }
  });

  it('validates rows (dry run), reports errors, and commits idempotently', async () => {
    const admin = await adminToken();
    const existing = await registerFarmer();
    const p1 = uniquePhone();
    const p2 = uniquePhone();
    const csv = [
      'first_name,last_name,phone,email,state,lga,city,address,nin',
      `Bola,Ade,${p1},,Lagos,Ikeja,Ikeja,1 Road,`,
      `Chi,Eze,${p2},${uniqueEmail('imp')},FC,Bwari,Kubwa,2 Road,12345678901`,
      `Dup,Phone,${p1},,Lagos,,,,`,
      `Old,User,${existing.phone},,,,,,`,
      `,Missing,${uniquePhone()},,Atlantis,,,,`,
    ].join('\n');

    const noKey = await api().post('/api/v1/imports').set(bearer(admin)).field('entity_type', 'farmer').attach('file', Buffer.from(csv), 'farmers.csv');
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const key = `import-${Date.now()}`;
    const job = await api().post('/api/v1/imports').set(bearer(admin)).set('Idempotency-Key', key).field('entity_type', 'farmer').attach('file', Buffer.from(csv), 'farmers.csv');
    expect(job.status).toBe(201);
    expect(job.body.data.counts).toEqual({ total: 5, valid: 2, invalid: 1, duplicate: 2, committed: 0 });
    expect(await prisma.user.count({ where: { phone: p1 } })).toBe(0); // dry run creates nothing

    const replay = await api().post('/api/v1/imports').set(bearer(admin)).set('Idempotency-Key', key).field('entity_type', 'farmer').attach('file', Buffer.from(csv), 'farmers.csv');
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.id).toBe(job.body.data.id);

    const detail = await api().get(`/api/v1/imports/${job.body.data.id}`).set(bearer(admin));
    expect(detail.body.data.row_errors).toHaveLength(3);
    const errorsCsv = await api().get(`/api/v1/imports/${job.body.data.id}/errors`).set(bearer(admin));
    expect(errorsCsv.text).toContain('duplicate of row 2 in this file');
    expect(errorsCsv.text).toContain('unknown state');
    expect(errorsCsv.text).not.toContain('12345678901');

    const commit = await api().post(`/api/v1/imports/${job.body.data.id}/commit`).set(bearer(admin)).set('Idempotency-Key', `${key}-commit`);
    expect(commit.status).toBe(200);
    expect(commit.body.data.status).toBe('committed');
    expect(commit.body.data.counts.committed).toBe(2);
    const again = await api().post(`/api/v1/imports/${job.body.data.id}/commit`).set(bearer(admin)).set('Idempotency-Key', `${key}-commit-2`);
    expect(again.body.data.counts.committed).toBe(2);
    expect(await prisma.user.count({ where: { phone: { in: [p1, p2] } } })).toBe(2);

    const imported = await prisma.user.findUniqueOrThrow({ where: { phone: p2 } });
    expect(imported.passwordHash).toBeNull();
    expect(imported.ninStatus).toBe('manual_review'); // imported NINs are never auto-verified
    expect(imported.onboardingStatus).not.toBe('complete');
  });

  it('lets organizations import members, and forbids them from importing farmers', async () => {
    const o = await registerOrganization();
    const forbidden = await api().post('/api/v1/imports').set(bearer(o.token)).set('Idempotency-Key', `forbid-${Date.now()}`).field('entity_type', 'farmer').attach('file', Buffer.from('first_name,last_name,phone\nA,B,+2348011111111'), 'f.csv');
    expect(forbidden.status).toBe(403);
    const existing = await registerFarmer();
    const csv = `membership_id,farmer_agriksense_id,first_name,last_name,phone\nM-1,${existing.agriksense_id},,,\nM-2,,Tunde,Bako,${uniquePhone()}\nM-1,,X,Y,${uniquePhone()}`;
    const job = await api().post('/api/v1/imports').set(bearer(o.token)).set('Idempotency-Key', `mem-${Date.now()}`).field('entity_type', 'member').attach('file', Buffer.from(csv), 'm.csv');
    expect(job.body.data.counts).toMatchObject({ valid: 2, duplicate: 1 });
    const commit = await api().post(`/api/v1/imports/${job.body.data.id}/commit`).set(bearer(o.token)).set('Idempotency-Key', `memc-${Date.now()}`);
    expect(commit.body.data.counts.committed).toBe(2);
    const members = await api().get('/api/v1/organizations/me/members').set(bearer(o.token));
    expect(members.body.meta.total).toBe(2);
  });
});
