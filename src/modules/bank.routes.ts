import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { asyncHandler, created, noContent, ok } from '../lib/http';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { parse, uuid } from '../lib/validation';
import { encrypt, lookupHash, last4 } from '../lib/crypto';
import { serializeBankAccount } from '../lib/serializers';
import { audit } from '../lib/audit';
import { authOf, requireAuth } from '../middleware/auth';
import { refreshOnboarding } from '../services/onboarding.service';

export const bankAccountsRouter = Router();
export const banksRouter = Router();

// GET /banks
banksRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const banks = await prisma.bank.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    ok(res, banks.map((b) => ({ id: b.id, name: b.name, code: b.code })));
  }),
);

bankAccountsRouter.use(requireAuth);

const nuban = z.string().regex(/^[0-9]{10}$/, 'account number must be a 10-digit NUBAN');

// GET /bank-accounts — masked
bankAccountsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const accounts = await prisma.bankAccount.findMany({
      where: { userId: authOf(req).userId, deletedAt: null },
      include: { bank: true },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    ok(res, accounts.map(serializeBankAccount));
  }),
);

// POST /bank-accounts
bankAccountsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const body = parse(
      z.object({ bank_id: z.number().int().positive(), account_number: nuban, account_name: z.string().trim().min(2).max(150), is_primary: z.boolean().optional() }),
      req.body,
    );
    const bank = await prisma.bank.findUnique({ where: { id: body.bank_id } });
    if (!bank || !bank.isActive) throw unprocessable('Unknown bank', [{ field: 'bank_id', reason: 'not found' }]);
    const hash = lookupHash(`${bank.code}:${body.account_number}`);
    const dup = await prisma.bankAccount.findFirst({ where: { userId: auth.userId, accountNumberHash: hash, deletedAt: null } });
    if (dup) throw conflict('This bank account is already on your profile');
    const existingCount = await prisma.bankAccount.count({ where: { userId: auth.userId, deletedAt: null } });
    const isPrimary = existingCount === 0 ? true : !!body.is_primary;
    const account = await prisma.$transaction(async (tx) => {
      if (isPrimary) await tx.bankAccount.updateMany({ where: { userId: auth.userId }, data: { isPrimary: false } });
      return tx.bankAccount.create({
        data: {
          userId: auth.userId,
          bankId: bank.id,
          accountName: body.account_name,
          accountNumberEncrypted: encrypt(body.account_number),
          accountNumberHash: hash,
          accountNumberLast4: last4(body.account_number),
          isPrimary,
        },
        include: { bank: true },
      });
    });
    await audit(req, 'bank_account.created', 'bank_account', account.id);
    await refreshOnboarding(auth.userId);
    created(res, serializeBankAccount(account));
  }),
);

// PATCH /bank-accounts/{accountId}
bankAccountsRouter.patch(
  '/:accountId',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const id = parse(uuid, req.params.accountId);
    const body = parse(
      z.object({ bank_id: z.number().int().positive().optional(), account_number: nuban.optional(), account_name: z.string().trim().min(2).max(150).optional(), is_primary: z.literal(true).optional() }).strict(),
      req.body,
    );
    const account = await prisma.bankAccount.findFirst({ where: { id, userId: auth.userId, deletedAt: null }, include: { bank: true } });
    if (!account) throw notFound('Bank account');
    const bank = body.bank_id ? await prisma.bank.findUnique({ where: { id: body.bank_id } }) : account.bank;
    if (!bank) throw unprocessable('Unknown bank', [{ field: 'bank_id', reason: 'not found' }]);
    const numberChanged = !!body.account_number || !!body.bank_id;
    if (numberChanged && !body.account_number) {
      throw unprocessable('account_number is required when changing bank', [{ field: 'account_number', reason: 'required' }]);
    }
    const updated = await prisma.$transaction(async (tx) => {
      if (body.is_primary) await tx.bankAccount.updateMany({ where: { userId: auth.userId }, data: { isPrimary: false } });
      return tx.bankAccount.update({
        where: { id },
        data: {
          bankId: bank.id,
          accountName: body.account_name,
          isPrimary: body.is_primary,
          ...(body.account_number
            ? {
                accountNumberEncrypted: encrypt(body.account_number),
                accountNumberHash: lookupHash(`${bank.code}:${body.account_number}`),
                accountNumberLast4: last4(body.account_number),
              }
            : {}),
        },
        include: { bank: true },
      });
    });
    await audit(req, 'bank_account.updated', 'bank_account', id, { fields: Object.keys(body) });
    ok(res, serializeBankAccount(updated));
  }),
);

// DELETE /bank-accounts/{accountId} — soft delete; record retained for financial audit
bankAccountsRouter.delete(
  '/:accountId',
  asyncHandler(async (req, res) => {
    const auth = authOf(req);
    const id = parse(uuid, req.params.accountId);
    const account = await prisma.bankAccount.findFirst({ where: { id, userId: auth.userId, deletedAt: null } });
    if (!account) throw notFound('Bank account');
    const remaining = await prisma.bankAccount.count({ where: { userId: auth.userId, deletedAt: null } });
    if (remaining <= 1) throw conflict('You must keep at least one bank account; add another before removing this one');
    await prisma.$transaction(async (tx) => {
      await tx.bankAccount.update({ where: { id }, data: { deletedAt: new Date(), isPrimary: false } });
      if (account.isPrimary) {
        const next = await tx.bankAccount.findFirst({ where: { userId: auth.userId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
        if (next) await tx.bankAccount.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    });
    await audit(req, 'bank_account.deleted', 'bank_account', id);
    noContent(res);
  }),
);
