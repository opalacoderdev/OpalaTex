import test from 'node:test';
import assert from 'node:assert/strict';

import { isLocalModelId, isOllamaCloudModel } from '../models.js';

test('ollama models without an api base are local', () => {
  assert.ok(isLocalModelId('ollama/llama3.2'));
  assert.ok(isLocalModelId('ollama_chat/qwen2.5', ''));
});

test('an ollama api base on this machine is local', () => {
  assert.ok(isLocalModelId('ollama/llava', 'http://localhost:11434'));
  assert.ok(isLocalModelId('ollama/llava', 'http://127.0.0.1:11434'));
  assert.ok(isLocalModelId('ollama/llava', 'http://0.0.0.0:11434'));
});

test('a remote ollama host is not local', () => {
  assert.ok(!isLocalModelId('ollama/llava', 'https://ollama.example.com'));
});

test('cloud providers are never local', () => {
  assert.ok(!isLocalModelId('anthropic/claude-opus-5'));
  assert.ok(!isLocalModelId('openai/gpt-4o', 'http://localhost:1234'));
  assert.ok(!isLocalModelId(''));
  assert.ok(!isLocalModelId('llama3.2'));
});

test('ollama cloud ids are not local', () => {
  assert.ok(isOllamaCloudModel('ollama/gpt-oss:cloud'));
  assert.ok(!isLocalModelId('ollama/gpt-oss:cloud'));
  assert.ok(!isLocalModelId('ollama_chat/deepseek-v3-cloud'));
});
