export interface IdempotentPostRoute {
  Body: unknown;
  Headers: { 'idempotency-key'?: string };
}

export interface UserPostRoute extends IdempotentPostRoute {
  Params: { id: string };
}

export interface WalletRoute {
  Params: { id: string };
  Querystring: { limit?: string; offset?: string; cursor?: string };
}

export interface TransferDetailsRoute {
  Params: { id: string };
}

export interface RiskDecisionRoute extends IdempotentPostRoute {
  Params: { transfer_id: string };
}

export interface ReconciliationPostRoute {
  Headers: { 'idempotency-key'?: string };
}

export interface ReconciliationDetailsRoute {
  Params: { id: string };
}

export interface TransferIdRoute extends IdempotentPostRoute {
  Params: { id: string };
}
