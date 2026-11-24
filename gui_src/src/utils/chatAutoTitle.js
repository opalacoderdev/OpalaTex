// Helpers for automatic and on-demand chat titling.
//
// Two triggers share the same backend endpoint (`POST /api/chat/auto-title`):
// 1. Automatic: right after the user's first question in a chat that still
//    carries its default placeholder name (`auto_title_pending: true`).
// 2. On demand (`force: true`): when the user clicks the "Auto-rename" button
//    available on every chat to regenerate its title from the conversation.

/**
 * Return true when the user kept the suggested default name untouched.
 */
export function isDefaultNewChatName(submittedName, suggestedDefaultName) {
  const submitted = String(submittedName || '').trim();
  const suggested = String(suggestedDefaultName || '').trim();
  return Boolean(submitted) && Boolean(suggested) && submitted === suggested;
}

/**
 * Return true when saving a user message in `chatId` should trigger automatic
 * title generation (the chat still carries its initial default name).
 */
export function shouldAutoTitleAfterUserMessage(chats, chatId) {
  if (!Array.isArray(chats) || !chatId) return false;
  const chat = chats.find((c) => c.id === chatId);
  return Boolean(chat?.auto_title_pending);
}

/**
 * Apply the response of `POST /api/chat/auto-title` to the chats array.
 */
export function applyAutoTitleResult(chats, { chatId, renamed, name, autoTitlePending }) {
  if (!Array.isArray(chats) || !chatId) return chats;
  let changed = false;
  const next = chats.map((chat) => {
    if (chat.id !== chatId) return chat;
    const nextName = renamed && name ? name : chat.name;
    const nextPending = Boolean(autoTitlePending);
    if (nextName === chat.name && Boolean(chat.auto_title_pending) === nextPending) {
      return chat;
    }
    changed = true;
    return {
      ...chat,
      name: nextName,
      auto_title_pending: nextPending,
    };
  });
  return changed ? next : chats;
}
