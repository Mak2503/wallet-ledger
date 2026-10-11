import { FastifyReply, FastifyRequest } from 'fastify';
import { executeTransfer } from '../services/transfer_service';
import { jsonResult } from '../models/transfer';
import { TransferRequest } from '../types/transfer';
import { TransferRoute, DatabaseError } from '../types/http';
import { sendJson } from '../views/json_response';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fields = ['user_id', 'source_account_id', 'destination_account_id', 'amount_paise'];

function isTransferRequest(body: unknown): body is TransferRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return Number.isSafeInteger(value.user_id) && Number(value.user_id) > 0 &&
    Number.isSafeInteger(value.source_account_id) && Number(value.source_account_id) > 0 &&
    Number.isSafeInteger(value.destination_account_id) && Number(value.destination_account_id) > 0 &&
    Number.isSafeInteger(value.amount_paise) && Number(value.amount_paise) > 0;
}

export async function createTransferController(
  request: FastifyRequest<TransferRoute>,
  reply: FastifyReply,
) {
  const key = request.headers['idempotency-key'];
  if (!key || !uuidPattern.test(key)) return sendJson(reply, jsonResult(400, { error: 'Idempotency-Key header must contain a UUID' }));
  const body = request.body;
  if (!isTransferRequest(body)) return sendJson(reply, jsonResult(400, { error: 'invalid transfer request' }));
  if (Object.keys(body).some((field) => !fields.includes(field))) {
    return sendJson(reply, jsonResult(400, { error: 'unexpected transfer request field' }));
  }
  if (body.source_account_id === body.destination_account_id) {
    return sendJson(reply, jsonResult(400, { error: 'source and destination must differ' }));
  }
  try {
    return sendJson(reply, await executeTransfer(body, key.toLowerCase()));
  } catch (error) {
    request.log.error(error);
    if ((error as DatabaseError).code === '55P03') {
      return sendJson(reply, { ...jsonResult(409, { error: 'request with this Idempotency-Key is still processing; retry shortly' }), retryAfter: true });
    }
    return sendJson(reply, jsonResult(500, { error: 'transfer failed; transaction rolled back' }));
  }
}
