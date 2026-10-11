import { FastifyInstance } from 'fastify';
import { createTransferController } from '../controllers/transfer_controller';
import { TransferRoute } from '../types/http';

export async function registerTransferRoutes(app: FastifyInstance) {
  app.post<TransferRoute>('/transfers', createTransferController);
}
