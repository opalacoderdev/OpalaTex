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
 * error text anyway, and an invented answer would be worse than none.
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
 * @param {string} options.text
 */
export async function runChatTurn({
  session, chat, text, complete, tools, approve, onEvent = () => {}, signal, language, today, device,
}) {
  let target = chat;
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
  const history = buildHistory(target.messages || []);

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
