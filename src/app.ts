import express from 'express';
import type { Request } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env';
import { requestId } from './middleware/request-id';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { logger } from './lib/logger';
import { buildOpenApi } from './openapi';

import authRoutes from './modules/auth.routes';
import consentRoutes from './modules/consents.routes';
import userRoutes from './modules/users.routes';
import { verificationsRouter, adminVerificationsRouter } from './modules/verifications.routes';
import { documentsRouter, filesRouter } from './modules/documents.routes';
import locationRoutes from './modules/locations.routes';
import { bankAccountsRouter, banksRouter } from './modules/bank.routes';
import { organizationsRouter, farmerMembershipsRouter } from './modules/organizations.routes';
import importRoutes from './modules/imports.routes';
import { farmsRouter, farmerFarmsRouter } from './modules/farms.routes';
import { dcoRouter, adminVisitsRouter, assignmentsRouter, farmVisitsRouter } from './modules/visits.routes';
import { farmRecordsRouter, cropsRouter, observationsRouter } from './modules/records.routes';
import { aiRouter, adminAiRouter } from './modules/ai.routes';
import adminRoutes from './modules/admin.routes';
import reportRoutes from './modules/reports.routes';
import { dashboardRouter, adminDashboardRouter } from './modules/dashboard.routes';
import { notificationsRouter, webhooksRouter } from './modules/notifications.routes';
import healthRoutes from './modules/health.routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins.length ? env.corsOrigins : !env.isProduction,
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed', 'Retry-After'],
    }),
  );
  app.use(
    express.json({
      limit: '1mb',
      // Keep the raw body for webhook signature verification.
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      logger.info('request', {
        request_id: req.requestId,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        duration_ms: Date.now() - started,
        user_id: req.auth?.userId,
      });
    });
    next();
  });

  const mounts: [string, express.Router][] = [
    ['/auth', authRoutes],
    ['/consents', consentRoutes],
    ['/users', userRoutes],
    ['/verifications', verificationsRouter],
    ['/documents', documentsRouter],
    ['/files', filesRouter],
    ['/locations', locationRoutes],
    ['/bank-accounts', bankAccountsRouter],
    ['/banks', banksRouter],
    ['/organizations', organizationsRouter],
    ['/farmers', farmerMembershipsRouter],
    ['/farmers', farmerFarmsRouter],
    ['/imports', importRoutes],
    ['/farms', farmsRouter],
    ['/farms', farmRecordsRouter],
    ['/crops', cropsRouter],
    ['/observations', observationsRouter],
    ['/dco', dcoRouter],
    ['/farm-assignments', assignmentsRouter],
    ['/farm-visits', farmVisitsRouter],
    ['/ai', aiRouter],
    ['/reports', reportRoutes],
    ['/dashboard', dashboardRouter],
    ['/notifications', notificationsRouter],
    ['/integrations', webhooksRouter],
    ['/health', healthRoutes],
    ['/admin/dashboard', adminDashboardRouter],
    ['/admin/verifications', adminVerificationsRouter],
    ['/admin/ai', adminAiRouter],
    ['/admin', adminVisitsRouter],
    ['/admin', adminRoutes],
  ];
  const v1 = express.Router();
  for (const [prefix, router] of mounts) v1.use(prefix, router);

  let openapi: unknown;
  v1.get('/openapi.json', (_req, res) => {
    openapi ??= buildOpenApi(mounts);
    res.json(openapi);
  });

  app.use('/api/v1', v1);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
