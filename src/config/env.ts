import 'dotenv/config';
import crypto from 'crypto';

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';

function required(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isProduction) throw new Error(`Missing required environment variable ${name}`);
  return devFallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Dev-only fallback keys are derived deterministically so restarts keep data decryptable.
const devKey = (label: string) => crypto.createHash('sha256').update(`agriksense-dev-${label}`).digest('hex');

export const env = {
  nodeEnv,
  isProduction,
  isTest: nodeEnv === 'test',
  port: int('PORT', 4000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${int('PORT', 4000)}`,
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),

  jwtAccessSecret: required('JWT_ACCESS_SECRET', devKey('access')),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET', devKey('refresh')),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? '15m',
  refreshTokenTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 30),
  dataEncryptionKey: required('DATA_ENCRYPTION_KEY', devKey('data')),
  hashKey: required('HASH_KEY', devKey('hash')),
  fileUrlTtlSeconds: int('FILE_URL_TTL_SECONDS', 300),

  storageDir: process.env.STORAGE_DIR ?? './storage',
  maxUploadBytes: int('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),

  verificationProvider: process.env.VERIFICATION_PROVIDER ?? 'manual',
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',

  ai: {
    mode: process.env.AI_INFERENCE_MODE ?? 'http',
    predictPath: process.env.AI_PREDICT_PATH ?? '/predict',
    uploadField: process.env.AI_UPLOAD_FIELD ?? 'file',
    healthPath: process.env.AI_HEALTH_PATH ?? '/health',
    timeoutMs: int('AI_TIMEOUT_MS', 60000),
    /** "unit" (0–1) or "percent" (0–100) — the confidence scale the model services return. */
    confidenceScale: process.env.AI_CONFIDENCE_SCALE === 'percent' ? 'percent' : 'unit',
    serviceUrls: {
      rice: process.env.AI_RICE_URL ?? 'https://rice-disease-api-vzxa.onrender.com',
      maize: process.env.AI_MAIZE_URL ?? 'https://maize-disease-api.onrender.com',
      tomato: process.env.AI_TOMATO_URL ?? 'https://tomato-disease-api-w8if.onrender.com',
    } as Record<string, string>,
  },

  fareRoadFactor: Number(process.env.FARE_ROAD_FACTOR ?? '1.3') || 1.3,

  notificationProvider: process.env.NOTIFICATION_PROVIDER ?? 'log',
  notificationWebhookSecret: process.env.NOTIFICATION_WEBHOOK_SECRET ?? '',
};

if (!/^[0-9a-f]{64}$/i.test(env.dataEncryptionKey)) {
  throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters');
}
