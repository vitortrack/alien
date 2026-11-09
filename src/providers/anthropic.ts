import Anthropic from '@anthropic-ai/sdk';
import type { Provider, StepRequest, StepResult, ToolResult } from '../types.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export class AnthropicProvider implements Provider {
  private readonly client = new Anthropic();
  private readonly history: Anthropic.Beta.BetaMessageParam[] = [];

  constructor(
    private readonly model: string,
    private readonly effort: Effort,
  ) {}

  addUser(text: string): void {
    this.history.push({ role: 'user', content: text });
  }

  addToolResults(results: ToolResult[]): void {
    this.history.push({
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.output, is_error: r.isError })),
    });
  }

  async step(req: StepRequest): Promise<StepResult> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: this.effort },
        cache_control: { type: 'ephemeral' },
        system: req.system,
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
        messages: this.history,
      },
      { signal: req.signal },
    );
    stream.on('text', req.onText);
    stream.on('thinking', req.onThinking);
    const message = await stream.finalMessage();
    this.history.push({ role: 'assistant', content: message.content });

    const toolCalls = message.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const stopMap: Record<string, StepResult['stop']> = { refusal: 'refusal', max_tokens: 'max_tokens', tool_use: 'tool_use' };
    return {
      text,
      toolCalls,
      stop: stopMap[message.stop_reason ?? ''] ?? 'end',
      usage: {
        input: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0),
        output: message.usage.output_tokens,
      },
    };
  }
}
