export interface UserStatementRoute {
  Params: { id: string };
  Body: unknown;
  Headers: { 'idempotency-key'?: string };
}
