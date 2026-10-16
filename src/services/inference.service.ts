import type { AiModelVersion } from '@prisma/client';
import { env } from '../config/env';
import { sha256 } from '../lib/crypto';

export interface Detection {
  class_id: number;
  class_name: string;
  confidence: number;
  box_xyxy: [number, number, number, number] | null;
}

export interface InferenceOutput {
  detections: Detection[];
  dropped: { reason: string; raw: unknown }[];
  latency_ms: number;
}

export class InferenceError extends Error {}

type Raw = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Extract the detection list from the shapes inference services commonly return. */
function extractList(body: unknown): Raw[] {
  if (Array.isArray(body)) return body as Raw[];
  if (!body || typeof body !== 'object') return [];
  const b = body as Raw;
  for (const key of ['detections', 'predictions', 'results', 'boxes', 'objects']) {
    if (Array.isArray(b[key])) return b[key] as Raw[];
  }
  if (b.data && typeof b.data === 'object') return extractList(b.data);
  // Single classification result, e.g. {"class": "...", "confidence": 0.9}
  if (('class' in b || 'class_name' in b || 'label' in b || 'prediction' in b) && ('confidence' in b || 'score' in b)) return [b];
  return [];
}

function extractBox(d: Raw): [number, number, number, number] | null {
  const arr = (d.box_xyxy ?? d.xyxy ?? d.bbox ?? d.box) as unknown;
  if (Array.isArray(arr) && arr.length === 4 && arr.every((v) => num(v) !== null)) return arr.map((v) => num(v)!) as [number, number, number, number];
  if (arr && typeof arr === 'object') {
    const o = arr as Raw;
    const x1 = num(o.x1 ?? o.xmin), y1 = num(o.y1 ?? o.ymin), x2 = num(o.x2 ?? o.xmax), y2 = num(o.y2 ?? o.ymax);
    if ([x1, y1, x2, y2].every((v) => v !== null)) return [x1!, y1!, x2!, y2!];
  }
  return null;
}

/**
 * Normalise raw service output against the *approved* class map: class names always come from
 * the approved ordered list (index == class_id); unknown ids, bad confidences and empty/invalid
 * boxes are dropped and reported. Boxes are clipped to the decoded image bounds.
 */
export function normalizeDetections(body: unknown, classes: string[], width: number, height: number) {
  const detections: Detection[] = [];
  const dropped: { reason: string; raw: unknown }[] = [];
  for (const d of extractList(body)) {
    let classId = num(d.class_id ?? d.cls ?? d.label_id ?? d.class_index);
    const rawName = (d.class_name ?? d.name ?? d.label ?? d.prediction ?? (typeof d.class === 'string' ? d.class : undefined)) as string | undefined;
    if (classId === null && typeof d.class === 'number') classId = d.class;
    if (classId === null && rawName) {
      const idx = classes.findIndex((c) => c.toLowerCase() === String(rawName).toLowerCase());
      classId = idx >= 0 ? idx : null;
    }
    if (classId === null || !Number.isInteger(classId) || classId < 0 || classId >= classes.length) {
      dropped.push({ reason: 'class not in approved class map', raw: d });
      continue;
    }
    let confidence = num(d.confidence ?? d.score ?? d.conf ?? d.probability);
    // Services must declare their scale; values are never guessed to be percentages.
    if (confidence !== null && env.ai.confidenceScale === 'percent') confidence = confidence / 100;
    if (confidence === null || confidence < 0 || confidence > 1) {
      dropped.push({ reason: 'invalid confidence', raw: d });
      continue;
    }
    let box = extractBox(d);
    if (box) {
      const [x1, y1, x2, y2] = box;
      box = [Math.max(0, Math.min(x1, width)), Math.max(0, Math.min(y1, height)), Math.max(0, Math.min(x2, width)), Math.max(0, Math.min(y2, height))];
      if (box[2] <= box[0] || box[3] <= box[1]) {
        dropped.push({ reason: 'box outside image bounds or empty', raw: d });
        continue;
      }
      box = box.map((v) => Math.round(v * 100) / 100) as [number, number, number, number];
    }
    detections.push({ class_id: classId, class_name: classes[classId], confidence: Math.round(confidence * 10000) / 10000, box_xyxy: box });
  }
  detections.sort((a, b) => b.confidence - a.confidence);
  return { detections, dropped };
}

export const inferenceClient = {
  async predict(model: AiModelVersion, image: Buffer, mime: string, width: number, height: number): Promise<InferenceOutput> {
    const started = Date.now();
    if (env.ai.mode === 'mock') {
      if (env.isProduction) throw new InferenceError('Mock inference is disabled in production');
      // Deterministic pseudo-detection derived from the image hash.
      const h = parseInt(sha256(image).slice(0, 8), 16);
      const classId = model.classes.length ? h % model.classes.length : 0;
      const raw = { detections: [{ class_id: classId, confidence: 0.5 + (h % 50) / 100, box_xyxy: [width * 0.1, height * 0.1, width * 0.8, height * 0.9] }] };
      return { ...normalizeDetections(raw, model.classes, width, height), latency_ms: Date.now() - started };
    }
    const form = new FormData();
    form.append(env.ai.uploadField, new Blob([image], { type: mime }), `upload.${mime.split('/')[1]}`);
    let resp: Response;
    try {
      resp = await fetch(new URL(env.ai.predictPath, model.serviceUrl), { method: 'POST', body: form, signal: AbortSignal.timeout(env.ai.timeoutMs) });
    } catch (err) {
      throw new InferenceError(`Inference service unreachable: ${(err as Error).message}`);
    }
    if (!resp.ok) throw new InferenceError(`Inference service returned HTTP ${resp.status}`);
    const body = await resp.json().catch(() => {
      throw new InferenceError('Inference service returned a non-JSON response');
    });
    return { ...normalizeDetections(body, model.classes, width, height), latency_ms: Date.now() - started };
  },

  async health(serviceUrl: string): Promise<{ ready: boolean; latency_ms: number; error?: string }> {
    const started = Date.now();
    if (env.ai.mode === 'mock') return { ready: true, latency_ms: 0 };
    try {
      const resp = await fetch(new URL(env.ai.healthPath, serviceUrl), { signal: AbortSignal.timeout(10_000) });
      return { ready: resp.ok, latency_ms: Date.now() - started, ...(resp.ok ? {} : { error: `HTTP ${resp.status}` }) };
    } catch (err) {
      return { ready: false, latency_ms: Date.now() - started, error: (err as Error).message };
    }
  },
};
