/**
 * Anthropic Messages API with streaming and tool use.
 *
 * The app's internal history is in the OpenAI shape (assistant `tool_calls`,
 * `tool` results). Anthropic carries the same information as content blocks:
 * `tool_use` inside the assistant turn and `tool_result` inside the next user
 * turn, with consecutive results in one user message.
 */

import { parseSse } from './sse.js';
import { ProviderError } from './errors.js';

export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;

export function toAnthropicMessages(messages) {
  const system = [];
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const message of messages) {
    if (message.role === 'system') {
      system.push(message.content);
    } else if (message.role === 'user') {
      push('user', [{ type: 'text', text: message.content }]);
    } else if (message.role === 'assistant') {
      const blocks = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls || []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: safeJson(call.arguments) });
      }
      if (blocks.length) push('assistant', blocks);
    } else if (message.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }]);
    }
  }
  return { system: system.join('\n\n'), messages: out };
}

function safeJson(text) {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export async function streamAnthropicChat({
  transport, baseUrl, apiKey, model, messages, tools = [], params = {}, signal, onText, onReasoning,
}) {
  const { system, messages: wire } = toAnthropicMessages(messages);
  const { max_tokens: maxTokens, ...rest } = params;
  const body = {
    model,
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    messages: wire,
    stream: true,
    ...rest,
  };
  if (system) body.system = system;
  if (tools.length) {
    body.tools = tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  }
  const response = await transport({
    url: `${baseUrl.replace(/\/+$/, '')}/v1/messages`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      // Required by the API for requests from a browser origin; the in-app
      // web view during development is one.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (response.status < 200 || response.status >= 300) {
    throw await ProviderError.fromResponse(response, 'anthropic');
  }

  let content = '';
  let reasoning = '';
  let finishReason = '';
  let usage = null;
  const blocks = new Map();
  for await (const { data } of parseSse(response.body)) {
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    switch (payload.type) {
      case 'content_block_start': {
        const block = payload.content_block || {};
        blocks.set(payload.index, { type: block.type, id: block.id, name: block.name, json: '' });
        break;
      }
      case 'content_block_delta': {
        const delta = payload.delta || {};
        if (delta.type === 'text_delta') { content += delta.text; onText?.(delta.text); }
        else if (delta.type === 'thinking_delta') { reasoning += delta.thinking; onReasoning?.(delta.thinking); }
        else if (delta.type === 'input_json_delta') {
          const block = blocks.get(payload.index);
          if (block) block.json += delta.partial_json || '';
        }
        break;
      }
      case 'message_start':
        usage = payload.message?.usage || usage;
        break;
      case 'message_delta':
        if (payload.delta?.stop_reason) finishReason = payload.delta.stop_reason;
        if (payload.usage) usage = { ...(usage || {}), ...payload.usage };
        break;
      case 'error':
        throw new ProviderError(payload.error?.message || 'The model provider reported an error.', { provider: 'anthropic' });
      default:
        break;
    }
  }
  const toolCalls = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => block)
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({ id: block.id, name: block.name, arguments: block.json || '{}' }));
  return { content, reasoning, toolCalls, finishReason, usage };
}
