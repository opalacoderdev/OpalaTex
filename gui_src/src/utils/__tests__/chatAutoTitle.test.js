import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAutoTitleResult,
  detectLeftChat,
  isChatSurfaceVisible,
  isDefaultNewChatName,
} from '../chatAutoTitle.js';

test('isChatSurfaceVisible reflects visibility across all layout modes', () => {
  assert.equal(isChatSurfaceVisible({ layoutMode: 'chat', isChatVisible: false }), true);
  assert.equal(isChatSurfaceVisible({ layoutMode: 'chat', isChatVisible: true, isEditorMaximized: true }), false);
  assert.equal(isChatSurfaceVisible({ layoutMode: 'chat-bottom', isChatVisible: false, isBottomMaximized: false }), true);
  assert.equal(isChatSurfaceVisible({ layoutMode: 'chat-bottom', isChatVisible: true, isBottomMaximized: true }), false);
  assert.equal(isChatSurfaceVisible({ layoutMode: 'ide', isChatVisible: true }), true);
  assert.equal(isChatSurfaceVisible({ layoutMode: 'ide', isChatVisible: false }), false);
  assert.equal(isChatSurfaceVisible({ layoutMode: 'studio', isChatVisible: true }), true);
  assert.equal(isChatSurfaceVisible({ layoutMode: 'studio', isChatVisible: false }), false);
  assert.equal(isChatSurfaceVisible({ layoutMode: 'document', isChatVisible: true }), false);
  assert.equal(isChatSurfaceVisible({ layoutMode: 'review', isChatVisible: true }), false);
});

test('isDefaultNewChatName detects untouched default name vs custom user name', () => {
  assert.equal(isDefaultNewChatName('Chat 1', 'Chat 1'), true);
  assert.equal(isDefaultNewChatName('  Chat 2  ', 'Chat 2'), true);
  assert.equal(isDefaultNewChatName('Thesis Chapter 1', 'Chat 1'), false);
  assert.equal(isDefaultNewChatName('', 'Chat 1'), false);
  assert.equal(isDefaultNewChatName('Chat 1', ''), false);
});

test('detectLeftChat fires when switching chats, hiding chat panel, or switching projects', () => {
  const activePending = {
    projectName: 'proj-a',
    chatId: 'chat-1',
    isChatShown: true,
    autoTitlePending: true,
  };

  // Switching to another chat.
  assert.deepEqual(
    detectLeftChat(activePending, { ...activePending, chatId: 'chat-2', autoTitlePending: false }),
    { projectName: 'proj-a', chatId: 'chat-1' },
  );

  // Closing/hiding the chat panel while staying on the same chat.
  assert.deepEqual(
    detectLeftChat(activePending, { ...activePending, isChatShown: false }),
    { projectName: 'proj-a', chatId: 'chat-1' },
  );

  // Switching projects.
  assert.deepEqual(
    detectLeftChat(activePending, { projectName: 'proj-b', chatId: 'chat-9', isChatShown: true, autoTitlePending: false }),
    { projectName: 'proj-a', chatId: 'chat-1' },
  );
});

test('detectLeftChat ignores non-pending chats, deleted chats, and staying on the same chat', () => {
  const nonPending = {
    projectName: 'proj-a',
    chatId: 'chat-1',
    isChatShown: true,
    autoTitlePending: false,
  };
  assert.equal(detectLeftChat(nonPending, { ...nonPending, chatId: 'chat-2' }), null);

  const pending = { ...nonPending, autoTitlePending: true };
  // Staying on the same visible chat does not fire.
  assert.equal(detectLeftChat(pending, { ...pending }), null);
  // Opening the chat panel (false -> true) does not fire.
  assert.equal(detectLeftChat({ ...pending, isChatShown: false }, pending), null);
  // Deleting the active chat within the same project does not fire.
  assert.equal(
    detectLeftChat(pending, { ...pending, chatId: 'chat-2' }, { prevChatStillExistsInSameProject: false }),
    null,
  );
});

test('applyAutoTitleResult updates chat name and pending flag immutably', () => {
  const initial = [
    { id: 'c1', name: 'Chat 1', auto_title_pending: true },
    { id: 'c2', name: 'Other', auto_title_pending: false },
  ];

  // Empty chat stayed pending -> returns same reference (no-op).
  const unchanged = applyAutoTitleResult(initial, {
    chatId: 'c1',
    renamed: false,
    name: null,
    autoTitlePending: true,
  });
  assert.equal(unchanged, initial);

  // Renamed -> updates name and clears auto_title_pending.
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
});
