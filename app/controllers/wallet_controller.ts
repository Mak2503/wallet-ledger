import { FastifyReply, FastifyRequest } from 'fastify';
import { withTransaction } from '../database';
import * as transferModel from '../models/transfer_model';
import * as walletModel from '../models/wallet_model';
import { jsonResult } from '../models/transfer';
import { executeIdempotentRequest, validIdempotencyKey } from '../services/request_idempotency_service';
import { createUser, createWallet, moveCash, reverseTransfer } from '../services/wallet_service';
import { IdempotentPostRoute, TransferDetailsRoute, TransferIdRoute, UserPostRoute, WalletRoute } from '../types/api_routes';
import { DatabaseError } from '../types/http';
import { UserCreateBody, WalletTransferBody } from '../types/wallet';
import { sendJson } from '../views/json_response';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function validWalletTransfer(value: unknown): value is WalletTransferBody {
  const body = asRecord(value);
  return !!body && Number.isSafeInteger(body.user_id) && Number(body.user_id) > 0 &&
    Number.isSafeInteger(body.wallet_id) && Number(body.wallet_id) > 0 &&
    Number.isSafeInteger(body.amount_paise) && Number(body.amount_paise) > 0 &&
    (body.note === undefined || (typeof body.note === 'string' && body.note.length <= 500));
}

async function checkKey(request: FastifyRequest<IdempotentPostRoute>, reply: FastifyReply): Promise<string | null> {
  const key = request.headers['idempotency-key'];
  if (!validIdempotencyKey(key)) {
    await sendJson(reply, jsonResult(400, { error: 'Idempotency-Key header must contain a UUID' }));
    return null;
  }
  return key.toLowerCase();
}

export async function createUserController(request: FastifyRequest<IdempotentPostRoute>, reply: FastifyReply) {
  const key = await checkKey(request, reply);
  if (!key) return reply;
  const body = asRecord(request.body);
  if (!body || !validText(body.name, 120) || !validText(body.email, 254) || !validText(body.phone, 40)) {
    return sendJson(reply, jsonResult(400, { error: 'name, email and phone are required' }));
  }
  const input: UserCreateBody = { name: body.name.trim(), email: body.email.trim(), phone: body.phone.trim() };
  try {
    const result = await executeIdempotentRequest('global:users', key, input, (client) => createUser(client, input));
    return sendJson(reply, result);
  } catch (error) {
    if ((error as DatabaseError).code === '23505') return sendJson(reply, jsonResult(409, { error: 'email or phone already exists' }));
    request.log.error(error);
    return sendJson(reply, jsonResult(500, { error: 'user could not be created' }));
  }
}

export async function createWalletController(request: FastifyRequest<UserPostRoute>, reply: FastifyReply) {
  const key = await checkKey(request, reply);
  if (!key) return reply;
  const userId = Number(request.params.id);
  const body = asRecord(request.body);
  if (!Number.isSafeInteger(userId) || userId <= 0 || (body?.name !== undefined && !validText(body.name, 120))) {
    return sendJson(reply, jsonResult(400, { error: 'invalid user id or wallet name' }));
  }
  const name = typeof body?.name === 'string' ? body.name.trim() : `Wallet for user ${userId}`;
  try {
    const result = await executeIdempotentRequest(`user:${userId}`, key, { name }, (client) => createWallet(client, userId, name));
    return sendJson(reply, result);
  } catch (error) {
    request.log.error(error);
    return sendJson(reply, jsonResult(500, { error: 'wallet could not be created' }));
  }
}

export async function walletBalanceController(request: FastifyRequest<WalletRoute>, reply: FastifyReply) {
  const walletId = Number(request.params.id);
  if (!Number.isSafeInteger(walletId) || walletId <= 0) return sendJson(reply, jsonResult(400, { error: 'invalid wallet id' }));
  const result = await withTransaction((client) => client.query(
    `SELECT id::text AS wallet_id,owner_user_id::text AS user_id,balance_paise::text
       FROM accounts WHERE id=$1 AND kind='wallet'`, [walletId],
  ));
  if (!result.rowCount) return sendJson(reply, jsonResult(404, { error: 'wallet not found' }));
  return reply.code(200).send(result.rows[0]);
}

function parseCursor(value?: string) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.created_at !== 'string' || !/^\d+$/.test(String(parsed.id)) || Number.isNaN(Date.parse(parsed.created_at))) return null;
    return { created_at: parsed.created_at, id: String(parsed.id) };
  } catch {
    return null;
  }
}

export async function walletStatementController(request: FastifyRequest<WalletRoute>, reply: FastifyReply) {
  const walletId = Number(request.params.id);
  const limit = Number(request.query.limit ?? 20);
  const offset = Number(request.query.offset ?? 0);
  const cursor = parseCursor(request.query.cursor);
  if (!Number.isSafeInteger(walletId) || walletId <= 0 || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(offset) || offset < 0 || cursor === null || (cursor && offset !== 0)) {
    return sendJson(reply, jsonResult(400, { error: 'invalid statement pagination' }));
  }
  const page = await withTransaction((client) => walletModel.getStatementPage(client, walletId, limit, offset, cursor));
  if (page.rows.length === 0 && !page.rowCount) {
    const wallet = await withTransaction((client) => client.query("SELECT 1 FROM accounts WHERE id=$1 AND kind='wallet'", [walletId]));
    if (!wallet.rowCount) return sendJson(reply, jsonResult(404, { error: 'wallet not found' }));
  }
  const hasMore = page.rows.length > limit;
  const entries = page.rows.slice(0, limit);
  const last = entries.at(-1);
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString('base64url')
    : null;
  return reply.code(200).send({ entries, limit, offset: cursor ? undefined : offset, next_cursor: nextCursor });
}

async function cashTransferController(request: FastifyRequest<IdempotentPostRoute>, reply: FastifyReply, direction: 'topup' | 'withdraw') {
  const key = await checkKey(request, reply);
  if (!key) return reply;
  if (!validWalletTransfer(request.body)) return sendJson(reply, jsonResult(400, { error: 'invalid wallet transfer request' }));
  const input = request.body;
  try {
    const result = await executeIdempotentRequest(`user:${input.user_id}`, key, input,
      (client) => moveCash(client, input, direction, direction === 'topup' ? 'top_up' : 'withdrawal'));
    return sendJson(reply, result);
  } catch (error) {
    request.log.error(error);
    return sendJson(reply, jsonResult(500, { error: 'wallet transfer failed' }));
  }
}

export function topupController(request: FastifyRequest<IdempotentPostRoute>, reply: FastifyReply) {
  return cashTransferController(request, reply, 'topup');
}

export function withdrawalController(request: FastifyRequest<IdempotentPostRoute>, reply: FastifyReply) {
  return cashTransferController(request, reply, 'withdraw');
}

export async function reverseTransferController(request: FastifyRequest<TransferIdRoute>, reply: FastifyReply) {
  const key = await checkKey(request, reply);
  if (!key) return reply;
  if (!/^\d+$/.test(request.params.id)) return sendJson(reply, jsonResult(400, { error: 'invalid transfer id' }));
  try {
    const result = await executeIdempotentRequest(`transfer:${request.params.id}`, key, { transfer_id: request.params.id, reverse: true },
      (client) => reverseTransfer(client, request.params.id));
    return sendJson(reply, result);
  } catch (error) {
    request.log.error(error);
    return sendJson(reply, jsonResult(500, { error: 'transfer could not be reversed' }));
  }
}

export async function transferDetailsController(request: FastifyRequest<TransferDetailsRoute>, reply: FastifyReply) {
  if (!/^\d+$/.test(request.params.id)) return sendJson(reply, jsonResult(400, { error: 'invalid transfer id' }));
  const result = await withTransaction((client) => transferModel.getTransferDetails(client, request.params.id));
  if (!result.rowCount) return sendJson(reply, jsonResult(404, { error: 'transfer not found' }));
  return reply.code(200).send(result.rows[0]);
}
