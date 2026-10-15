import Fastify from 'fastify';
import { pool } from './database';
import { registerTransferRoutes } from './routes/transfer_routes';
import { registerAdminRoutes } from './routes/admin_routes';
import { startReconciliationScheduler } from './jobs/reconciliation_scheduler';
import { registerStatementRoutes } from './routes/statement_routes';
import { registerWalletRoutes } from './routes/wallet_routes';
import { validIdempotencyKey } from './services/request_idempotency_service';
import { jsonResult } from './models/transfer';
import { sendJson } from './views/json_response';
import { RequestError } from './types/http';

const app = Fastify({ logger: true });

app.setNotFoundHandler((request, reply) => sendJson(reply, jsonResult(404, { error: `route ${request.method} ${request.url} not found` })));
app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  const requestError = error as RequestError;
  const status = requestError.statusCode && requestError.statusCode >= 400 ? requestError.statusCode : 500;
  return sendJson(reply, jsonResult(status, { error: status >= 500 ? 'internal server error' : requestError.message }));
});

app.addHook('preHandler', async (request, reply) => {
  if (request.method === 'POST' && !validIdempotencyKey(request.headers['idempotency-key'])) {
    return sendJson(reply, jsonResult(400, { error: 'Idempotency-Key header must contain a UUID' }));
  }
});

app.get('/health', async (_request, reply) => {
  await pool.query('SELECT 1');
  return reply.send({ status: 'ok' });
});

app.register(registerTransferRoutes);
app.register(registerAdminRoutes);
app.register(registerStatementRoutes);
app.register(registerWalletRoutes);
app.addHook('onClose', async () => pool.end());
const stopReconciliationScheduler = startReconciliationScheduler(app.log);
app.addHook('onClose', async () => stopReconciliationScheduler());

const port = Number(process.env.PORT ?? 8000);
const host = process.env.HOST ?? '0.0.0.0';
app.listen({ host, port }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.close().catch((error) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}
