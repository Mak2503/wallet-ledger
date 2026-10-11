import { Claim } from './idempotency';
import { HttpResult } from './transfer';

export interface ClaimOutcome {
  claim?: Claim;
  result?: HttpResult;
}
