export interface ErrorDetail {
  field?: string;
  reason: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: ErrorDetail[] | Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: ApiError['details']) =>
  new ApiError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required') => new ApiError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new ApiError(403, 'FORBIDDEN', message);
export const notFound = (entity = 'Resource') => new ApiError(404, 'NOT_FOUND', `${entity} not found`);
export const conflict = (message: string, details?: ApiError['details']) =>
  new ApiError(409, 'CONFLICT', message, details);
export const unprocessable = (message: string, details?: ApiError['details'], code = 'UNPROCESSABLE') =>
  new ApiError(422, code, message, details);
export const validationError = (details: ErrorDetail[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Invalid request', details);
export const serviceUnavailable = (message: string, code = 'SERVICE_UNAVAILABLE') =>
  new ApiError(503, code, message);
