import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAutoTitleResult,
  isDefaultNewChatName,
  shouldAutoTitleAfterUserMessage,
} from '../chatAutoTitle.js';

test('isDefaultNewChatName detects untouched default name vs custom user name', () => {
  assert.equal(isDefaultNewChatName('Chat 1', 'Chat 1'), true);
  assert.equal(isDefaultNewChatName('  Chat 2  ', 'Chat 2'), true);
  assert.equal(isDefaultNewChatName('Thesis Chapter 1', 'Chat 1'), false);
  assert.equal(isDefaultNewChatName('', 'Chat 1'), false);
  assert.equal(isDefaultNewChatName('Chat 1', ''), false);
});

test('shouldAutoTitleAfterUserMessage returns true only for default-named pending chats', () => {
  const chats = [
    { id: 'c-default', name: 'Chat 1', auto_title_pending: true },
    { id: 'c-custom', name: 'My Thesis', auto_title_pending: false },
    { id: 'c-legacy', name: 'Old Chat' },
  ];

  assert.equal(shouldAutoTitleAfterUserMessage(chats, 'c-default'), true);
  assert.equal(shouldAutoTitleAfterUserMessage(chats, 'c-custom'), false);
  assert.equal(shouldAutoTitleAfterUserMessage(chats, 'c-legacy'), false);
  assert.equal(shouldAutoTitleAfterUserMessage(chats, 'missing'), false);
  assert.equal(shouldAutoTitleAfterUserMessage(chats, ''), false);
});

test('applyAutoTitleResult updates chat name and pending flag immutably', () => {
  const initial = [
    { id: 'c1', name: 'Chat 1', auto_title_pending: true },
    { id: 'c2', name: 'Other', auto_title_pending: false },
  ];

  const unchanged = applyAutoTitleResult(initial, {
    chatId: 'c1',
    renamed: false,
    name: null,
    autoTitlePending: true,
  });
  assert.equal(unchanged, initial);

  const renamed = applyAutoTitleResult(initial, {
    chatId: 'c1',
    renamed: true,
    name: 'LaTeX Table Alignment',
    autoTitlePending: false,
  });
  assert.deepEqual(renamed, [
    { id: 'c1', name: 'LaTeX Table Alignment', auto_title_pending: false },
    { id: 'c2', name: 'Other', auto_title_pending: false },
  ]);

  // On-demand auto-rename on a chat that was not pending updates its title too.
  const forcedRename = applyAutoTitleResult(renamed, {
    chatId: 'c2',
    renamed: true,
    name: 'Bibliography Fixes',
    autoTitlePending: false,
  });
  assert.deepEqual(forcedRename, [
    { id: 'c1', name: 'LaTeX Table Alignment', auto_title_pending: false },
    { id: 'c2', name: 'Bibliography Fixes', auto_title_pending: false },
  ]);
});
