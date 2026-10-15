import { HttpResult } from '../types/transfer';
import { randomUUID } from 'node:crypto';

export function jsonResult(statusCode: number, value: Record<string, unknown>): HttpResult {
  if (statusCode >= 400) {
    const message = typeof value.message === 'string' ? value.message :
      typeof value.error === 'string' ? value.error : 'Request failed';
    const code = typeof value.code === 'string' ? value.code : statusCode === 400 ? 'INVALID_REQUEST' :
      statusCode === 401 ? 'UNAUTHENTICATED' : statusCode === 403 ? 'FORBIDDEN' :
      statusCode === 404 ? 'NOT_FOUND' : statusCode === 409 && /insufficient funds/i.test(message) ? 'INSUFFICIENT_FUNDS' :
      statusCode === 409 ? 'CONFLICT' : statusCode === 422 && /idempotency-key/i.test(message) ? 'IDEMPOTENCY_KEY_REUSED' :
      statusCode === 422 ? 'UNPROCESSABLE_REQUEST' :
      statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
    return { statusCode, serializedBody: JSON.stringify({ code, message, request_id: randomUUID() }) };
  }
  return { statusCode, serializedBody: JSON.stringify(value) };
}

export function processingResult(): HttpResult {
  return {
    ...jsonResult(409, { error: 'request with this Idempotency-Key is still processing; retry shortly' }),
    retryAfter: true,
  };
}
