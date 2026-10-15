export interface LlmJsonProvider {
  readonly modelName: string;
  completeJson(systemPrompt: string, input: unknown): Promise<unknown>;
}

export interface StatementQuestion {
  type: 1 | 2 | 3 | 4;
  counterparty?: string;
  from: string;
  to: string;
}

export interface StatementAnswer {
  type: StatementQuestion['type'];
  value: string;
  transfer_ids: string[];
}
