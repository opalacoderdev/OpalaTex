/**
 * The phone's own settings: model connections, per-project model choice, and
 * this device's identity. API keys are kept apart, in the native secret store,
 * keyed by connection id; nothing else here is secret.
 */

import { newId } from './keys.js';

const SETTINGS_KEY = 'settings';

export function defaultSettings() {
  return {
    device: { id: newId(), name: 'Android' },
    // {id, provider, name, baseUrl, models: [model names]}
    connections: [],
    // chat id -> {connectionId, model}: the model a chat runs on, on the phone.
    chatModels: {},
    // project root -> {connectionId, model}: the last model picked in that
    // project, which new chats start with.
    projectModels: {},
    // project root -> true: every viewable file is kept on the phone.
    offlineProjects: {},
    language: '',
  };
}

export async function loadSettings(kv) {
  const stored = await kv.get(SETTINGS_KEY);
  if (stored?.device?.id) return { ...defaultSettings(), ...stored };
  const fresh = defaultSettings();
  await kv.set(SETTINGS_KEY, fresh);
  return fresh;
}

export async function saveSettings(kv, settings) {
  await kv.set(SETTINGS_KEY, settings);
  return settings;
}

export function apiKeyName(connectionId) {
  return `apiKey.${connectionId}`;
}

export async function getApiKey(plugin, connectionId) {
  const { value } = await plugin.secureGet({ key: apiKeyName(connectionId) });
  return value || '';
}

export async function setApiKey(plugin, connectionId, value) {
  if (value) await plugin.secureSet({ key: apiKeyName(connectionId), value });
  else await plugin.secureRemove({ key: apiKeyName(connectionId) });
}

/**
 * The model a chat runs on: what was picked for this chat, else the last pick
 * in this project, else the model the desktop project names (resolved by its
 * provider prefix). Earlier versions stored a model id string per project;
 * such a value is read as a project model id, not as a pick.
 */
export function effectiveModel(settings, projectRoot, chatId, projectSettings) {
  const chosen = (chatId && settings.chatModels?.[chatId]) || settings.projectModels?.[projectRoot];
  if (chosen && typeof chosen === 'object' && chosen.model) return { kind: 'choice', choice: chosen };
  const modelId = (typeof chosen === 'string' && chosen) || projectSettings?.model || '';
  return { kind: 'project', modelId };
}

/** Record a pick for a chat (when there is one) and as the project's default for new chats. */
export function withModelChoice(settings, projectRoot, chatId, choice) {
  return {
    ...settings,
    chatModels: chatId ? { ...settings.chatModels, [chatId]: choice } : settings.chatModels,
    projectModels: { ...settings.projectModels, [projectRoot]: choice },
  };
}
