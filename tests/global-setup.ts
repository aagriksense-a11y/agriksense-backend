import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';

/** Migrate the dedicated test database, empty it, and load reference data. */
export default async function setup() {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/agriksense_test',
    SEED_ADMIN_EMAIL: 'admin@test.local',
    SEED_ADMIN_PASSWORD: 'AdminPass123',
  };
  if (!/_test\b|test/.test(env.DATABASE_URL.split('/').pop() ?? '')) {
    throw new Error('Refusing to run tests against a database whose name does not contain "test"');
  }
  execSync('npx prisma migrate deploy', { env, stdio: 'pipe' });
  const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await prisma.$disconnect();
  execSync('npx tsx prisma/seed.ts', { env, stdio: 'pipe' });
}
