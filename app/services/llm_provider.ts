import { LlmJsonProvider } from '../types/llm';

export class MockLlmProvider implements LlmJsonProvider {
  readonly modelName = 'mock-fixed-json';
  readonly requests: Array<{ systemPrompt: string; input: unknown }> = [];

  constructor(private readonly fixedResponses: unknown[] = []) {}

  async completeJson(systemPrompt: string, input: unknown): Promise<unknown> {
    this.requests.push({ systemPrompt, input });
    return this.fixedResponses.shift() ?? {};
  }
}

export class HttpLlmProvider implements LlmJsonProvider {
  constructor(
    readonly modelName: string,
    private readonly endpoint: string,
    private readonly apiKey?: string,
  ) {}

  async completeJson(systemPrompt: string, input: unknown): Promise<unknown> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.modelName, system_prompt: systemPrompt, input, response_format: 'json' }),
    });
    if (!response.ok) throw new Error(`LLM provider returned HTTP ${response.status}`);
    const result = await response.json() as { output?: unknown; content?: string };
    const output = result.output ?? result.content;
    if (typeof output === 'string') return JSON.parse(output) as unknown;
    return output;
  }
}

let configuredProvider: LlmJsonProvider | undefined;

export function getLlmProvider(): LlmJsonProvider {
  if (configuredProvider) return configuredProvider;
  const endpoint = process.env.LLM_ENDPOINT;
  configuredProvider = endpoint
    ? new HttpLlmProvider(process.env.LLM_MODEL ?? 'configured-model', endpoint, process.env.LLM_API_KEY)
    : new MockLlmProvider();
  return configuredProvider;
}

export function setLlmProviderForTests(provider: LlmJsonProvider | undefined) {
  configuredProvider = provider;
}
