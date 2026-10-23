/**
 * One chat turn on the phone, from the user's message to the stored answer.
 *
 * What is written, and in what order, is what the desktop expects to read:
 *
 *   user message      → journal, before the model is called, so a turn that
 *                        fails still leaves the question in the history
 *   reasoning + steps → one `thought` activity row, timestamped before the
 *                        answer so the desktop pairs it with that answer
 *   answer            → journal, `client_message_id` set like the user's
 *
 * A failed turn stores no assistant message: the desktop's seeding skips
 * error text anyway, and an invented answer would be worse than none. The
 * question it leaves unanswered can be answered again (`retry`), which stores
 * only the new answer — as the desktop's "Try again" does.
 *
 * A journal can add rows but never supersede one (chats_export.md §4.2), so an
 * answer that exists is not replaced: retrying or editing an earlier turn
 * continues in a branch, a new chat holding a copy of the conversation up to
 * that point — the desktop's own "Branch from here".
 */

import { buildHistory, buildSystemPrompt } from '../agent/context.js';
import { runAgentTurn } from '../agent/loop.js';
import { nowIso } from '../lib/timestamps.js';
import { newId } from './keys.js';

export const MOBILE_AGENT = 'mobile_agent';

export function chatNameFrom(text) {
  const words = String(text).trim().split(/\s+/).slice(0, 6).join(' ');
  return words.length > 48 ? `${words.slice(0, 47)}…` : words || 'New chat';
}

/**
 * @param {object} options
 * @param {object} options.session      project session (session.js)
 * @param {object|null} options.chat    the conversation's chat, or null for a new chat
 * @param {string} [options.text]       the new message; ignored when retrying
 * @param {boolean} [options.retry]     answer the chat's last message, a stored
 *                                      question with no answer, instead of a new one
 */
export async function runChatTurn({
  session, chat, text, retry = false, complete, tools, approve, onEvent = () => {}, signal, language, today, device,
}) {
  let target = chat;
  let earlier = target?.messages || [];
  if (retry) {
    const question = earlier[earlier.length - 1];
    if (question?.role !== 'user') throw new Error('Only a last message that has no answer can be tried again.');
    text = question.content;
    earlier = earlier.slice(0, -1);
  }
  if (!target) {
    target = { id: newId(), name: chatNameFrom(text), created_at: nowIso(), messages: [], agent_state: '{}', core_memory: '' };
    await session.createChat(target);
    onEvent({ type: 'chat_created', chat: target });
  }

  const conversation = await session.conversation();
  const prompt = buildSystemPrompt({
    projectName: session.projectName,
    settings: conversation.settings,
    chat: target,
    today,
    language,
  });
  const history = buildHistory(earlier);

  if (!retry) {
    const userMessage = {
      chat_id: target.id,
      timestamp: nowIso(),
      role: 'user',
      content: text,
      client_message_id: newId(),
      attachments: '[]',
    };
    await session.appendMessage(userMessage);
    onEvent({ type: 'user_saved', message: userMessage });
    session.push().catch(() => {});
  }

  const result = await runAgentTurn({
    complete,
    messages: [{ role: 'system', content: prompt }, ...history, { role: 'user', content: text }],
    tools,
    approve,
    onEvent,
    signal,
  });

  const thoughts = [result.reasoning, ...result.progress.map((line) => `• ${line}`)].filter(Boolean).join('\n');
  if (thoughts) {
    await session.appendActivity({
      chat_id: target.id,
      timestamp: nowIso(),
      event: 'thought',
      agent: MOBILE_AGENT,
      content: thoughts,
      payload: JSON.stringify({ agent: MOBILE_AGENT, device: device?.name || '' }),
    });
  }
  const answer = {
    chat_id: target.id,
    timestamp: nowIso(),
    role: 'assistant',
    content: result.content,
    client_message_id: newId(),
    attachments: '[]',
  };
  await session.appendMessage(answer);
  onEvent({ type: 'assistant_saved', message: answer });

  let uploaded = true;
  try {
    await session.push();
  } catch {
    // Kept locally; the next sync uploads it.
    uploaded = false;
  }
  return { chat: target, answer, uploaded };
}

/**
 * Start a new chat from a copy of `messages`, the first messages of `source`.
 *
 * Copies keep their timestamps, as the desktop's branch does, and get their
 * own `client_message_id` (a journal row must carry one). Each copied answer's
 * reasoning travels as one `thought` row at the answer's own timestamp, which
 * pairs it with that answer. Attachments are not copied: a device writes text
 * only (chats_export.md §6). Nothing is uploaded here; the turn that follows,
 * or the next sync, does that.
 *
 * Returns the new chat with its messages, ready to be passed to runChatTurn.
 */
export async function branchChat({ session, messages, name, device }) {
  const chat = { id: newId(), name, created_at: nowIso(), agent_state: '{}', core_memory: '' };
  const copies = [];
  const thoughts = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    copies.push({
      chat_id: chat.id,
      timestamp: message.timestamp,
      role: message.role,
      content: message.content,
      client_message_id: newId(),
      attachments: '[]',
    });
    if (message.role === 'assistant' && message.thoughts) {
      thoughts.push({
        chat_id: chat.id,
        timestamp: message.timestamp,
        event: 'thought',
        agent: MOBILE_AGENT,
        content: message.thoughts,
        payload: JSON.stringify({ agent: MOBILE_AGENT, device: device?.name || '' }),
      });
    }
  }
  await session.appendChat({ chat, messages: copies, activity: thoughts });
  return { ...chat, messages: copies };
}
