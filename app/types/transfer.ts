export interface TransferRequest {
  user_id: number;
  source_account_id: number;
  destination_account_id: number;
  amount_paise: number;
  note?: string;
}

export type ReversalTransferRequest = Pick<TransferRequest, 'amount_paise' | 'source_account_id' | 'destination_account_id' | 'note'>;

export interface HttpResult {
  statusCode: number;
  serializedBody: string;
  retryAfter?: boolean;
}
