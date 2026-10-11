export interface Claim {
  id: string;
  token: string;
}

export interface ExistingKey {
  id: string;
  request_hash: Buffer;
  status: string;
  response_code: number | null;
  response_body: string | null;
  processing_since: Date | null;
}

export interface SavedResponse {
  status: string;
  response_code: number | null;
  response_body: string | null;
}

export interface LockedClaim {
  status: string;
  processing_token: string | null;
}
