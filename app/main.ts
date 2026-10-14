import Fastify from 'fastify';
import { pool } from './database';
import { registerTransferRoutes } from './routes/transfer_routes';
import { registerAdminRoutes } from './routes/admin_routes';
import { startReconciliationScheduler } from './jobs/reconciliation_scheduler';

const app = Fastify({ logger: true });

app.get('/health', async (_request, reply) => {
  await pool.query('SELECT 1');
  return reply.send({ status: 'ok' });
});

app.register(registerTransferRoutes);
app.register(registerAdminRoutes);
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
