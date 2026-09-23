import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPACT_CHAT_LAYOUTS,
  chatCompactStorageKey,
  compactChatLayoutFor,
  readChatCompact,
  writeChatCompact,
} from '../chatCompact.js';

const memoryStorage = () => {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
};

test('only the studio layout offers the compact chat', () => {
  assert.deepEqual(COMPACT_CHAT_LAYOUTS, ['studio']);
  assert.equal(compactChatLayoutFor('studio'), 'studio');
  for (const mode of ['ide', 'chat', 'chat-bottom', 'document', 'review', undefined]) {
    assert.equal(compactChatLayoutFor(mode), null);
  }
});

test('the compact chat is the default in a layout that offers it', () => {
  assert.equal(readChatCompact('studio', memoryStorage()), true);
});

test('a layout without a compact chat is never compact, whatever is stored', () => {
  const storage = memoryStorage();
  storage.setItem(chatCompactStorageKey('ide'), 'true');
  assert.equal(readChatCompact('ide', storage), false);
  assert.equal(readChatCompact(null, storage), false);
});

test('the preference round-trips and is kept per layout', () => {
  const storage = memoryStorage();
  writeChatCompact('studio', false, storage);
  assert.equal(readChatCompact('studio', storage), false);
  writeChatCompact('studio', true, storage);
  assert.equal(readChatCompact('studio', storage), true);
  writeChatCompact('ide', false, storage);
  assert.equal(storage.data.has(chatCompactStorageKey('ide')), false);
});

test('unavailable storage falls back to the default instead of throwing', () => {
  const broken = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  assert.equal(readChatCompact('studio', broken), true);
  assert.doesNotThrow(() => writeChatCompact('studio', false, broken));
  assert.equal(readChatCompact('studio', null), true);
});
