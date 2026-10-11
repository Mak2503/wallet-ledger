import { FastifyReply } from 'fastify';
import { HttpResult } from '../types/transfer';

export function sendJson(reply: FastifyReply, result: HttpResult) {
  const response = reply.code(result.statusCode).type('application/json');
  if (result.retryAfter) response.header('Retry-After', '1');
  return response.send(result.serializedBody);
}
