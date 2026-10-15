import { FastifyInstance } from 'fastify';
import { reconciliationRunDetailsController, runReconciliationController } from '../controllers/reconciliation_controller';
import { riskDecisionController, riskQueueController } from '../controllers/risk_controller';
import { ReconciliationDetailsRoute } from '../types/api_routes';

export async function registerAdminRoutes(app: FastifyInstance) {
  app.post('/admin/reconciliation/run', runReconciliationController);
  app.get<ReconciliationDetailsRoute>('/admin/reconciliation/runs/:id', reconciliationRunDetailsController);
  app.get('/admin/risk/queue', riskQueueController);
  app.post('/admin/risk/:transfer_id/decision', riskDecisionController);
}
