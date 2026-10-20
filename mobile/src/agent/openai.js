/**
 * OpenAI-compatible chat completions with streaming and tool calls.
 *
 * One adapter covers OpenAI, OpenRouter, Gemini's OpenAI endpoint, Ollama
 * (local or ollama.com), DeepSeek, Groq, Mistral and any compatible server —
 * the same wire format litellm speaks to them on the desktop.
 */

import { parseSse } from './sse.js';
import { createThinkSplitter } from './thinkSplitter.js';
import { ProviderError } from './errors.js';

/**
 * @param {object} options
 * @param {(req: object) => Promise<{status: number, body: AsyncIterable<string>, text: () => Promise<string>}>} options.transport
 */
export async function streamOpenAiChat({
  transport, baseUrl, apiKey, model, messages, tools = [], params = {}, signal, onText, onReasoning,
}) {
  const body = {
    model,
    messages: messages.map(toWireMessage),
    stream: true,
    ...params,
  };
  if (tools.length) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await transport({
    url: `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (response.status < 200 || response.status >= 300) {
    throw await ProviderError.fromResponse(response, 'openai');
  }

  let content = '';
  let reasoning = '';
  let finishReason = '';
  let usage = null;
  const calls = [];
  const splitter = createThinkSplitter({
    onVisible: (text) => { content += text; onText?.(text); },
    onThinking: (text) => { reasoning += text; onReasoning?.(text); },
  });

  for await (const { data } of parseSse(response.body)) {
    if (data === '[DONE]') break;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    if (payload.error) throw new ProviderError(payload.error.message || JSON.stringify(payload.error), { provider: 'openai' });
    if (payload.usage) usage = payload.usage;
    const choice = payload.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    const thinking = delta.reasoning_content ?? delta.reasoning ?? '';
    if (thinking) { reasoning += thinking; onReasoning?.(thinking); }
    if (delta.content) splitter.feed(delta.content);
    for (const part of delta.tool_calls || []) {
      const index = part.index ?? calls.length;
      if (!calls[index]) calls[index] = { id: '', name: '', arguments: '' };
      if (part.id) calls[index].id = part.id;
      if (part.function?.name) calls[index].name += part.function.name;
      if (part.function?.arguments) calls[index].arguments += part.function.arguments;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  splitter.flush();

  const toolCalls = calls.filter(Boolean).map((call, index) => ({
    id: call.id || `call_${index}`,
    name: call.name,
    arguments: call.arguments || '{}',
  }));
  return { content, reasoning, toolCalls, finishReason, usage };
}

function toWireMessage(message) {
  if (message.role === 'assistant' && message.tool_calls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.tool_calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content };
  }
  return { role: message.role, content: message.content };
}
