import { FastifyReply, FastifyRequest } from 'fastify';
import { jsonResult } from '../models/transfer';
import { executeIdempotentRequest, validIdempotencyKey } from '../services/request_idempotency_service';
import { answerQuestion, unsupportedQuestionMessage } from '../services/statement_qa_service';
import { UserStatementRoute } from '../types/statement_http';
import { sendJson } from '../views/json_response';

export async function statementAskController(request: FastifyRequest<UserStatementRoute>, reply: FastifyReply) {
  const userId = Number(request.params.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return sendJson(reply, jsonResult(400, { error: 'invalid user id' }));
  if (!validIdempotencyKey(request.headers['idempotency-key'])) {
    return sendJson(reply, jsonResult(400, { error: 'Idempotency-Key header must contain a UUID' }));
  }
  if (typeof request.body !== 'object' || request.body === null || typeof (request.body as Record<string, unknown>).question !== 'string') {
    return sendJson(reply, jsonResult(400, { error: 'question must be a string' }));
  }
  const question = (request.body as { question: string }).question.trim();
  if (!question || question.length > 2000) return sendJson(reply, jsonResult(400, { error: 'question must contain 1 to 2000 characters' }));
  try {
    const result = await executeIdempotentRequest(`user:${userId}`, request.headers['idempotency-key'], { question }, async (client) => {
      const answer = await answerQuestion(client, userId, question);
      return answer.supported
        ? jsonResult(200, { ...answer.answer })
        : jsonResult(422, { error: unsupportedQuestionMessage });
    });
    return sendJson(reply, result);
  } catch (error) {
    request.log.error(error);
    return sendJson(reply, jsonResult(500, { error: 'statement question could not be answered' }));
  }
}
