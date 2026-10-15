import { FastifyReply, FastifyRequest } from 'fastify';
import { runReconciliation } from '../services/reconciliation_service';
import { executeIdempotentRequest, validIdempotencyKey } from '../services/request_idempotency_service';
import { jsonResult } from '../models/transfer';
import { sendJson } from '../views/json_response';
import { ReconciliationPostRoute } from '../types/api_routes';
import { ReconciliationDetailsRoute } from '../types/api_routes';
import { withTransaction } from '../database';

export async function runReconciliationController(request: FastifyRequest<ReconciliationPostRoute>, reply: FastifyReply) {
  const key = request.headers['idempotency-key'];
  if (!validIdempotencyKey(key)) return sendJson(reply, jsonResult(400, { error: 'Idempotency-Key header must contain a UUID' }));
  try {
    const result = await executeIdempotentRequest('admin:reconciliation', key.toLowerCase(), { run: true }, async () => {
      const run = await runReconciliation();
      return run.status === 'already_running'
        ? jsonResult(409, { error: 'reconciliation is already running' })
        : jsonResult(202, { ...run });
    });
    return sendJson(reply, result);
  } catch (error) {
    request.log.error(error, 'reconciliation run failed');
    return sendJson(reply, jsonResult(500, { error: 'reconciliation failed' }));
  }
}

export async function reconciliationRunDetailsController(request: FastifyRequest<ReconciliationDetailsRoute>, reply: FastifyReply) {
  if (!/^\d+$/.test(request.params.id)) return sendJson(reply, jsonResult(400, { error: 'invalid reconciliation run id' }));
  const report = await withTransaction(async (client) => {
    const run = await client.query('SELECT * FROM reconciliation_reports WHERE id=$1', [request.params.id]);
    if (!run.rowCount) return null;
    const findings = await client.query(
      `SELECT mismatch_type AS check_name,subject_id,expected_value,actual_value,transfer_id,account_id
         FROM reconciliation_mismatches WHERE report_id=$1 ORDER BY id`, [request.params.id],
    );
    return { ...run.rows[0], findings: findings.rows };
  });
  if (!report) return sendJson(reply, jsonResult(404, { error: 'reconciliation run not found' }));
  return reply.code(200).send(report);
}
