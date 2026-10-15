export interface RiskRule {
  id: string;
  rule_key: string;
  name: string;
  threshold: string;
  window_seconds: number | null;
  period_seconds: number | null;
  action: 'hold' | 'allow_with_flag';
  description: string;
  enabled: boolean;
}

export interface FiredRiskRule extends RiskRule {}

export interface RiskQueueItem {
  transfer_id: string;
  status: string;
  amount_paise: string;
  note: string | null;
  source_account_id: string | null;
  destination_account_id: string | null;
  source_wallet: string | null;
  destination_wallet: string | null;
  rule_name: string;
  rule_key: string;
  action: string;
  flagged_at: Date;
}

export interface FlagHistoryItem {
  transfer_id: string;
  created_at: Date;
  amount_paise: string;
  note: string | null;
  status: string;
}

export interface RiskFlagExplanation {
  label: 'likely_ok' | 'review' | 'likely_fraud';
  explanation: string;
}
