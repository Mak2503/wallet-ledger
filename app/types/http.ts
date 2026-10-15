export interface TransferRoute {
  Body: unknown;
  Headers: {
    'idempotency-key'?: string;
  };
}

export interface DatabaseError extends Error {
  code?: string;
}

export interface RequestError extends Error {
  statusCode?: number;
}
