import { beforeAll, describe, expect, it } from 'vitest';
import { adminToken, api, bearer, pdf, png, registerFarmer } from './helpers';
import { normalizeDetections } from '../src/services/inference.service';

const CLASSES = ['healthy', 'early_blight', 'late_blight', 'leaf_mold'];
let admin: string;
let farmer: Awaited<ReturnType<typeof registerFarmer>>;

beforeAll(async () => {
  admin = await adminToken();
  farmer = await registerFarmer();
});

describe('model governance', () => {
  it('has no active model until a version is approved and activated', async () => {
    const models = await api().get('/api/v1/ai/models').set(bearer(farmer.token));
    expect(models.body.data.map((m: { crop: string }) => m.crop).sort()).toEqual(['maize', 'rice', 'tomato']);
    const tomato = models.body.data.find((m: { crop: string }) => m.crop === 'tomato');
    expect(tomato.active_version).toBeNull();
    expect(tomato.versions[0].status).toBe('registered');
    const res = await api().post('/api/v1/ai/predictions').set(bearer(farmer.token)).field('crop', 'tomato').attach('file', png(), 'leaf.png');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('MODEL_NOT_ACTIVE');
  });

  it('requires QA metrics and a class map to approve, and approval before activation', async () => {
    expect((await api().post('/api/v1/admin/ai/models/tomato/approve').set(bearer(farmer.token)).send({ version: 'qa-1', classes: CLASSES, metrics: { map50: 0.8 } })).status).toBe(403);
    const noClasses = await api().post('/api/v1/admin/ai/models/tomato/approve').set(bearer(admin)).send({ version: 'qa-1', metrics: { map50: 0.8 } });
    expect(noClasses.status).toBe(422);
    const notApproved = await api().post('/api/v1/admin/ai/models/tomato/activate').set(bearer(admin)).send({ version: 'qa-1' });
    expect(notApproved.status).toBe(409);
    const approve = await api().post('/api/v1/admin/ai/models/tomato/approve').set(bearer(admin)).send({ version: 'qa-1', classes: CLASSES, metrics: { map50: 0.81, precision: 0.84 }, notes: 'QA sign-off' });
    expect(approve.status).toBe(200);
    expect(approve.body.data.status).toBe('approved');
    const activate = await api().post('/api/v1/admin/ai/models/tomato/activate').set(bearer(admin)).send({ version: 'qa-1' });
    expect(activate.body.data.status).toBe('active');
    const classes = await api().get('/api/v1/ai/models/tomato/classes').set(bearer(farmer.token));
    expect(classes.body.data.classes[1]).toEqual({ class_id: 1, class_name: 'early_blight' });
    const status = await api().get('/api/v1/ai/models/tomato/status').set(bearer(farmer.token));
    expect(status.body.data).toMatchObject({ ready: true, active_version: 'qa-1' });
  });

  it('runs inference, returns boxes within image bounds and the model version, and accepts feedback', async () => {
    const res = await api().post('/api/v1/ai/predictions').set(bearer(farmer.token)).field('crop', 'tomato').attach('file', png(200, 100, 7), 'leaf.png');
    expect(res.status).toBe(200);
    const p = res.body.data;
    expect(p.model_version).toBe('qa-1');
    expect(p.detections.length).toBeGreaterThan(0);
    for (const d of p.detections) {
      expect(CLASSES[d.class_id]).toBe(d.class_name);
      expect(d.confidence).toBeGreaterThanOrEqual(0);
      expect(d.confidence).toBeLessThanOrEqual(1);
      const [x1, y1, x2, y2] = d.box_xyxy;
      expect(x1).toBeGreaterThanOrEqual(0);
      expect(y1).toBeGreaterThanOrEqual(0);
      expect(x2).toBeLessThanOrEqual(200);
      expect(y2).toBeLessThanOrEqual(100);
    }
    const got = await api().get(`/api/v1/ai/predictions/${p.prediction_id}`).set(bearer(farmer.token));
    expect(got.body.data.image).toEqual({ width: 200, height: 100 });
    const other = await registerFarmer();
    expect((await api().get(`/api/v1/ai/predictions/${p.prediction_id}`).set(bearer(other.token))).status).toBe(404);
    const history = await api().get('/api/v1/ai/predictions?crop=tomato').set(bearer(farmer.token));
    expect(history.body.meta.total).toBe(1);

    const badFb = await api().post(`/api/v1/ai/predictions/${p.prediction_id}/feedback`).set(bearer(farmer.token)).send({ is_correct: false, corrected_class_name: 'unicorn' });
    expect(badFb.status).toBe(422);
    const fb = await api().post(`/api/v1/ai/predictions/${p.prediction_id}/feedback`).set(bearer(farmer.token)).send({ is_correct: false, corrected_class_name: 'late_blight', detection_index: 0 });
    expect(fb.status).toBe(201);
    expect(fb.body.data.is_verified).toBe(false);
    const verified = await api().post(`/api/v1/ai/predictions/${p.prediction_id}/feedback`).set(bearer(admin)).send({ is_correct: false, corrected_class_name: 'late_blight' });
    expect(verified.body.data.is_verified).toBe(true);
  });

  it('validates crop selection, actual image content and dimensions', async () => {
    expect((await api().post('/api/v1/ai/predictions').set(bearer(farmer.token)).field('crop', 'cassava').attach('file', png(), 'x.png')).status).toBe(422);
    expect((await api().post('/api/v1/ai/predictions').set(bearer(farmer.token)).field('crop', 'tomato').attach('file', pdf(), { filename: 'x.png', contentType: 'image/png' })).status).toBe(415);
    const corrupt = Buffer.concat([png().subarray(0, 8), Buffer.from('garbage-not-ihdr')]);
    expect((await api().post('/api/v1/ai/predictions').set(bearer(farmer.token)).field('crop', 'tomato').attach('file', corrupt, 'x.png')).status).toBe(415);
    expect((await api().post('/api/v1/ai/predictions').set(bearer(farmer.token)).field('crop', 'tomato').attach('file', png(8, 8), 'x.png')).status).toBe(422);
    expect((await api().post('/api/v1/ai/predictions').set(bearer(farmer.token)).field('crop', 'tomato')).status).toBe(422);
  });

  it('rolls back to the previous approved version and lists evaluations', async () => {
    await api().post('/api/v1/admin/ai/models/tomato/approve').set(bearer(admin)).send({ version: 'qa-2', classes: CLASSES, metrics: { map50: 0.83 } });
    await api().post('/api/v1/admin/ai/models/tomato/activate').set(bearer(admin)).send({ version: 'qa-2' });
    const rb = await api().post('/api/v1/admin/ai/models/tomato/rollback').set(bearer(admin)).send({ reason: 'regression in field' });
    expect(rb.status).toBe(200);
    expect(rb.body.data).toMatchObject({ version: 'qa-1', status: 'active', rolled_back_from: 'qa-2' });
    const models = await api().get('/api/v1/ai/models').set(bearer(admin));
    const tomato = models.body.data.find((m: { crop: string }) => m.crop === 'tomato');
    expect(tomato.versions.find((v: { version: string }) => v.version === 'qa-2').status).toBe('retired');
    const evals = await api().get('/api/v1/admin/ai/model-evaluations?crop=tomato').set(bearer(admin));
    expect(evals.body.meta.total).toBe(2);
    expect(evals.body.meta.field_feedback.incorrect).toBe(2);
  });
});

describe('detection normalisation', () => {
  it('uses the approved class map, clips boxes, and drops invalid detections', () => {
    const out = normalizeDetections(
      {
        predictions: [
          { class_id: 2, class_name: 'WRONG NAME', confidence: 0.9, bbox: [-10, 5, 250, 90] },
          { class: 'leaf_mold', score: 0.87, box: { xmin: 10, ymin: 10, xmax: 20, ymax: 20 } },
          { class_id: 9, confidence: 0.5, bbox: [0, 0, 1, 1] },
          { class_id: 1, confidence: 1.7, bbox: [0, 0, 1, 1] },
          { class_id: 0, confidence: 0.4, bbox: [300, 300, 400, 400] },
        ],
      },
      CLASSES,
      200,
      100,
    );
    expect(out.detections).toEqual([
      { class_id: 2, class_name: 'late_blight', confidence: 0.9, box_xyxy: [0, 5, 200, 90] },
      { class_id: 3, class_name: 'leaf_mold', confidence: 0.87, box_xyxy: [10, 10, 20, 20] },
    ]);
    expect(out.dropped.map((d) => d.reason)).toEqual(['class not in approved class map', 'invalid confidence', 'box outside image bounds or empty']);
  });

  it('handles empty and classification-only responses', () => {
    expect(normalizeDetections({ detections: [] }, CLASSES, 10, 10).detections).toEqual([]);
    expect(normalizeDetections({ class: 'healthy', confidence: 0.99 }, CLASSES, 10, 10).detections).toEqual([{ class_id: 0, class_name: 'healthy', confidence: 0.99, box_xyxy: null }]);
  });
});
