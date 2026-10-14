import { FastifyReply, FastifyRequest } from 'fastify';
import { runReconciliation } from '../services/reconciliation_service';

export async function runReconciliationController(_request: FastifyRequest, reply: FastifyReply) {
  try {
    const result = await runReconciliation();
    if (result.status === 'already_running') {
      return reply.code(409).send({ status: result.status, message: 'reconciliation is already running' });
    }
    return reply.code(200).send(result);
  } catch (error) {
    _request.log.error(error, 'reconciliation run failed');
    return reply.code(500).send({ status: 'failed', message: 'reconciliation failed' });
  }
}
