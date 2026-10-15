import { prisma } from '../config/prisma';
import { unprocessable } from '../lib/errors';

/** Validate that a state exists and, if given, that the LGA belongs to it. */
export async function assertLocation(stateId?: number | null, lgaId?: number | null, fieldPrefix = '') {
  if (stateId == null && lgaId == null) return;
  if (stateId == null && lgaId != null) {
    throw unprocessable('state_id is required when lga_id is provided', [{ field: `${fieldPrefix}state_id`, reason: 'required' }]);
  }
  const state = await prisma.state.findUnique({ where: { id: stateId! } });
  if (!state) throw unprocessable('Unknown state', [{ field: `${fieldPrefix}state_id`, reason: 'not found' }]);
  if (lgaId != null) {
    const lga = await prisma.lga.findUnique({ where: { id: lgaId } });
    if (!lga || lga.stateId !== stateId) {
      throw unprocessable('LGA does not belong to the given state', [{ field: `${fieldPrefix}lga_id`, reason: 'not in state' }]);
    }
  }
}
