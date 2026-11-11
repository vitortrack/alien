export type JsonSchemaProp = {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: object;
};

export interface ToolSpec {
  name: string;
  description: string;
  schema: {
    type: 'object';
    properties: Record<string, JsonSchemaProp>;
    required: string[];
  };
}

export type Input = Record<string, unknown>;

export interface ToolCall {
  id: string;
  name: string;
  input: Input;
}

export interface ToolResult {
  id: string;
  name: string;
  output: string;
  isError: boolean;
}

export interface Usage {
  input: number;
  output: number;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal';

export interface StepResult {
  text: string;
  toolCalls: ToolCall[];
  stop: StopReason;
  usage: Usage;
  compacted?: boolean;
}

export interface StepRequest {
  system: string;
  task?: string;
  changedFiles?: string[];
  tools: ToolSpec[];
  signal: AbortSignal;
  onText(delta: string): void;
  onThinking(delta: string): void;
}

export interface Image {
  mime: string;
  data: string;
}

export interface Provider {
  addUser(text: string, images?: Image[]): void;
  addToolResults(results: ToolResult[]): void;
  step(req: StepRequest): Promise<StepResult>;
  snapshot(): unknown;
  restore(state: unknown): void;
}
