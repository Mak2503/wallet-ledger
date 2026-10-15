import { FastifyReply, FastifyRequest } from 'fastify';
import { withTransaction } from '../database';
import { jsonResult } from '../models/transfer';
import { decideRiskTransfer, getPendingRiskQueue } from '../services/risk_decision_service';
import { executeIdempotentRequest, validIdempotencyKey } from '../services/request_idempotency_service';
import { sendJson } from '../views/json_response';
import { RiskDecisionRoute } from '../types/api_routes';

export async function riskQueueController(_request: FastifyRequest, reply: FastifyReply) {
  const rows = await withTransaction((client) => getPendingRiskQueue(client));
  return reply.code(200).send({ items: rows.rows });
}

export async function riskDecisionController(request: FastifyRequest<RiskDecisionRoute>, reply: FastifyReply) {
  const transferId = request.params.transfer_id;
  if (!/^\d+$/.test(transferId)) return sendJson(reply, jsonResult(400, { error: 'invalid transfer id' }));
  if (!validIdempotencyKey(request.headers['idempotency-key'])) {
    return sendJson(reply, jsonResult(400, { error: 'Idempotency-Key header must contain a UUID' }));
  }
  const body = request.body;
  const action = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).action : undefined;
  if (action !== 'release' && action !== 'reverse') return sendJson(reply, jsonResult(400, { error: 'action must be release or reverse' }));
  try {
    const result = await executeIdempotentRequest(`admin:risk:${transferId}`, request.headers['idempotency-key'], { action }, (client) => decideRiskTransfer(client, transferId, action));
    return sendJson(reply, result);
  } catch (error) {
    request.log.error(error);
    return sendJson(reply, jsonResult(500, { error: 'risk decision could not be applied' }));
  }
}
