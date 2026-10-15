import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { logger } from './lib/logger';

const app = createApp();
const server = app.listen(env.port, () => {
  logger.info('server_started', { port: env.port, env: env.nodeEnv, base_path: '/api/v1' });
});

async function shutdown(signal: string) {
  logger.info('shutdown', { signal });
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
