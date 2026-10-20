import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSse } from '../sse.js';
import { createThinkSplitter } from '../thinkSplitter.js';
import { streamOpenAiChat } from '../openai.js';
import { streamAnthropicChat, toAnthropicMessages } from '../anthropic.js';
import { ProviderError } from '../errors.js';
import { openAiChunks, sseTransport } from './helpers.js';

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test('SSE events survive arbitrary chunk boundaries and CRLF', async () => {
  async function* chunks() { yield 'event: a\r'; yield '\ndata: 1\r\n\r\ndata: x'; yield 'y\n\n: ping\n\ndata: tail'; }
  assert.deepEqual(await collect(parseSse(chunks())), [
    { event: 'a', data: '1' }, { event: 'message', data: 'xy' }, { event: 'message', data: 'tail' },
  ]);
});

test('think tags split across chunks go to reasoning', () => {
  let visible = '';
  let thinking = '';
  const splitter = createThinkSplitter({ onVisible: (t) => { visible += t; }, onThinking: (t) => { thinking += t; } });
  for (const chunk of ['Hi <th', 'ink>plan', ' it</thi', 'nk> done <']) splitter.feed(chunk);
  splitter.flush();
  assert.equal(visible, 'Hi  done <');
  assert.equal(thinking, 'plan it');
});

test('OpenAI-compatible streams assemble text, reasoning and tool calls', async () => {
  const transport = sseTransport([openAiChunks({
    content: 'Reading.', reasoning: 'need file', calls: [{ id: 'c1', name: 'read_file', args: { path: 'main.tex' } }],
  })]);
  let streamed = '';
  const result = await streamOpenAiChat({
    transport, baseUrl: 'https://api.example/v1/', apiKey: 'k', model: 'm',
    messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'read_file', description: 'd', parameters: {} }],
    onText: (t) => { streamed += t; },
  });
  assert.equal(result.content, 'Reading.');
  assert.equal(streamed, 'Reading.');
  assert.equal(result.reasoning, 'need file');
  assert.deepEqual(result.toolCalls, [{ id: 'c1', name: 'read_file', arguments: '{"path":"main.tex"}' }]);
  const [request] = transport.requests;
  assert.equal(request.url, 'https://api.example/v1/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer k');
  assert.equal(request.json.tools[0].function.name, 'read_file');
});

test('a provider error is reported with its status and message', async () => {
  const transport = sseTransport([{ status: 401, text: '{"error":{"message":"bad key"}}' }]);
  await assert.rejects(
    streamOpenAiChat({ transport, baseUrl: 'https://x/v1', model: 'm', messages: [] }),
    (error) => error instanceof ProviderError && error.status === 401 && /bad key/.test(error.message),
  );
});

test('tool history maps onto Anthropic content blocks', () => {
  const { system, messages } = toAnthropicMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'looking', tool_calls: [{ id: 't1', name: 'list_files', arguments: '{}' }, { id: 't2', name: 'read_file', arguments: '{"path":"a"}' }] },
    { role: 'tool', tool_call_id: 't1', content: 'a' },
    { role: 'tool', tool_call_id: 't2', content: 'text' },
  ]);
  assert.equal(system, 'sys');
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[1].content.map((b) => b.type), ['text', 'tool_use', 'tool_use']);
  assert.deepEqual(messages[1].content[2].input, { path: 'a' });
  assert.deepEqual(messages[2].content.map((b) => b.tool_use_id), ['t1', 't2']);
});

test('Anthropic streams assemble text, thinking and tool use', async () => {
  const transport = sseTransport([{ events: [
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 3 } } } },
    { data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
    { data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } },
    { data: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } },
    { data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me check.' } } },
    { data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu1', name: 'read_file' } } },
    { data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } } },
    { data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.tex"}' } } },
    { data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } } },
    { data: { type: 'message_stop' } },
  ] }]);
  const result = await streamAnthropicChat({
    transport, baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-x',
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }],
  });
  assert.equal(result.content, 'Let me check.');
  assert.equal(result.reasoning, 'hmm');
  assert.deepEqual(result.toolCalls, [{ id: 'tu1', name: 'read_file', arguments: '{"path":"a.tex"}' }]);
  assert.equal(result.finishReason, 'tool_use');
  const [request] = transport.requests;
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'k');
  assert.equal(request.json.system, 's');
  assert.equal(request.json.max_tokens, 8192);
});

test('a refusal page from in front of the API is summarised, not dumped', async () => {
  const transport = sseTransport([{ status: 403, text: '<!doctype html><meta charset="utf-8"><title>Forbidden</title>' }]);
  await assert.rejects(
    streamOpenAiChat({ transport, baseUrl: 'https://ollama.com/v1', model: 'm', messages: [] }),
    (error) => error.status === 403 && /HTTP 403: the request was refused before it reached the API/.test(error.message)
      && !error.message.includes('<'),
  );
});
