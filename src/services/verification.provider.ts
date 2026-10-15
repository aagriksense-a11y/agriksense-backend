import { VerificationStatus, VerificationType } from '@prisma/client';
import { env } from '../config/env';

export interface VerificationInput {
  type: VerificationType;
  number: string;
  /** Name on record, used for NIN name-match (individuals) or registered name (CAC). */
  name: string;
}

export interface VerificationResult {
  status: VerificationStatus;
  nameMatch?: 'match' | 'partial' | 'mismatch' | 'unknown';
  providerRef?: string;
  failureReason?: string;
}

export interface VerificationProvider {
  name: string;
  verify(input: VerificationInput): Promise<VerificationResult>;
}

/**
 * Manual provider: no automated check. Every submission is routed to an authorized reviewer
 * (POST /admin/verifications/{id}/review). Never auto-verifies.
 */
const manualProvider: VerificationProvider = {
  name: 'manual',
  async verify() {
    return { status: 'manual_review', nameMatch: 'unknown' };
  },
};

/**
 * Deterministic provider for development and automated tests ONLY. Outcomes are keyed on the
 * last digits of the number so QA can exercise every state:
 *   …0000 → verified (name match)   …1111 → verified with name mismatch → manual_review
 *   …9999 → rejected                …5555 → provider timeout → manual_review   other → manual_review
 */
const mockProvider: VerificationProvider = {
  name: 'mock',
  async verify({ number }) {
    if (number.endsWith('0000')) return { status: 'verified', nameMatch: 'match', providerRef: `mock-${number.slice(-4)}` };
    if (number.endsWith('1111')) return { status: 'manual_review', nameMatch: 'mismatch', failureReason: 'Name on record does not match' };
    if (number.endsWith('9999')) return { status: 'rejected', nameMatch: 'unknown', failureReason: 'Number not found at provider' };
    if (number.endsWith('5555')) return { status: 'manual_review', nameMatch: 'unknown', failureReason: 'Provider timeout' };
    return { status: 'manual_review', nameMatch: 'unknown' };
  },
};

export function getVerificationProvider(): VerificationProvider {
  if (env.verificationProvider === 'mock') {
    if (env.isProduction) throw new Error('The mock verification provider cannot be used in production');
    return mockProvider;
  }
  return manualProvider;
}
