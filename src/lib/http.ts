import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface PageMeta {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

/** Wraps async handlers so rejected promises reach the error middleware. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function send(res: Response, status: number, data: unknown, meta?: Record<string, unknown> | PageMeta) {
  const body: Record<string, unknown> = { data };
  if (meta) body.meta = meta;
  body.request_id = res.locals.requestId;
  return res.status(status).json(body);
}

export const ok = (res: Response, data: unknown, meta?: Record<string, unknown> | PageMeta) => send(res, 200, data, meta);
export const created = (res: Response, data: unknown) => send(res, 201, data);
export const accepted = (res: Response, data: unknown) => send(res, 202, data);
export const noContent = (res: Response) => res.status(204).end();
