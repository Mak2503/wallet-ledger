import { FastifyInstance } from 'fastify';
import { statementAskController } from '../controllers/statement_qa_controller';
import { UserStatementRoute } from '../types/statement_http';

export async function registerStatementRoutes(app: FastifyInstance) {
  app.post<UserStatementRoute>('/users/:id/statement/ask', statementAskController);
}
