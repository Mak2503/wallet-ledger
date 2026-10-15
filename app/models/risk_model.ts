import { PoolClient } from 'pg';
import { performance } from 'node:perf_hooks';
import { FiredRiskRule, FlagHistoryItem, RiskQueueItem } from '../types/risk';
import { TransferRequest } from '../types/transfer';

export async function evaluateRiskRules(
  client: PoolClient,
  request: TransferRequest,
  recordTiming?: (ruleKey: string, elapsedMs: number, fired: boolean) => void,
): Promise<FiredRiskRule[]> {
  const rules = (await client.query<FiredRiskRule>(
    `SELECT id::text,rule_key,name,threshold::text,window_seconds,period_seconds,action::text,description,enabled
       FROM risk_rules WHERE enabled=true ORDER BY id`,
  )).rows;
  const fired: FiredRiskRule[] = [];
  for (const rule of rules) {
    const startedAt = performance.now();
    let matched = false;
    if (rule.rule_key === 'velocity_10m') {
      const count = await client.query<{ fires: boolean }>(
        `SELECT count(DISTINCT t.id)+1 > $2::numeric AS fires FROM transfers t
          WHERE (t.source_account_id=$1 OR (t.source_account_id IS NULL AND EXISTS(
            SELECT 1 FROM ledger_entries e WHERE e.transfer_id=t.id AND e.account_id=$1 AND e.direction='debit')))
            AND t.status IN ('succeeded','held') AND t.created_at >= now()-($3::int*interval '1 second')`,
        [request.source_account_id, rule.threshold, rule.window_seconds],
      );
      matched = count.rows[0].fires;
    } else if (rule.rule_key === 'amount_spike_30d') {
      const average = await client.query<{ average: string | null; fires: boolean }>(
        `SELECT avg(amount_paise)::text AS average,
                $2::numeric > $3::numeric * avg(amount_paise) AS fires
           FROM transfers t WHERE (t.source_account_id=$1 OR (t.source_account_id IS NULL AND EXISTS(
             SELECT 1 FROM ledger_entries e WHERE e.transfer_id=t.id AND e.account_id=$1 AND e.direction='debit')))
             AND t.status='succeeded' AND t.created_at >= now()-($4::int*interval '1 second')`,
        [request.source_account_id, request.amount_paise, rule.threshold, rule.period_seconds],
      );
      matched = average.rows[0].average !== null && average.rows[0].fires;
    } else if (rule.rule_key === 'new_payee_large') {
      const prior = await client.query<{ fires: boolean }>(
        `SELECT NOT EXISTS(SELECT 1 FROM transfers t WHERE t.status IN ('succeeded','held') AND (
          (t.source_account_id=$1 AND t.destination_account_id=$2) OR
          (t.source_account_id IS NULL AND EXISTS(SELECT 1 FROM ledger_entries d WHERE d.transfer_id=t.id AND d.account_id=$1 AND d.direction='debit')
            AND EXISTS(SELECT 1 FROM ledger_entries c WHERE c.transfer_id=t.id AND c.account_id=$2 AND c.direction='credit'))))
          AND $3::numeric > $4::numeric AS fires`,
        [request.source_account_id, request.destination_account_id, request.amount_paise, rule.threshold],
      );
      matched = prior.rows[0].fires;
    }
    if (matched) fired.push(rule);
    recordTiming?.(rule.rule_key, performance.now() - startedAt, matched);
  }
  return fired;
}

export async function addFraudReviews(client: PoolClient, transferId: string, rules: FiredRiskRule[]) {
  const inserted: Array<{ id: string; rule: FiredRiskRule }> = [];
  for (const rule of rules) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO fraud_reviews(transfer_id,risk_rule_id,status)
       VALUES($1,$2,'pending') RETURNING id::text`, [transferId, rule.id],
    );
    inserted.push({ id: result.rows[0].id, rule });
  }
  return inserted;
}

export async function getRiskQueue(client: PoolClient) {
  return client.query<RiskQueueItem>(
    `SELECT fr.transfer_id::text, t.status::text, t.amount_paise::text, t.note,
            t.source_account_id::text, t.destination_account_id::text,
            src.name AS source_wallet, dst.name AS destination_wallet,
            rr.name AS rule_name, rr.rule_key, rr.action::text, fr.flagged_at
       FROM fraud_reviews fr
       JOIN transfers t ON t.id=fr.transfer_id
       JOIN risk_rules rr ON rr.id=fr.risk_rule_id
       LEFT JOIN accounts src ON src.id=t.source_account_id
       LEFT JOIN accounts dst ON dst.id=t.destination_account_id
      WHERE fr.status='pending'
      ORDER BY fr.flagged_at ASC, fr.id ASC`,
  );
}

export async function getDailyUnexplainedFlags(client: PoolClient) {
  return client.query<{
    id: string; transfer_id: string; rule_key: string; rule_name: string; description: string;
    source_account_id: string; note: string | null; amount_paise: string; history: FlagHistoryItem[];
  }>(
    `SELECT fr.id::text, fr.transfer_id::text, rr.rule_key, rr.name AS rule_name,
            rr.description, t.source_account_id::text, t.note, t.amount_paise::text,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'transfer_id', recent.id::text, 'created_at', recent.created_at,
                'amount_paise', recent.amount_paise::text, 'note', recent.note, 'status', recent.status::text
              ) ORDER BY recent.created_at DESC, recent.id DESC)
                FROM (SELECT x.id,x.created_at,x.amount_paise,x.note,x.status
                        FROM transfers x WHERE x.source_account_id=t.source_account_id
                       ORDER BY x.created_at DESC,x.id DESC LIMIT 10) recent
            ),'[]'::jsonb) AS history
       FROM fraud_reviews fr JOIN transfers t ON t.id=fr.transfer_id
       JOIN risk_rules rr ON rr.id=fr.risk_rule_id
       LEFT JOIN risk_flags rf ON rf.fraud_review_id=fr.id
      WHERE rf.id IS NULL
      ORDER BY fr.flagged_at,fr.id`,
  );
}

export async function saveRiskExplanation(
  client: PoolClient,
  reviewId: string,
  transferId: string,
  explanation: string,
  label: string,
  modelName: string,
) {
  await client.query(
    `INSERT INTO risk_flags(fraud_review_id,transfer_id,label,explanation,model_name)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT(fraud_review_id) DO NOTHING`,
    [reviewId, transferId, label, explanation, modelName],
  );
}
