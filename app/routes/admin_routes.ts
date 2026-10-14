import { FastifyInstance } from 'fastify';
import { runReconciliationController } from '../controllers/reconciliation_controller';

export async function registerAdminRoutes(app: FastifyInstance) {
  app.post('/admin/reconciliation/run', runReconciliationController);
}
