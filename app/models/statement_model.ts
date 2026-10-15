import { PoolClient } from 'pg';
import { StatementAnswer, StatementQuestion } from '../types/llm';

interface AggregateResult {
  value: string;
  transfer_ids: string[];
}

export async function answerStatementQuestion(
  client: PoolClient,
  userId: number,
  question: StatementQuestion,
): Promise<StatementAnswer> {
  const rows = await client.query<AggregateResult>(
    `WITH transfer_accounts AS (
       SELECT t.id,t.created_at,t.amount_paise,t.status,t.note,
              min(e.account_id) FILTER (WHERE e.direction='debit') AS source_id,
              min(e.account_id) FILTER (WHERE e.direction='credit') AS destination_id
         FROM transfers t JOIN ledger_entries e ON e.transfer_id=t.id
        WHERE t.created_at >= $2::date AND t.created_at < ($3::date + interval '1 day')
        GROUP BY t.id
     ), involved AS (
       SELECT ta.*,src.owner_user_id AS source_user_id,dst.owner_user_id AS destination_user_id,
              COALESCE(src_user.name,src.name) AS source_name,
              COALESCE(dst_user.name,dst.name) AS destination_name
         FROM transfer_accounts ta
         JOIN accounts src ON src.id=ta.source_id
         JOIN accounts dst ON dst.id=ta.destination_id
         LEFT JOIN users src_user ON src_user.id=src.owner_user_id
         LEFT JOIN users dst_user ON dst_user.id=dst.owner_user_id
        WHERE ($1::bigint=src.owner_user_id OR $1::bigint=dst.owner_user_id)
          AND ta.status IN ('succeeded','reversed')
          AND ($4::text IS NULL OR
               ($5::int=1 AND COALESCE(dst_user.name,dst.name) ILIKE $4) OR
               ($5::int=2 AND COALESCE(src_user.name,src.name) ILIKE $4))
     ), selected AS (
       SELECT * FROM involved
        WHERE ($5::int=1 AND source_user_id=$1)
           OR ($5::int=2 AND destination_user_id=$1)
           OR $5::int IN (3,4)
     )
     SELECT CASE $5
              WHEN 1 THEN COALESCE(sum(amount_paise),0)::text
              WHEN 2 THEN COALESCE(sum(amount_paise),0)::text
              WHEN 3 THEN COALESCE((array_agg(amount_paise ORDER BY amount_paise DESC,created_at DESC,id DESC))[1],0)::text
              WHEN 4 THEN count(*)::text
            END AS value,
            CASE WHEN count(*)=0 THEN ARRAY[]::text[]
              WHEN $5::int=3 THEN ARRAY[(array_agg(id::text ORDER BY amount_paise DESC,created_at DESC,id DESC))[1]]
              ELSE COALESCE(array_agg(id::text ORDER BY created_at DESC,id DESC),ARRAY[]::text[])
            END AS transfer_ids
       FROM selected`,
    [userId, question.from, question.to, question.counterparty ? `%${question.counterparty}%` : null, question.type],
  );
  return { type: question.type, value: rows.rows[0].value, transfer_ids: rows.rows[0].transfer_ids };
}
