import { HttpResult } from '../types/transfer';

export function jsonResult(statusCode: number, value: Record<string, unknown>): HttpResult {
  return { statusCode, serializedBody: JSON.stringify(value) };
}

export function processingResult(): HttpResult {
  return {
    ...jsonResult(409, { error: 'request with this Idempotency-Key is still processing; retry shortly' }),
    retryAfter: true,
  };
}
