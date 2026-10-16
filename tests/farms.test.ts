import { beforeAll, describe, expect, it } from 'vitest';
import { adminToken, api, bearer, png, registerDco, registerFarmer, registerOrganization, stateAndLga } from './helpers';

let admin: string;
let farmer: Awaited<ReturnType<typeof registerFarmer>>;
let dco: Awaited<ReturnType<typeof registerDco>>;
let fct: { stateId: number; lgaId: number };
let farmId: string;
let farm2Id: string;

beforeAll(async () => {
  admin = await adminToken();
  farmer = await registerFarmer();
  dco = await registerDco();
  fct = await stateAndLga('FC', 'Gwagwalada');
});

describe('farms', () => {
  it('lets a farmer create and list their farms', async () => {
    const res = await api()
      .post('/api/v1/farms')
      .set(bearer(farmer.token))
      .send({ name: 'Green Acres', address: 'Km 3 Dobi Road', landmark: 'Near the river', village: 'Dobi', city: 'Gwagwalada', state_id: fct.stateId, lga_id: fct.lgaId, latitude: 8.95, longitude: 7.08 });
    expect(res.status).toBe(201);
    expect(res.body.data.owner.agriksense_id).toBe(farmer.agriksense_id);
    farmId = res.body.data.id;
    const second = await api()
      .post('/api/v1/farms')
      .set(bearer(farmer.token))
      .send({ name: 'River Plot', address: 'Paikon Kore', city: 'Gwagwalada', state_id: fct.stateId, lga_id: fct.lgaId, latitude: 8.9, longitude: 7.0 });
    farm2Id = second.body.data.id;
    const mine = await api().get('/api/v1/farmers/me/farms').set(bearer(farmer.token));
    expect(mine.body.meta.total).toBe(2);
  });

  it('hides farms from unrelated users and lets admins search all', async () => {
    const other = await registerFarmer();
    expect((await api().get(`/api/v1/farms/${farmId}`).set(bearer(other.token))).status).toBe(404);
    expect((await api().get(`/api/v1/farms/${farmId}`).set(bearer(dco.token))).status).toBe(404);
    expect((await api().patch(`/api/v1/farms/${farmId}`).set(bearer(other.token)).send({ name: 'Mine now' })).status).toBe(404);
    const search = await api().get(`/api/v1/farms?state_id=${fct.stateId}&search=green`).set(bearer(admin));
    expect(search.body.data.some((f: { id: string }) => f.id === farmId)).toBe(true);
    const otherList = await api().get('/api/v1/farms').set(bearer(other.token));
    expect(otherList.body.meta.total).toBe(0);
  });

  it('allows owners to update farm details but not ownership', async () => {
    const upd = await api().patch(`/api/v1/farms/${farmId}`).set(bearer(farmer.token)).send({ landmark: 'By the big baobab' });
    expect(upd.body.data.landmark).toBe('By the big baobab');
    expect((await api().patch(`/api/v1/farms/${farmId}`).set(bearer(farmer.token)).send({ owner_id: null })).status).toBe(403);
  });
});

describe('DCO visit requests, fares and assignment', () => {
  let requestId: string;
  let assignmentId: string;

  it('accepts known-farm and geographic-preference requests', async () => {
    const known = await api()
      .post('/api/v1/dco/visit-requests')
      .set(bearer(dco.token))
      .send({ mode: 'known_farms', known_farms: [{ name: 'Farm A', address: 'Somewhere', estimated_round_trip_fare_kobo: 350000 }] });
    expect(known.status).toBe(201);
    expect(known.body.data.status).toBe('pending_assignment');
    const geo = await api().post('/api/v1/dco/visit-requests').set(bearer(dco.token)).send({ mode: 'geographic_preference', preferred_state_id: fct.stateId, preferred_lga_id: fct.lgaId, max_farms: 2 });
    expect(geo.status).toBe(201);
    requestId = geo.body.data.id;
    const mine = await api().get('/api/v1/dco/visit-requests').set(bearer(dco.token));
    expect(mine.body.meta.total).toBe(2);
    expect((await api().post('/api/v1/dco/visit-requests').set(bearer(farmer.token)).send({ mode: 'geographic_preference', preferred_state_id: fct.stateId })).status).toBe(403);
  });

  it('shows the admin report with DCO residence and availability', async () => {
    const list = await api().get('/api/v1/admin/visit-requests?status=pending_assignment').set(bearer(admin));
    expect(list.body.data.some((r: { id: string }) => r.id === requestId)).toBe(true);
    const detail = await api().get(`/api/v1/admin/visit-requests/${requestId}`).set(bearer(admin));
    expect(detail.body.data.dco_profile.agriksense_id).toBe(dco.agriksense_id);
    expect(detail.body.data.dco_profile).toHaveProperty('residence');
    expect((await api().get('/api/v1/admin/visit-requests').set(bearer(dco.token))).status).toBe(403);
  });

  it('sets per-state fare rates as decimal naira per mile', async () => {
    const put = await api().put(`/api/v1/admin/fare-rates/${fct.stateId}`).set(bearer(admin)).send({ naira_per_mile: '250.00' });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ state_id: fct.stateId, naira_per_mile: '250.00', kobo_per_mile: 25000 });
    const future = await api().put(`/api/v1/admin/fare-rates/${fct.stateId}`).set(bearer(admin)).send({ naira_per_mile: '300.50', effective_from: '2099-01-01' });
    expect(future.status).toBe(200);
    const rates = await api().get('/api/v1/admin/fare-rates').set(bearer(admin));
    const row = rates.body.data.find((r: { state: { id: number } }) => r.state.id === fct.stateId);
    expect(row.current.naira_per_mile).toBe('250.00');
    expect(row.scheduled[0].naira_per_mile).toBe('300.50');
    expect((await api().put(`/api/v1/admin/fare-rates/${fct.stateId}`).set(bearer(admin)).send({ naira_per_mile: '25' + '0.001' })).status).toBe(422);
  });

  it('estimates individual round-trip and grouped fares with explicit assumptions', async () => {
    const res = await api()
      .post('/api/v1/farm-visits/fare-estimates')
      .set(bearer(admin))
      .send({ state_id: fct.stateId, origin: { latitude: 9.0, longitude: 7.1 }, farms: [{ farm_id: farmId }, { farm_id: farm2Id }] });
    expect(res.status).toBe(200);
    expect(res.body.data.assumptions.distance_unit).toBe('mile');
    expect(res.body.data.per_farm).toHaveLength(2);
    for (const p of res.body.data.per_farm) {
      expect(Number.isInteger(p.fare_kobo)).toBe(true);
      expect(p.fare_kobo).toBe(Math.round(p.round_trip_miles * 25000));
    }
    expect(res.body.data.grouped.fare_kobo).toBeLessThanOrEqual(res.body.data.individual_total_kobo);
    const noRate = await api().post('/api/v1/farm-visits/fare-estimates').set(bearer(admin)).send({ state_id: 1, origin: { latitude: 9, longitude: 7 }, farms: [{ latitude: 9.1, longitude: 7.1 }] });
    expect(noRate.status).toBe(422);
    expect(noRate.body.error.code).toBe('FARE_RATE_NOT_SET');
  });

  it('enforces the DCO geographic preference and admin authorization', async () => {
    const { stateId, lgaId } = await stateAndLga('LA', 'Ikeja');
    const lagosFarm = await api().post('/api/v1/farms').set(bearer(admin)).send({ name: 'Lagos Plot', address: 'Ikeja', city: 'Ikeja', state_id: stateId, lga_id: lgaId, owner_id: farmer.user_id });
    expect(lagosFarm.status).toBe(201);
    const body = { dco_id: dco.user_id, farm_ids: [lagosFarm.body.data.id], visit_request_id: requestId };
    const wrong = await api().post('/api/v1/admin/farm-assignments').set(bearer(admin)).set('Idempotency-Key', `assign-wrong-${Date.now()}`).send(body);
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('ASSIGNMENT_INVALID');
    const notAdmin = await api().post('/api/v1/admin/farm-assignments').set(bearer(dco.token)).set('Idempotency-Key', `assign-dco-${Date.now()}`).send(body);
    expect(notAdmin.status).toBe(403);
    const toFarmer = await api().post('/api/v1/admin/farm-assignments').set(bearer(admin)).set('Idempotency-Key', `assign-farmer-${Date.now()}`).send({ ...body, dco_id: farmer.user_id });
    expect(toFarmer.status).toBe(422);
  });

  it('assigns farms with a computed fare, idempotently', async () => {
    const key = `assign-${Date.now()}`;
    const body = { dco_id: dco.user_id, farm_ids: [farmId], visit_request_id: requestId, origin: { latitude: 9.0, longitude: 7.1 } };
    const res = await api().post('/api/v1/admin/farm-assignments').set(bearer(admin)).set('Idempotency-Key', key).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data[0].fare.distance_unit).toBe('mile');
    expect(res.body.data[0].fare.amount_kobo).toBeGreaterThan(0);
    assignmentId = res.body.data[0].id;
    const replay = await api().post('/api/v1/admin/farm-assignments').set(bearer(admin)).set('Idempotency-Key', key).send(body);
    expect(replay.status).toBe(201);
    expect(replay.body.data[0].id).toBe(assignmentId);
    const reuse = await api().post('/api/v1/admin/farm-assignments').set(bearer(admin)).set('Idempotency-Key', key).send({ ...body, farm_ids: [farm2Id] });
    expect(reuse.status).toBe(422);
    const dupe = await api().post('/api/v1/admin/farm-assignments').set(bearer(admin)).set('Idempotency-Key', `${key}-b`).send(body);
    expect(dupe.status).toBe(409);
    const detail = await api().get(`/api/v1/admin/visit-requests/${requestId}`).set(bearer(admin));
    expect(detail.body.data.status).toBe('partially_assigned');
  });

  it('runs the visit lifecycle with data capture', async () => {
    const mine = await api().get('/api/v1/dco/farm-assignments?status=assigned').set(bearer(dco.token));
    expect(mine.body.data.map((a: { id: string }) => a.id)).toContain(assignmentId);
    // DCO can now read the assigned farm
    expect((await api().get(`/api/v1/farms/${farmId}`).set(bearer(dco.token))).status).toBe(200);

    const early = await api().post('/api/v1/farm-visits').set(bearer(dco.token)).send({ assignment_id: assignmentId });
    expect(early.status, JSON.stringify(early.body)).toBe(409); // must accept first
    expect((await api().patch(`/api/v1/farm-assignments/${assignmentId}/status`).set(bearer(dco.token)).send({ status: 'accepted' })).status).toBe(200);
    const visit = await api().post('/api/v1/farm-visits').set(bearer(dco.token)).send({ assignment_id: assignmentId, check_in: { latitude: 8.95, longitude: 7.08 } });
    expect(visit.status).toBe(201);
    const visitId = visit.body.data.id;

    const crop = await api().post(`/api/v1/farms/${farmId}/crops`).set(bearer(dco.token)).send({ crop_type: 'Rice', variety: 'FARO 44', planting_date: '2026-06-01', area_planted: 1.5, area_unit: 'hectare', visit_id: visitId });
    expect(crop.status).toBe(201);
    expect(crop.body.data.crop_type).toBe('rice');
    const cropUpd = await api().patch(`/api/v1/crops/${crop.body.data.id}`).set(bearer(dco.token)).send({ growth_stage: 'tillering' });
    expect(cropUpd.body.data.growth_stage).toBe('tillering');

    const land = await api().post(`/api/v1/farms/${farmId}/farmland`).set(bearer(dco.token)).send({ area: 5, area_unit: 'acre', soil_type: 'loam', measurement_method: 'gps_walk', visit_id: visitId });
    expect(land.status).toBe(201);
    expect(land.body.data.area_hectares).toBeCloseTo(2.0234, 3);
    const landRead = await api().get(`/api/v1/farms/${farmId}/farmland`).set(bearer(farmer.token));
    expect(landRead.body.data.metrics.planted_hectares).toBe(1.5);

    const evidence = await api().post('/api/v1/documents').set(bearer(dco.token)).field('type', 'observation_evidence').attach('file', png(), 'leaf.png');
    const obs = await api()
      .post(`/api/v1/farms/${farmId}/observations`)
      .set(bearer(dco.token))
      .send({ type: 'disease', name: 'Rice blast', crop_type: 'rice', severity: 'medium', affected_area_percent: 12.5, evidence_document_ids: [evidence.body.data.id], crop_record_id: crop.body.data.id, visit_id: visitId });
    expect(obs.status).toBe(201);
    const annotate = await api().patch(`/api/v1/observations/${obs.body.data.id}`).set(bearer(dco.token)).send({ annotation: 'Lesions on upper leaves' });
    expect(annotate.body.data.annotations).toHaveLength(1);
    expect((await api().get(`/api/v1/observations/${obs.body.data.id}`).set(bearer(farmer.token))).status).toBe(200);
    // Farm owner can view the evidence image through the observation
    expect((await api().get(`/api/v1/documents/${evidence.body.data.id}/access`).set(bearer(farmer.token))).status).toBe(200);

    expect((await api().patch(`/api/v1/farm-assignments/${assignmentId}/status`).set(bearer(dco.token)).send({ status: 'completed' })).status).toBe(409);
    const end = await api().patch(`/api/v1/farm-visits/${visitId}`).set(bearer(dco.token)).send({ status: 'completed', notes: 'All good' });
    expect(end.body.data.status).toBe('completed');
    const vRead = await api().get(`/api/v1/farm-visits/${visitId}`).set(bearer(dco.token));
    expect(vRead.body.data.data_collection).toEqual({ crop_records: 1, farmland_measurements: 1, observations: 1 });
    const done = await api().patch(`/api/v1/farm-assignments/${assignmentId}/status`).set(bearer(dco.token)).send({ status: 'completed' });
    expect(done.body.data.status).toBe('completed');
    const a = await api().get(`/api/v1/farm-assignments/${assignmentId}`).set(bearer(admin));
    expect(a.body.data.visits).toHaveLength(1);
  });

  it('blocks data collection after the farmer withdraws consent', async () => {
    const assign = await api().post('/api/v1/admin/farm-assignments').set(bearer(admin)).set('Idempotency-Key', `assign2-${Date.now()}`).send({ dco_id: dco.user_id, farm_ids: [farm2Id] });
    expect(assign.status).toBe(201);
    const consents = await api().get('/api/v1/consents/me').set(bearer(farmer.token));
    const c = consents.body.data.history.find((x: { scope: string; status: string }) => x.scope === 'farm_data_collection' && x.status === 'accepted');
    await api().post(`/api/v1/consents/${c.id}/withdraw`).set(bearer(farmer.token)).send({});
    const blocked = await api().post(`/api/v1/farms/${farm2Id}/crops`).set(bearer(dco.token)).send({ crop_type: 'maize' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('CONSENT_REQUIRED');
    // Reading previously collected data is still allowed
    expect((await api().get(`/api/v1/farms/${farm2Id}/crops`).set(bearer(dco.token))).status).toBe(200);
    // DCO declines; reason required
    expect((await api().patch(`/api/v1/farm-assignments/${assign.body.data[0].id}/status`).set(bearer(dco.token)).send({ status: 'cancelled' })).status).toBe(422);
    expect((await api().patch(`/api/v1/farm-assignments/${assign.body.data[0].id}/status`).set(bearer(dco.token)).send({ status: 'cancelled', reason: 'No consent' })).status).toBe(200);
    await api().post('/api/v1/consents').set(bearer(farmer.token)).send({ version: 'v1', scope: 'farm_data_collection', decision: 'accepted' });
  });
});

describe('reports and dashboards', () => {
  it('returns scoped report rows without sensitive fields', async () => {
    const crops = await api().get(`/api/v1/reports/crops?state_id=${fct.stateId}&crop=rice`).set(bearer(admin));
    expect(crops.status).toBe(200);
    expect(crops.body.meta.total).toBeGreaterThanOrEqual(1);
    const row = crops.body.data[0];
    expect(row).toMatchObject({ crop_type: 'rice', state: 'Federal Capital Territory' });
    expect(JSON.stringify(crops.body)).not.toMatch(/phone|nin|account_number/);

    const farmerView = await api().get('/api/v1/reports/diseases-pests').set(bearer(farmer.token));
    expect(farmerView.body.meta.total).toBe(1);
    const stranger = await registerFarmer();
    expect((await api().get('/api/v1/reports/diseases-pests').set(bearer(stranger.token))).body.meta.total).toBe(0);

    for (const t of ['farmland', 'farm-visits']) {
      const r = await api().get(`/api/v1/reports/${t}?date_from=2020-01-01&date_to=2099-12-31`).set(bearer(admin));
      expect(r.status).toBe(200);
      expect(r.body.meta.total).toBeGreaterThanOrEqual(1);
    }
  });

  it('aggregates bar and pie charts and exports CSV', async () => {
    const charts = await api().get('/api/v1/reports/crops/charts').set(bearer(admin));
    expect(charts.body.data.bar.data.length).toBeGreaterThan(0);
    expect(charts.body.data.pie.data.find((d: { label: string }) => d.label === 'rice')).toBeTruthy();
    const csv = await api().get('/api/v1/reports/diseases-pests/export').set(bearer(admin));
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toContain('farm_name');
    expect((await api().get('/api/v1/reports/unknown/charts').set(bearer(admin))).status).toBe(422);
  });

  it('returns role-specific dashboards', async () => {
    const f = await api().get('/api/v1/dashboard/me').set(bearer(farmer.token));
    expect(f.body.data).toMatchObject({ role: 'farmer', farms: 3 });
    const d = await api().get('/api/v1/dashboard/me').set(bearer(dco.token));
    expect(d.body.data.assignments.completed).toBe(1);
    const o = await registerOrganization();
    expect((await api().get('/api/v1/dashboard/me').set(bearer(o.token))).body.data.role).toBe('organization_admin');
    const a = await api().get('/api/v1/admin/dashboard').set(bearer(admin));
    expect(a.body.data.users_by_role.farmer).toBeGreaterThan(0);
    expect((await api().get('/api/v1/admin/dashboard').set(bearer(farmer.token))).status).toBe(403);
  });
});
