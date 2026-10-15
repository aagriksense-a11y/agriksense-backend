import type { NextFunction, Request, Response } from 'express';
import { BaseRole } from '@prisma/client';
import { prisma } from '../config/prisma';
import { forbidden, unauthorized } from '../lib/errors';
import { verifyAccessToken } from '../lib/tokens';
import type { AuthContext } from '../types/express';
import type { PermissionKey } from '../lib/permissions';

/** Effective permissions = base-role system role defaults ∪ all explicitly assigned roles. */
export async function loadPermissions(userId: string, baseRole: BaseRole): Promise<Set<string>> {
  const rows = await prisma.rolePermission.findMany({
    where: {
      role: {
        OR: [{ key: baseRole, isSystem: true }, { assignments: { some: { userId } } }],
      },
    },
    select: { permissionKey: true },
  });
  return new Set(rows.map((r) => r.permissionKey));
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (req.auth) return next(); // already authenticated by an earlier router on this path
  try {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) throw unauthorized('Bearer access token required');
    let payload;
    try {
      payload = verifyAccessToken(header.slice(7));
    } catch {
      throw unauthorized('Invalid or expired access token');
    }
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, agriksenseId: true, baseRole: true, isActive: true },
    });
    if (!user) throw unauthorized('Account no longer exists');
    if (!user.isActive) throw forbidden('Account has been disabled. Contact an administrator.');
    const auth: AuthContext = {
      userId: user.id,
      agriksenseId: user.agriksenseId,
      role: user.baseRole,
      permissions: await loadPermissions(user.id, user.baseRole),
    };
    req.auth = auth;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: BaseRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role)) return next(forbidden(`This endpoint is only available to: ${roles.join(', ')}`));
    next();
  };
}

export function requirePermission(...permissions: PermissionKey[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(unauthorized());
    const missing = permissions.filter((p) => !req.auth!.permissions.has(p));
    if (missing.length) return next(forbidden(`Missing permission: ${missing.join(', ')}`));
    next();
  };
}

export function hasPermission(req: Request, permission: PermissionKey): boolean {
  return !!req.auth?.permissions.has(permission);
}

export function authOf(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
