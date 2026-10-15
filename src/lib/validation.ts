import { z, ZodError, ZodTypeAny } from 'zod';
import { validationError } from './errors';

export function zodToApiError(error: ZodError) {
  return validationError(
    error.errors.map((issue) => ({
      field: issue.path.join('.') || undefined,
      reason: issue.message,
    })),
  );
}

/** Parse input against a schema, throwing the standard 422 VALIDATION_ERROR envelope. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw zodToApiError(result.error);
  return result.data;
}

// Reusable field schemas
export const uuid = z.string().uuid();
export const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{10,15}$/, 'must be a valid phone number (10-15 digits, optional leading +)');
export const email = z.string().trim().toLowerCase().email();
export const password = z
  .string()
  .min(8, 'must be at least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'must contain a letter')
  .regex(/[0-9]/, 'must contain a number');
export const nin = z.string().regex(/^[0-9]{11}$/, 'NIN must be exactly 11 digits');
export const name = z.string().trim().min(1).max(100);
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD format');
export const intId = z.coerce.number().int().positive();
export const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');
