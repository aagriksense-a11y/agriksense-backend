import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { ApiError } from '../lib/errors';
import { zodToApiError } from '../lib/validation';
import { logger } from '../lib/logger';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(new ApiError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

function normalize(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) return zodToApiError(err);
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Uploaded file is too large');
    return new ApiError(400, 'BAD_UPLOAD', err.message);
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[] | string | undefined) ?? [];
      return new ApiError(409, 'CONFLICT', 'A record with these details already exists', {
        fields: Array.isArray(target) ? target : [target],
      });
    }
    if (err.code === 'P2025') return new ApiError(404, 'NOT_FOUND', 'Resource not found');
    if (err.code === 'P2003') return new ApiError(422, 'INVALID_REFERENCE', 'A referenced record does not exist');
  }
  const anyErr = err as { type?: string; status?: number };
  if (anyErr?.type === 'entity.parse.failed') return new ApiError(400, 'MALFORMED_JSON', 'Request body is not valid JSON');
  if (anyErr?.type === 'entity.too.large') return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  return new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const apiError = normalize(err);
  if (apiError.status >= 500 && !(err instanceof ApiError)) {
    logger.error('request_failed', { request_id: req.requestId, path: req.path, error: (err as Error)?.stack ?? String(err) });
  }
  const error: Record<string, unknown> = { code: apiError.code, message: apiError.message };
  if (apiError.details) error.details = apiError.details;
  res.status(apiError.status).json({ error, request_id: req.requestId });
}
