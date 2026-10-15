import fs from 'fs/promises';
import path from 'path';
import { Router } from 'express';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { asyncHandler } from '../lib/http';

const router = Router();

// GET /health/live
router.get('/live', (_req, res) => {
  res.status(200).json({ data: { status: 'ok', uptime_seconds: Math.round(process.uptime()) }, request_id: res.locals.requestId });
});

// GET /health/ready — database and storage
router.get(
  '/ready',
  asyncHandler(async (_req, res) => {
    const checks: Record<string, { status: 'ok' | 'fail'; latency_ms?: number; error?: string }> = {};
    let started = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = { status: 'ok', latency_ms: Date.now() - started };
    } catch (err) {
      checks.database = { status: 'fail', error: (err as Error).message.split('\n')[0] };
    }
    started = Date.now();
    try {
      const dir = path.resolve(env.storageDir);
      await fs.mkdir(dir, { recursive: true });
      await fs.access(dir, fs.constants.W_OK);
      checks.storage = { status: 'ok', latency_ms: Date.now() - started };
    } catch (err) {
      checks.storage = { status: 'fail', error: (err as Error).message };
    }
    const ready = Object.values(checks).every((c) => c.status === 'ok');
    res.status(ready ? 200 : 503).json({ data: { status: ready ? 'ready' : 'not_ready', checks }, request_id: res.locals.requestId });
  }),
);

export default router;
