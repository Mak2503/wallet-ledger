export interface UserCreateBody {
  name: string;
  email: string;
  phone: string;
}

export interface WalletCreateBody {
  name?: string;
}

export interface WalletTransferBody {
  user_id: number;
  wallet_id: number;
  amount_paise: number;
  note?: string;
}

export interface WalletStatementRow {
  id: string;
  transfer_id: string;
  direction: string;
  amount_paise: string;
  // Keep PostgreSQL timestamp precision intact when the value is reused as a cursor.
  created_at: string;
  transfer_type: string;
  transfer_status: string;
  note: string | null;
}

export interface WalletBalanceRow {
  wallet_id: string;
  user_id: string;
  balance_paise: string;
}

export interface PaginationCursor {
  created_at: string;
  id: string;
}
