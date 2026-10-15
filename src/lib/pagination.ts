import { z } from 'zod';
import type { PageMeta } from './http';
import { parse } from './validation';

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().max(64).optional(),
  search: z.string().trim().max(100).optional(),
});

export interface Pagination {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
  search?: string;
  sort?: string;
}

export function getPagination(query: unknown): Pagination {
  const { page, page_size, search, sort } = parse(paginationSchema.passthrough(), query);
  return { page, pageSize: page_size, skip: (page - 1) * page_size, take: page_size, search: search || undefined, sort };
}

export function pageMeta(p: Pagination, total: number): PageMeta {
  return { page: p.page, page_size: p.pageSize, total, total_pages: Math.ceil(total / p.pageSize) };
}

/**
 * Translate `sort=field` / `sort=-field` into a Prisma orderBy, restricted to an allow-list
 * mapping API field names to model fields.
 */
export function orderBy(
  sort: string | undefined,
  allowed: Record<string, string>,
  fallback: Record<string, 'asc' | 'desc'> = { createdAt: 'desc' },
): Record<string, 'asc' | 'desc'> {
  if (!sort) return fallback;
  const desc = sort.startsWith('-');
  const key = desc ? sort.slice(1) : sort;
  const field = allowed[key];
  if (!field) return fallback;
  return { [field]: desc ? 'desc' : 'asc' };
}
