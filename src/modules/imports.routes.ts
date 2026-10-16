import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { parse as parseCsv } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { ImportEntityType, Prisma } from '@prisma/client';
import type { ImportJob } from '@prisma/client';
import { prisma } from '../config/prisma';
import { asyncHandler, created, ok } from '../lib/http';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { parse, uuid, email as emailSchema, phone as phoneSchema, isoDate } from '../lib/validation';
import { iso } from '../lib/serializers';
import { getPagination, pageMeta } from '../lib/pagination';
import { audit } from '../lib/audit';
import { decrypt, encrypt, lookupHash, last4 } from '../lib/crypto';
import { authOf, hasPermission, requireAuth } from '../middleware/auth';
import { singleFile } from '../middleware/upload';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { createAccount } from '../services/user.service';
import { generateMembershipNumber } from '../services/membership.service';
import { NotificationService } from '../services/notification.service';

const router = Router();
router.use(requireAuth);

/**
 * CSV templates. Passwords are never part of a template: imported users activate their
 * account through password reset. NIN is optional; imported users stay in onboarding "draft"
 * (or "pending_verification") until a NIN is verified — imports never auto-verify identity.
 */
const TEMPLATES: Record<ImportEntityType, string[]> = {
  farmer: ['first_name', 'last_name', 'other_name', 'phone', 'email', 'state', 'lga', 'city', 'address', 'nin'],
  dco: ['first_name', 'last_name', 'other_name', 'phone', 'email', 'state', 'lga', 'city', 'address', 'nin'],
  organization: ['organization_name', 'email', 'phone', 'is_registered', 'state', 'lga', 'city', 'headquarters_address'],
  member: ['membership_id', 'farmer_agriksense_id', 'first_name', 'last_name', 'other_name', 'phone', 'email', 'joined_at'],
};
const REQUIRED: Record<ImportEntityType, string[]> = {
  farmer: ['first_name', 'last_name', 'phone'],
  dco: ['first_name', 'last_name', 'phone', 'email'],
  organization: ['organization_name', 'email'],
  member: [],
};
const MAX_ROWS = 5000;

function assertCanImport(req: Request, entityType: ImportEntityType) {
  const auth = authOf(req);
  if (entityType === 'member') {
    if (auth.role !== 'organization_admin') throw forbidden('Member imports are performed by organization accounts');
  } else if (!hasPermission(req, 'imports.manage')) {
    throw forbidden('Missing permission: imports.manage');
  }
}

// GET /imports/templates/{entityType}
router.get(
  '/templates/:entityType',
  asyncHandler(async (req, res) => {
    const entityType = parse(z.nativeEnum(ImportEntityType), req.params.entityType);
    const csv = stringify([TEMPLATES[entityType]]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agriksense-${entityType}-template.csv"`);
    res.status(200).send(csv);
  }),
);

type RowError = { field?: string; reason: string };
interface StateLookup {
  states: Map<string, number>;
  lgas: Map<string, number>; // key `${stateId}|${lowercased name}`
}

async function locationLookup(): Promise<StateLookup> {
  const [states, lgas] = await Promise.all([prisma.state.findMany(), prisma.lga.findMany()]);
  return {
    states: new Map(states.flatMap((s) => [[s.name.toLowerCase(), s.id], [s.code.toLowerCase(), s.id]] as [string, number][])),
    lgas: new Map(lgas.map((l) => [`${l.stateId}|${l.name.toLowerCase()}`, l.id])),
  };
}

function resolveLocation(row: Record<string, string>, loc: StateLookup, errors: RowError[]) {
  let stateId: number | null = null;
  let lgaId: number | null = null;
  if (row.state) {
    stateId = loc.states.get(row.state.toLowerCase()) ?? null;
    if (!stateId) errors.push({ field: 'state', reason: 'unknown state' });
  }
  if (row.lga) {
    if (!stateId) errors.push({ field: 'lga', reason: 'state is required with lga' });
    else {
      lgaId = loc.lgas.get(`${stateId}|${row.lga.toLowerCase()}`) ?? null;
      if (!lgaId) errors.push({ field: 'lga', reason: 'unknown LGA for state' });
    }
  }
  return { stateId, lgaId };
}

function check(schema: z.ZodTypeAny, value: string | undefined, field: string, errors: RowError[]) {
  if (!value) return;
  const r = schema.safeParse(value);
  if (!r.success) errors.push({ field, reason: r.error.errors[0]?.message ?? 'invalid' });
}

/** Validate every row; detect duplicates within the file and against existing records. */
async function validateRows(entityType: ImportEntityType, rows: Record<string, string>[], organizationId: string | null) {
  const loc = await locationLookup();
  const seenEmail = new Map<string, number>();
  const seenPhone = new Map<string, number>();
  const seenMembership = new Map<string, number>();
  const seenFarmer = new Map<string, number>();
  const seenNin = new Map<string, number>();

  const emails = rows.map((r) => r.email?.toLowerCase()).filter(Boolean);
  const phones = rows.map((r) => r.phone).filter(Boolean);
  const existingUsers = await prisma.user.findMany({
    where: { OR: [{ email: { in: emails } }, { phone: { in: phones } }] },
    select: { email: true, phone: true, agriksenseId: true },
  });
  const takenEmail = new Set(existingUsers.map((u) => u.email).filter(Boolean));
  const takenPhone = new Set(existingUsers.map((u) => u.phone).filter(Boolean));
  const existingMemberships = organizationId
    ? await prisma.organizationMembership.findMany({ where: { organizationId }, select: { membershipNumber: true, farmer: { select: { agriksenseId: true } } } })
    : [];
  const takenMembership = new Set(existingMemberships.map((m) => m.membershipNumber));
  const memberFarmers = new Set(existingMemberships.map((m) => m.farmer?.agriksenseId).filter(Boolean));
  const farmerIds = entityType === 'member' ? rows.map((r) => r.farmer_agriksense_id).filter(Boolean) : [];
  const knownFarmers = new Set(
    (await prisma.user.findMany({ where: { agriksenseId: { in: farmerIds }, baseRole: 'farmer' }, select: { agriksenseId: true } })).map((u) => u.agriksenseId),
  );
  const nins = ['farmer', 'dco'].includes(entityType) ? rows.map((r) => r.nin).filter(Boolean).map((n) => lookupHash(n)) : [];
  const takenNin = new Set(
    (await prisma.identityVerification.findMany({ where: { numberHash: { in: nins }, type: 'nin', status: { not: 'rejected' } }, select: { numberHash: true } })).map((v) => v.numberHash),
  );

  return rows.map((raw, index) => {
    const row: Record<string, string> = {};
    for (const key of TEMPLATES[entityType]) row[key] = (raw[key] ?? '').trim();
    if (row.email) row.email = row.email.toLowerCase();
    const errors: RowError[] = [];
    let duplicate = false;
    const rowNumber = index + 2; // header is line 1

    const required = [...REQUIRED[entityType]];
    if (entityType === 'member' && !row.farmer_agriksense_id) required.push('first_name', 'last_name', 'phone');
    for (const f of required) if (!row[f]) errors.push({ field: f, reason: 'required' });

    check(emailSchema, row.email, 'email', errors);
    check(phoneSchema, row.phone, 'phone', errors);
    if (row.nin) check(z.string().regex(/^[0-9]{11}$/, 'NIN must be exactly 11 digits'), row.nin, 'nin', errors);
    if (row.joined_at) check(isoDate, row.joined_at, 'joined_at', errors);
    if (row.is_registered && !['true', 'false', 'yes', 'no', '1', '0'].includes(row.is_registered.toLowerCase())) {
      errors.push({ field: 'is_registered', reason: 'must be true or false' });
    }
    if (entityType !== 'member') resolveLocation(row, loc, errors);

    const dupCheck = (map: Map<string, number>, taken: Set<string | null | undefined>, value: string, field: string, label: string) => {
      if (!value) return;
      if (map.has(value)) {
        duplicate = true;
        errors.push({ field, reason: `duplicate of row ${map.get(value)} in this file` });
      } else map.set(value, rowNumber);
      if (taken.has(value)) {
        duplicate = true;
        errors.push({ field, reason: `${label} already exists` });
      }
    };
    if (entityType !== 'member' || !row.farmer_agriksense_id) {
      dupCheck(seenEmail, takenEmail, row.email, 'email', 'an account with this email');
      dupCheck(seenPhone, takenPhone, row.phone, 'phone', 'an account with this phone');
    }
    if (row.nin) dupCheck(seenNin, takenNin, lookupHash(row.nin), 'nin', 'this NIN is linked to an existing account');
    if (entityType === 'member') {
      dupCheck(seenMembership, takenMembership, row.membership_id, 'membership_id', 'membership ID');
      if (row.farmer_agriksense_id) {
        if (!/^[0-9]{10}$/.test(row.farmer_agriksense_id)) errors.push({ field: 'farmer_agriksense_id', reason: 'must be 10 digits' });
        else if (!knownFarmers.has(row.farmer_agriksense_id)) errors.push({ field: 'farmer_agriksense_id', reason: 'no farmer with this AgriKSense ID' });
        dupCheck(seenFarmer, memberFarmers, row.farmer_agriksense_id, 'farmer_agriksense_id', 'farmer is already a member');
      }
    }
    const status = errors.length === 0 ? 'valid' : duplicate ? 'duplicate' : 'invalid';
    return { rowNumber, data: row, status: status as 'valid' | 'invalid' | 'duplicate', errors };
  });
}

const serializeJob = (j: ImportJob) => ({
  id: j.id,
  entity_type: j.entityType,
  status: j.status,
  file_name: j.fileName,
  organization_id: j.organizationId,
  counts: { total: j.totalRows, valid: j.validRows, invalid: j.invalidRows, duplicate: j.duplicateRows, committed: j.committedRows },
  committed_at: iso(j.committedAt),
  created_at: iso(j.createdAt),
  updated_at: iso(j.updatedAt),
});

// POST /imports (multipart: file, entity_type) — dry-run validation; nothing is created until commit
router.post(
  '/',
  singleFile,
  requireIdempotencyKey,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const { entity_type } = parse(z.object({ entity_type: z.nativeEnum(ImportEntityType) }), req.body);
    assertCanImport(req, entity_type);
    if (!req.file) throw unprocessable('A CSV file is required', [{ field: 'file', reason: 'required' }]);
    const text = req.file.buffer.toString('utf8');
    if (text.includes('\u0000')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'File must be a UTF-8 CSV');
    let records: Record<string, string>[];
    try {
      records = parseCsv(text, { columns: (h: string[]) => h.map((c) => c.trim().toLowerCase()), skip_empty_lines: true, bom: true, trim: true, relax_column_count: true });
    } catch (err) {
      throw unprocessable(`CSV could not be parsed: ${(err as Error).message}`, undefined, 'INVALID_CSV');
    }
    if (records.length === 0) throw unprocessable('CSV contains no data rows', undefined, 'EMPTY_CSV');
    if (records.length > MAX_ROWS) throw new ApiError(413, 'TOO_MANY_ROWS', `A single import may contain at most ${MAX_ROWS} rows`);
    const headers = Object.keys(records[0]);
    if (headers.includes('password')) throw unprocessable('Templates must not contain passwords', [{ field: 'password', reason: 'column not allowed' }]);
    const missing = REQUIRED[entity_type].filter((h) => !headers.includes(h));
    if (missing.length) throw unprocessable('CSV is missing required columns', missing.map((m) => ({ field: m, reason: 'missing column' })), 'INVALID_CSV');

    const organizationId = entity_type === 'member' ? (await prisma.organization.findUniqueOrThrow({ where: { ownerUserId: auth.userId } })).id : null;
    const results = await validateRows(entity_type, records, organizationId);
    const counts = {
      validRows: results.filter((r) => r.status === 'valid').length,
      invalidRows: results.filter((r) => r.status === 'invalid').length,
      duplicateRows: results.filter((r) => r.status === 'duplicate').length,
    };
    const job = await prisma.importJob.create({
      data: {
        entityType: entity_type,
        status: counts.validRows > 0 ? 'validated' : 'failed',
        organizationId,
        createdById: auth.userId,
        fileName: req.file.originalname?.slice(0, 255),
        totalRows: results.length,
        ...counts,
        rows: {
          create: results.map((r) => {
            // Never persist raw NINs in import staging rows.
            const { nin, ...rest } = r.data;
            const data = nin ? { ...rest, nin_encrypted: encrypt(nin), nin_last4: last4(nin) } : rest;
            return { rowNumber: r.rowNumber, data, status: r.status, errors: r.errors.length ? r.errors : Prisma.JsonNull };
          }),
        },
      },
    });
    await audit(req, 'import.validated', 'import_job', job.id, { entity_type, total: results.length, ...counts });
    created(res, serializeJob(job));
  }),
);

async function loadJob(req: Request) {
  const auth = authOf(req);
  const job = await prisma.importJob.findUnique({ where: { id: parse(uuid, req.params.jobId) } });
  if (!job) throw notFound('Import job');
  if (job.createdById !== auth.userId && !hasPermission(req, 'imports.manage')) throw notFound('Import job');
  return job;
}

// GET /imports/{jobId}
router.get(
  '/:jobId',
  asyncHandler(async (req, res) => {
    const job = await loadJob(req);
    const p = getPagination(req.query);
    const rows = await prisma.importRow.findMany({
      where: { jobId: job.id, status: { in: ['invalid', 'duplicate', 'failed'] } },
      orderBy: { rowNumber: 'asc' },
      skip: p.skip,
      take: p.take,
    });
    const errorCount = job.invalidRows + job.duplicateRows + (await prisma.importRow.count({ where: { jobId: job.id, status: 'failed' } }));
    ok(res, { ...serializeJob(job), row_errors: rows.map((r) => ({ row_number: r.rowNumber, status: r.status, errors: r.errors })) }, pageMeta(p, errorCount));
  }),
);

// GET /imports/{jobId}/errors — CSV row-level error report
router.get(
  '/:jobId/errors',
  asyncHandler(async (req, res) => {
    const job = await loadJob(req);
    const rows = await prisma.importRow.findMany({ where: { jobId: job.id, status: { in: ['invalid', 'duplicate', 'failed'] } }, orderBy: { rowNumber: 'asc' } });
    const columns = TEMPLATES[job.entityType].filter((c) => c !== 'nin');
    const csv = stringify([
      ['row_number', 'status', 'errors', ...columns],
      ...rows.map((r) => {
        const data = r.data as Record<string, string>;
        const errs = ((r.errors as RowError[] | null) ?? []).map((e) => (e.field ? `${e.field}: ${e.reason}` : e.reason)).join('; ');
        return [r.rowNumber, r.status, errs, ...columns.map((c) => data[c] ?? '')];
      }),
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="import-${job.id}-errors.csv"`);
    res.status(200).send(csv);
  }),
);

// POST /imports/{jobId}/commit — creates records for valid rows; safe to retry (committed rows are skipped)
router.post(
  '/:jobId/commit',
  requireIdempotencyKey,
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const job = await loadJob(req);
    assertCanImport(req, job.entityType);
    if (job.status === 'committed') return ok(res, serializeJob(job));
    if (job.status === 'failed') throw unprocessable('Import has no valid rows to commit', undefined, 'NOTHING_TO_COMMIT');
    const claimed = await prisma.importJob.updateMany({ where: { id: job.id, status: 'validated' }, data: { status: 'committing' } });
    if (claimed.count !== 1) throw conflict('Import is already being committed');

    const rows = await prisma.importRow.findMany({ where: { jobId: job.id, status: 'valid' }, orderBy: { rowNumber: 'asc' } });
    const loc = await locationLookup();
    const welcome: Awaited<ReturnType<typeof createAccount>>[] = [];
    for (const row of rows) {
      const data = row.data as Record<string, string>;
      try {
        let created: Awaited<ReturnType<typeof createAccount>> | null = null;
        const entityId = await prisma.$transaction(async (tx) => {
          const locErrors: RowError[] = [];
          const { stateId, lgaId } = job.entityType === 'member' ? { stateId: null, lgaId: null } : resolveLocation(data, loc, locErrors);
          if (job.entityType === 'member') {
            let farmerId: string;
            if (data.farmer_agriksense_id) {
              farmerId = (await tx.user.findUniqueOrThrow({ where: { agriksenseId: data.farmer_agriksense_id } })).id;
            } else {
              const farmer = await createAccount(
                { role: 'farmer', firstName: data.first_name, lastName: data.last_name, otherName: data.other_name || null, phone: data.phone, email: data.email || null, createdById: auth.userId },
                tx,
              );
              created = farmer;
              farmerId = farmer.id;
            }
            const m = await tx.organizationMembership.create({
              data: {
                organizationId: job.organizationId!,
                farmerId,
                membershipNumber: data.membership_id || (await generateMembershipNumber(job.organizationId!, tx)),
                isGeneratedNumber: !data.membership_id,
                joinedAt: data.joined_at ? new Date(data.joined_at) : null,
              },
            });
            return m.id;
          }
          const user = await createAccount(
            {
              role: job.entityType === 'organization' ? 'organization_admin' : job.entityType,
              firstName: data.first_name || null,
              lastName: data.last_name || null,
              otherName: data.other_name || null,
              organizationName: data.organization_name || null,
              organizationIsRegistered: ['true', 'yes', '1'].includes((data.is_registered ?? '').toLowerCase()),
              phone: data.phone || null,
              email: data.email || null,
              createdById: auth.userId,
              stateId: job.entityType === 'organization' ? null : stateId,
              lgaId: job.entityType === 'organization' ? null : lgaId,
              city: job.entityType === 'organization' ? null : data.city || null,
              address: job.entityType === 'organization' ? null : data.address || null,
            },
            tx,
          );
          if (job.entityType === 'organization') {
            await tx.organization.update({
              where: { ownerUserId: user.id },
              data: { stateId, lgaId, city: data.city || null, headquartersAddress: data.headquarters_address || null },
            });
          }
          if (data.nin_encrypted) {
            // Recorded for reviewer follow-up only — never auto-verified.
            const plain = decrypt(data.nin_encrypted);
            await tx.identityVerification.create({
              data: {
                type: 'nin',
                userId: user.id,
                status: 'manual_review',
                numberEncrypted: data.nin_encrypted,
                numberHash: lookupHash(plain),
                numberLast4: data.nin_last4,
                nameSubmitted: [data.first_name, data.other_name, data.last_name].filter(Boolean).join(' '),
                provider: 'bulk_import',
                failureReason: 'Imported NIN awaiting verification',
              },
            });
            await tx.user.update({ where: { id: user.id }, data: { ninStatus: 'manual_review' } });
          }
          created = user;
          return user.id;
        });
        if (created) welcome.push(created);
        await prisma.importRow.update({ where: { id: row.id }, data: { status: 'committed', createdEntityId: entityId } });
      } catch (err) {
        const reason = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' ? 'duplicate detected at commit time' : 'could not be created';
        await prisma.importRow.update({ where: { id: row.id }, data: { status: 'failed', errors: [{ reason }] } });
      }
    }
    const committedRows = await prisma.importRow.count({ where: { jobId: job.id, status: 'committed' } });
    const done = await prisma.importJob.update({ where: { id: job.id }, data: { status: 'committed', committedRows, committedAt: new Date() } });
    for (const u of welcome) await NotificationService.welcome(u);
    await audit(req, 'import.committed', 'import_job', job.id, { committed: committedRows });
    ok(res, serializeJob(done));
  }),
);

export default router;
