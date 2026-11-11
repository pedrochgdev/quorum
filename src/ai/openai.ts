// Adapt the shared agent messages to the stateless OpenAI Responses API.
import { config } from '../config.ts';
import type { ApiReply, ContentBlock, JsonSchema, LlmUsage, Message } from './llm.ts';

type ResponseItem = {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
  [key: string]: unknown;
};

type ModelRequest = {
  model: string;
  max_tokens: number;
  system: string;
  messages: Message[];
  output_config?: { format?: { schema: JsonSchema } };
  tools?: { name: string; description: string; input_schema: JsonSchema }[];
};

/** OpenAI strict output requires every property, with null for optional values. */
function outputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(outputSchema);
  if (!value || typeof value !== 'object') return value;
  const source = value as JsonSchema;
  const result = Object.fromEntries(Object.entries(source).map(([key, child]) => [key, outputSchema(child)]));
  if (source.type === 'object') {
    const properties = (result.properties ?? {}) as Record<string, unknown>;
    const required = new Set((source.required ?? []) as string[]);
    for (const key of Object.keys(properties)) {
      if (!required.has(key)) properties[key] = { anyOf: [properties[key], { type: 'null' }] };
    }
    result.properties = properties;
    result.additionalProperties = false;
    result.required = Object.keys(properties);
  }
  return result;
}

function inputItems(messages: Message[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      items.push({ role: message.role, content: message.content });
      continue;
    }
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          items.push({ role: message.role, content: block.text });
          break;
        case 'tool_use':
          items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
          break;
        case 'tool_result':
          items.push({ type: 'function_call_output', call_id: block.tool_use_id, output: block.content });
          break;
        case 'openai_reasoning':
          items.push(block.item as Record<string, unknown>);
          break;
      }
    }
  }
  return items;
}

export async function callOpenAI(request: Record<string, unknown>, usage: LlmUsage): Promise<ApiReply> {
  const body = request as ModelRequest;
  const format = body.output_config?.format;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.openai.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: body.model,
      instructions: body.system,
      input: inputItems(body.messages),
      max_output_tokens: body.max_tokens,
      reasoning: { effort: 'low' },
      store: false,
      include: ['reasoning.encrypted_content'],
      ...(format ? { text: { format: { type: 'json_schema', name: 'result', strict: true, schema: outputSchema(format.schema) } } } : {}),
      ...(body.tools ? {
        tools: body.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
          strict: false,
        })),
        tool_choice: 'auto',
      } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await response.json().catch(() => ({})) as {
    status?: string;
    output?: ResponseItem[];
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { code?: string };
  };
  if (!response.ok || json.error || json.status === 'failed') {
    throw new Error('OpenAI ' + response.status + ': ' + (json.error?.code ?? 'request failed'));
  }
  usage.calls++;
  usage.inputTokens += json.usage?.input_tokens ?? 0;
  usage.outputTokens += json.usage?.output_tokens ?? 0;
  if (json.status === 'incomplete') return { content: [], stopReason: 'max_tokens' };

  const content: ContentBlock[] = [];
  let stopReason: string | null = null;
  for (const item of json.output ?? []) {
    if (item.type === 'reasoning') {
      content.push({ type: 'openai_reasoning', item });
    } else if (item.type === 'function_call') {
      content.push({ type: 'tool_use', id: item.call_id!, name: item.name!, input: JSON.parse(item.arguments ?? '{}') });
    } else if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'refusal') stopReason = 'refusal';
        if (part.type === 'output_text') content.push({ type: 'text', text: part.text ?? '' });
      }
    }
  }
  return { content, stopReason };
}
