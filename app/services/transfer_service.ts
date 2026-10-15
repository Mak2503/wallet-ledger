import { createHash, randomUUID } from 'node:crypto';
import { withTransaction } from '../database';
import * as accounts from '../models/account_model';
import * as idempotency from '../models/idempotency_model';
import * as transferModel from '../models/transfer_model';
import * as riskModel from '../models/risk_model';
import { jsonResult, processingResult } from '../models/transfer';
import { Claim } from '../types/idempotency';
import { HttpResult, TransferRequest } from '../types/transfer';
import { ClaimOutcome } from '../types/transfer_service';
import { DatabaseError } from '../types/http';
import { FastifyBaseLogger } from 'fastify';

export async function executeTransfer(body: TransferRequest, key: string, logger?: FastifyBaseLogger): Promise<HttpResult> {
  const requestBody = {
    amount_paise: body.amount_paise,
    destination_account_id: body.destination_account_id,
    source_account_id: body.source_account_id,
    user_id: body.user_id,
    ...(body.note === undefined ? {} : { note: body.note }),
  };
  const requestHash = createHash('sha256').update(JSON.stringify(requestBody)).digest();
  let activeClaim: Claim | null = null;
  const claimToken = randomUUID();

  try {
    // Commit the processing claim separately so retries can observe it immediately.
    const claimOutcome = await withTransaction(async (client): Promise<ClaimOutcome> => {
      const inserted = await idempotency.insertClaim(client, body.user_id, key, requestHash, claimToken);
      if (inserted.rowCount) return { claim: { id: inserted.rows[0].id, token: claimToken } };

      const prior = (await idempotency.findKey(client, body.user_id, key)).rows[0];
      if (!prior.request_hash.equals(requestHash)) {
        return { result: jsonResult(422, { error: 'Idempotency-Key was already used with a different request' }) };
      }
      if (prior.status === 'completed' && prior.response_code !== null && prior.response_body !== null) {
        return { result: { statusCode: prior.response_code, serializedBody: prior.response_body } };
      }

      const leaseExpired = prior.processing_since !== null && Date.now() - prior.processing_since.getTime() >= 60_000;
      if (leaseExpired) {
        await client.query("SET LOCAL lock_timeout = '100ms'");
        const reclaimed = await idempotency.reclaimClaim(client, prior.id, claimToken);
        if (reclaimed.rowCount) return { claim: { id: prior.id, token: claimToken } };
        const row = (await idempotency.getSavedResponse(client, prior.id)).rows[0];
        if (row.status === 'completed' && row.response_code !== null && row.response_body !== null) {
          return { result: { statusCode: row.response_code, serializedBody: row.response_body } };
        }
      }
      return { result: processingResult() };
    });
    if (claimOutcome.result) return claimOutcome.result;
    activeClaim = claimOutcome.claim!;

    const result = await withTransaction(async (client): Promise<HttpResult> => {
      const claimRow = await idempotency.getClaimForUpdate(client, activeClaim!.id);
      if (claimRow.rows[0]?.status !== 'processing' || claimRow.rows[0]?.processing_token !== activeClaim!.token) {
        const current = (await idempotency.getSavedResponse(client, activeClaim!.id)).rows[0];
        if (current?.status === 'completed' && current.response_code !== null && current.response_body !== null) {
          return { statusCode: current.response_code, serializedBody: current.response_body };
        }
        return processingResult();
      }

      let response: HttpResult;
      let transferId: string | null = null;
      const accountIds = [body.source_account_id, body.destination_account_id].sort((a, b) => a - b);
      const locked = await accounts.lockAccounts(client, accountIds);
      if (locked.rowCount !== 2) {
        response = jsonResult(404, { error: 'account not found' });
      } else {
        const byId = new Map(locked.rows.map((row) => [Number(row.id), row]));
        const source = byId.get(body.source_account_id)!;
        const destination = byId.get(body.destination_account_id)!;
        if (Number(source.owner_user_id) !== body.user_id || source.kind !== 'wallet') {
          response = jsonResult(403, { error: 'source wallet does not belong to user' });
        } else if (destination.kind !== 'wallet') {
          response = jsonResult(400, { error: 'destination must be a wallet' });
        } else if (BigInt(source.balance_paise) < BigInt(body.amount_paise)) {
          response = jsonResult(409, { error: 'insufficient funds' });
        } else {
          const firedRules = await riskModel.evaluateRiskRules(client, body, (ruleKey, elapsedMs, fired) => {
            logger?.info({ rule_key: ruleKey, elapsed_ms: Number(elapsedMs.toFixed(3)), fired }, 'risk rule evaluated');
          });
          const held = firedRules.some((rule) => rule.action === 'hold');
          transferId = (await transferModel.createTransfer(client, body)).rows[0].id;
          const reviews = await riskModel.addFraudReviews(client, transferId, firedRules);
          await client.query("SELECT set_config('wallet.actor_user_id',$1,true)", [String(body.user_id)]);
          if (held) {
            await transferModel.holdTransfer(client, transferId);
            response = jsonResult(202, {
              transfer_id: transferId, status: 'held', amount_paise: body.amount_paise,
              flagged_rules: reviews.map(({ rule }) => rule.rule_key),
            });
          } else {
            await transferModel.succeedTransfer(client, transferId);
            await accounts.debit(client, body.source_account_id, body.amount_paise);
            await accounts.credit(client, body.destination_account_id, body.amount_paise);
            await transferModel.addTransferEntries(client, transferId, body.source_account_id, body.destination_account_id, body.amount_paise);
            response = jsonResult(201, {
              transfer_id: transferId, status: 'succeeded', amount_paise: body.amount_paise,
              ...(reviews.length ? { flagged_rules: reviews.map(({ rule }) => rule.rule_key) } : {}),
            });
          }
        }
      }
      await idempotency.completeClaim(client, activeClaim!.id, activeClaim!.token, response.statusCode, response.serializedBody, transferId);
      return response;
    });
    activeClaim = null;
    return result;
  } catch (error) {
    if ((error as DatabaseError).code === '55P03') return processingResult();
    if (activeClaim) {
      try {
        await withTransaction((client) => idempotency.failClaim(
          client, activeClaim!.id, activeClaim!.token,
          jsonResult(500, { error: 'transfer failed; transaction rolled back' }).serializedBody,
        ));
      } catch (finalizeError) {
        throw new AggregateError([error, finalizeError], 'Transfer failed and its idempotency claim could not be finalized');
      }
    }
    throw error;
  }
}
