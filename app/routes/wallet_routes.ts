import { FastifyInstance } from 'fastify';
import {
  createUserController,
  createWalletController,
  reverseTransferController,
  topupController,
  transferDetailsController,
  walletBalanceController,
  walletStatementController,
  withdrawalController,
} from '../controllers/wallet_controller';
import { IdempotentPostRoute, TransferDetailsRoute, TransferIdRoute, UserPostRoute, WalletRoute } from '../types/api_routes';

export async function registerWalletRoutes(app: FastifyInstance) {
  app.post<IdempotentPostRoute>('/users', createUserController);
  app.post<UserPostRoute>('/users/:id/wallets', createWalletController);
  app.get<WalletRoute>('/wallets/:id/balance', walletBalanceController);
  app.get<WalletRoute>('/wallets/:id/statement', walletStatementController);
  app.post<IdempotentPostRoute>('/transfers/topup', topupController);
  app.post<IdempotentPostRoute>('/transfers/withdraw', withdrawalController);
  app.post<TransferIdRoute>('/transfers/:id/reverse', reverseTransferController);
  app.get<TransferDetailsRoute>('/transfers/:id', transferDetailsController);
}
