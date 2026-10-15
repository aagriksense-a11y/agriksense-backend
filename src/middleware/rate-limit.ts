import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/errors';

/**
 * Small fixed-window in-memory limiter for abuse-prone endpoints (login, password reset).
 * Single-instance only — use a shared store (e.g. Redis) when running multiple replicas.
 */
export function rateLimit(opts: { windowMs: number; max: number; key?: (req: Request) => string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const max = Number(process.env.AUTH_RATE_LIMIT ?? '') || opts.max;
    const now = Date.now();
    const key = `${req.ip}|${opts.key ? opts.key(req) : ''}`;
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return next(new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Please try again later.'));
    }
    next();
  };
}
