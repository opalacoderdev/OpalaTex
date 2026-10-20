import test from 'node:test';
import assert from 'node:assert/strict';
import { listProviderModels, resolveChoice } from '../providers.js';
import { effectiveModel, withModelChoice } from '../../project/settings.js';
import { sseTransport } from './helpers.js';

const connections = [
  { id: 'a', provider: 'openai', name: 'Work', baseUrl: '', models: ['gpt-4o-mini', 'gpt-4o'] },
  { id: 'b', provider: 'custom', name: 'LAN', baseUrl: 'https://llm.example/v1', models: ['qwen3:8b'] },
  { id: 'c', provider: 'custom', name: 'No address', baseUrl: '', models: ['x'] },
];

test('a pick resolves by connection id, so two servers of one kind stay apart', () => {
  const resolved = resolveChoice({ connectionId: 'b', model: 'qwen3:8b' }, connections);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.baseUrl, 'https://llm.example/v1');
  assert.equal(resolved.protocol, 'openai');
  assert.equal(resolveChoice({ connectionId: 'a', model: 'gpt-4o' }, connections).baseUrl, 'https://api.openai.com/v1');
  assert.equal(resolveChoice({ connectionId: 'gone', model: 'm' }, connections).reason, 'connection-removed');
  assert.equal(resolveChoice({ connectionId: 'c', model: 'x' }, connections).reason, 'no-base-url');
});

test('a chat runs on its own pick, else the project\'s last pick, else the desktop model', () => {
  const projectSettings = { model: 'openai/gpt-4o' };
  let settings = { chatModels: {}, projectModels: {} };
  assert.deepEqual(effectiveModel(settings, 'root', 'chat-1', projectSettings), { kind: 'project', modelId: 'openai/gpt-4o' });

  settings = withModelChoice(settings, 'root', 'chat-1', { connectionId: 'b', model: 'qwen3:8b' });
  assert.deepEqual(effectiveModel(settings, 'root', 'chat-1', projectSettings).choice, { connectionId: 'b', model: 'qwen3:8b' });
  // A new chat in the same project starts with the last pick…
  assert.deepEqual(effectiveModel(settings, 'root', null, projectSettings).choice, { connectionId: 'b', model: 'qwen3:8b' });

  settings = withModelChoice(settings, 'root', 'chat-2', { connectionId: 'a', model: 'gpt-4o-mini' });
  // …and a chat keeps its own pick when another chat picks something else.
  assert.equal(effectiveModel(settings, 'root', 'chat-1', projectSettings).choice.model, 'qwen3:8b');
  assert.equal(effectiveModel(settings, 'root', 'chat-2', projectSettings).choice.model, 'gpt-4o-mini');
  assert.deepEqual(effectiveModel(settings, 'other-project', null, projectSettings), { kind: 'project', modelId: 'openai/gpt-4o' });
});

test('a model id string saved by the first version is still honoured', () => {
  const settings = { chatModels: {}, projectModels: { root: 'anthropic/claude-x' } };
  assert.deepEqual(effectiveModel(settings, 'root', null, { model: 'openai/gpt-4o' }), { kind: 'project', modelId: 'anthropic/claude-x' });
});

test('OpenAI-compatible model lists are read from /models', async () => {
  const transport = sseTransport([{ text: JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'a-model' }] }) }]);
  const models = await listProviderModels({ connection: connections[1], apiKey: 'k', transport });
  assert.deepEqual(models, ['a-model', 'b-model']);
  assert.equal(transport.requests[0].url, 'https://llm.example/v1/models');
  assert.equal(transport.requests[0].headers.Authorization, 'Bearer k');
});

test('Anthropic model lists are read from /v1/models with its headers', async () => {
  const transport = sseTransport([{ text: JSON.stringify({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }) }]);
  const models = await listProviderModels({ connection: { id: 'z', provider: 'anthropic', baseUrl: '' }, apiKey: 'k', transport });
  assert.deepEqual(models, ['claude-x']);
  assert.equal(transport.requests[0].url, 'https://api.anthropic.com/v1/models');
  assert.equal(transport.requests[0].headers['x-api-key'], 'k');
});

test('a refused model list reports the provider\'s answer', async () => {
  const transport = sseTransport([{ status: 401, text: '{"error":"invalid key"}' }]);
  await assert.rejects(listProviderModels({ connection: connections[0], apiKey: 'bad', transport }), /HTTP 401.*invalid key/);
});
