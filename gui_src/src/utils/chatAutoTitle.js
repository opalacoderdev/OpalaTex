// Helpers for automatic first-leave chat titling.
//
// When a chat is created without changing its default placeholder name, the
// backend marks it `auto_title_pending: true`. The first time the user leaves
// that chat (switches chats, creates another chat, hides the chat panel,
// switches projects, or closes the window), the front-end asks the backend to
// summarize the conversation into a concise title.

/**
 * Return true when the active chat surface is currently visible on screen.
 * Mirrors the ChatPanel mount conditions in App.jsx across all layouts.
 */
export function isChatSurfaceVisible({
  layoutMode,
  isChatVisible,
  isEditorMaximized = false,
  isBottomMaximized = false,
}) {
  if (layoutMode === 'chat') return !isEditorMaximized;
  if (layoutMode === 'chat-bottom') return !isBottomMaximized;
  if (layoutMode === 'ide' || layoutMode === 'studio') {
    return Boolean(isChatVisible) && !isEditorMaximized;
  }
  return false;
}

/**
 * Return true when the user kept the suggested default name untouched.
 */
export function isDefaultNewChatName(submittedName, suggestedDefaultName) {
  const submitted = String(submittedName || '').trim();
  const suggested = String(suggestedDefaultName || '').trim();
  return Boolean(submitted) && Boolean(suggested) && submitted === suggested;
}

/**
 * Detect whether transitioning from `prev` to `next` means the user just left
 * `prev.chatId`.
 *
 * Each snapshot has shape:
 * `{ projectName: string, chatId: string, isChatShown: boolean, autoTitlePending: boolean }`.
 *
 * `prevChatStillExistsInSameProject` guards against firing an auto-title
 * request when the user deleted the active chat (in which case `chatId` changed
 * only because `prev.chatId` was removed).
 */
export function detectLeftChat(prev, next, { prevChatStillExistsInSameProject = true } = {}) {
  if (!prev || !prev.projectName || !prev.chatId || !prev.autoTitlePending) {
    return null;
  }
  const nextProject = next?.projectName || '';
  const nextChat = next?.chatId || '';

  // 1. Switched to another project or closed the active project.
  if (prev.projectName !== nextProject) {
    return { projectName: prev.projectName, chatId: prev.chatId };
  }

  // Within the same project, a deleted chat has nothing left to rename.
  if (!prevChatStillExistsInSameProject) {
    return null;
  }

  // 2. Switched to another chat (including creating a new chat, branching, or opening tutorial).
  if (prev.chatId !== nextChat) {
    return { projectName: prev.projectName, chatId: prev.chatId };
  }

  // 3. Closed or hid the chat surface while remaining on the same project and chat.
  if (prev.isChatShown && !next?.isChatShown) {
    return { projectName: prev.projectName, chatId: prev.chatId };
  }

  return null;
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
