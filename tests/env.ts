// Test environment — loaded before any application module.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/agriksense_test';
process.env.VERIFICATION_PROVIDER = 'mock';
process.env.AI_INFERENCE_MODE = 'mock';
process.env.AUTH_RATE_LIMIT = '10000';
process.env.STORAGE_DIR = process.env.TEST_STORAGE_DIR ?? './storage-test';
process.env.NOTIFICATION_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.SEED_ADMIN_EMAIL = 'admin@test.local';
process.env.SEED_ADMIN_PASSWORD = 'AdminPass123';
