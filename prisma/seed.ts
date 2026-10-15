/* Idempotent reference-data seed. Safe to re-run. */
import 'dotenv/config';
import { PrismaClient, AiCrop } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { STATES, LGAS, CITIES, BANKS } from './data/nigeria';
import { PERMISSIONS, SYSTEM_ROLES, DEFAULT_ROLE_PERMISSIONS } from '../src/lib/permissions';

const prisma = new PrismaClient();

const CONSENTS = [
  {
    scope: 'account_creation' as const,
    title: 'AgriKSense Terms of Use',
    body:
      'DRAFT — replace with legally approved wording before launch.\n\nBy creating an AgriKSense account you agree that we store the personal details you provide ' +
      '(name, phone number, email, location) to operate your account, issue your AgriKSense ID and contact you about your account.',
  },
  {
    scope: 'farm_data_collection' as const,
    title: 'Farmer Informed Consent — Farm Visits and Data Collection',
    body:
      'DRAFT — replace with legally approved wording before launch.\n\nI agree that AgriKSense Data Collection Officers may visit my farm and record information about my farm, ' +
      'crops, farmland, pests and diseases, including photographs. I understand that participation is voluntary, that I may end a visit at any time, ' +
      'and that I may withdraw this consent at any time; withdrawal stops future data collection.',
  },
];

async function main() {
  for (const s of STATES) await prisma.state.upsert({ where: { code: s.code }, create: s, update: { name: s.name } });
  const states = await prisma.state.findMany();
  let lgaCount = 0;
  for (const [code, names] of Object.entries(LGAS)) {
    const state = states.find((s) => s.code === code)!;
    for (const name of names) {
      await prisma.lga.upsert({ where: { stateId_name: { stateId: state.id, name } }, create: { stateId: state.id, name }, update: {} });
      lgaCount++;
    }
  }
  for (const [key, cities] of Object.entries(CITIES)) {
    const [code, lgaName] = key.split('|');
    const state = states.find((s) => s.code === code)!;
    const lga = await prisma.lga.findUnique({ where: { stateId_name: { stateId: state.id, name: lgaName } } });
    if (!lga) continue;
    for (const name of cities) await prisma.city.upsert({ where: { lgaId_name: { lgaId: lga.id, name } }, create: { lgaId: lga.id, name }, update: {} });
  }

  for (const b of BANKS) await prisma.bank.upsert({ where: { code: b.code }, create: b, update: { name: b.name } });

  for (const c of CONSENTS) {
    await prisma.consentDocument.upsert({
      where: { version_scope_language: { version: 'v1', scope: c.scope, language: 'en' } },
      create: { version: 'v1', scope: c.scope, language: 'en', title: c.title, body: c.body, isCurrent: true },
      update: {},
    });
  }

  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, create: { key, description }, update: { description } });
  }
  for (const r of SYSTEM_ROLES) {
    const role = await prisma.role.upsert({ where: { key: r.key }, create: { ...r, isSystem: true }, update: { name: r.name, description: r.description, isSystem: true } });
    // platform_admin always holds every permission; other system roles keep any admin edits.
    if (r.key === 'platform_admin' || (await prisma.rolePermission.count({ where: { roleId: role.id } })) === 0) {
      await prisma.rolePermission.createMany({
        data: DEFAULT_ROLE_PERMISSIONS[r.key].map((permissionKey) => ({ roleId: role.id, permissionKey })),
        skipDuplicates: true,
      });
    }
  }

  // AI model registry: versions are registered but NOT approved. An admin approves them with the
  // verified ordered class list (POST /admin/ai/models/{crop}/approve) before activation.
  // Optionally pre-approve in non-production with SEED_AI_CLASSES_RICE="class0,class1,…".
  const urls: Record<AiCrop, string> = {
    rice: process.env.AI_RICE_URL ?? 'https://rice-disease-api-vzxa.onrender.com',
    maize: process.env.AI_MAIZE_URL ?? 'https://maize-disease-api.onrender.com',
    tomato: process.env.AI_TOMATO_URL ?? 'https://tomato-disease-api-w8if.onrender.com',
  };
  for (const crop of Object.values(AiCrop)) {
    const classes = (process.env[`SEED_AI_CLASSES_${crop.toUpperCase()}`] ?? '').split(',').map((c) => c.trim()).filter(Boolean);
    const preApprove = classes.length > 0 && process.env.NODE_ENV !== 'production';
    await prisma.aiModelVersion.upsert({
      where: { crop_version: { crop, version: 'qa-1' } },
      create: { crop, version: 'qa-1', serviceUrl: urls[crop], classes, status: preApprove ? 'active' : 'registered', ...(preApprove ? { approvedAt: new Date(), activatedAt: new Date() } : {}) },
      update: {},
    });
  }

  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@agriksense.local').toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    const password = process.env.SEED_ADMIN_PASSWORD;
    if (!password) throw new Error('Set SEED_ADMIN_PASSWORD to create the initial platform admin');
    await prisma.$transaction(async (tx) => {
      let agriksenseId = '';
      for (;;) {
        agriksenseId = crypto.randomInt(0, 10_000_000_000).toString().padStart(10, '0');
        const n = await tx.$executeRaw`INSERT INTO "IssuedAgriksenseId" ("id","issuedAt") VALUES (${agriksenseId}, now()) ON CONFLICT DO NOTHING`;
        if (n === 1) break;
      }
      await tx.user.create({
        data: { agriksenseId, baseRole: 'platform_admin', email, passwordHash: await bcrypt.hash(password, 12), firstName: 'Platform', lastName: 'Admin', onboardingStatus: 'complete' },
      });
    });
    console.log(`Created platform admin ${email}`);
  }

  console.log(`Seeded ${states.length} states, ${lgaCount} LGAs, ${BANKS.length} banks, ${Object.keys(PERMISSIONS).length} permissions.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
