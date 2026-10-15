import type { BaseRole } from '@prisma/client';

export interface AuthContext {
  userId: string;
  agriksenseId: string;
  role: BaseRole;
  permissions: Set<string>;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      requestId: string;
    }
  }
}

export {};
