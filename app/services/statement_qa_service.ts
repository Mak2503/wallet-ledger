import { PoolClient } from 'pg';
import { answerStatementQuestion } from '../models/statement_model';
import { StatementQuestion } from '../types/llm';
import { getLlmProvider } from './llm_provider';

export const unsupportedQuestionMessage = 'I can only answer four kinds of statement questions: total sent to a person, total received in a date range, largest transfer, or transfer count in a date range.';

const questionPrompt = [
  'Convert the question into only a JSON object with keys type, counterparty, from, to.',
  'type must be 1 total sent to a person, 2 total received from a person, 3 largest transfer, or 4 transfer count.',
  'Use ISO dates YYYY-MM-DD. counterparty is optional except when the question names a person.',
  'Do not generate SQL, facts, or any other fields.',
].join(' ');

function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

export function validateStatementQuestion(value: unknown): StatementQuestion | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.type !== 'number' || ![1, 2, 3, 4].includes(candidate.type) || !validDate(candidate.from) || !validDate(candidate.to) || candidate.from > candidate.to) return null;
  if (candidate.counterparty !== undefined && (typeof candidate.counterparty !== 'string' || candidate.counterparty.trim().length === 0 || candidate.counterparty.length > 120)) return null;
  const type = Number(candidate.type) as StatementQuestion['type'];
  if (type === 1 && typeof candidate.counterparty !== 'string') return null;
  return {
    type,
    from: candidate.from,
    to: candidate.to,
    ...(typeof candidate.counterparty === 'string' ? { counterparty: candidate.counterparty.trim() } : {}),
  };
}

export async function answerQuestion(client: PoolClient, userId: number, question: string) {
  const provider = getLlmProvider();
  let parsed: unknown;
  try {
    parsed = await provider.completeJson(questionPrompt, { question });
  } catch {
    parsed = null;
  }
  const validated = validateStatementQuestion(parsed);
  if (!validated) return { supported: false as const, message: unsupportedQuestionMessage };
  return { supported: true as const, answer: await answerStatementQuestion(client, userId, validated) };
}
