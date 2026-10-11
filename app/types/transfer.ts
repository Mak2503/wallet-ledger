export interface TransferRequest {
  user_id: number;
  source_account_id: number;
  destination_account_id: number;
  amount_paise: number;
}

export interface HttpResult {
  statusCode: number;
  serializedBody: string;
  retryAfter?: boolean;
}
