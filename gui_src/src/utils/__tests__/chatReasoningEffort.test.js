import test from 'node:test';
import assert from 'node:assert/strict';

import {
  catalogReasoning,
  chatReasoningEffort,
  normalizeChatReasoningEffort,
  withChatReasoningEffort,
} from '../chatReasoningEffort.js';

const CHATS = [
  { id: 'main_proj', name: 'Main Chat', reasoning_effort: '' },
  { id: 'c2', name: 'Review', reasoning_effort: 'low' },
  // A chat added locally before the list was refetched carries no field.
  { id: 'c3', name: 'Fresh' },
];

test('each chat reports its own effort and none means follow the catalog', () => {
  assert.equal(chatReasoningEffort(CHATS, 'c2'), 'low');
  assert.equal(chatReasoningEffort(CHATS, 'main_proj'), '');
  assert.equal(chatReasoningEffort(CHATS, 'c3'), '');
  assert.equal(chatReasoningEffort(CHATS, 'missing'), '');
  assert.equal(chatReasoningEffort(undefined, 'c2'), '');
});

test('a value no level names is not an override', () => {
  assert.equal(normalizeChatReasoningEffort(' HIGH '), 'high');
  assert.equal(normalizeChatReasoningEffort('none'), '');
  assert.equal(normalizeChatReasoningEffort('max'), '');
  assert.equal(normalizeChatReasoningEffort(null), '');
});

test('setting an effort touches only the chat it was set on', () => {
  const next = withChatReasoningEffort(CHATS, 'c3', 'high');
  assert.equal(chatReasoningEffort(next, 'c3'), 'high');
  assert.equal(chatReasoningEffort(next, 'c2'), 'low');
  assert.equal(next[0], CHATS[0]);
  assert.equal(chatReasoningEffort(CHATS, 'c3'), '');

  const cleared = withChatReasoningEffort(next, 'c2', '');
  assert.equal(chatReasoningEffort(cleared, 'c2'), '');
});

test('the catalog decides whether a model has an effort to change', () => {
  const models = [
    { id: 'ollama/glm:cloud', supports_thinking: true, reasoning_effort: 'high' },
    { id: 'openai/plain', supports_thinking: false, reasoning_effort: null },
  ];
  assert.deepEqual(catalogReasoning(models, 'ollama/glm:cloud'), { supportsThinking: true, effort: 'high' });
  assert.deepEqual(catalogReasoning(models, 'openai/plain'), { supportsThinking: false, effort: '' });
  assert.deepEqual(catalogReasoning(models, 'not/in-catalog'), { supportsThinking: false, effort: '' });
});
