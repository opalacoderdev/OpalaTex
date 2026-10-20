/**
 * Which endpoint answers a model, and how the project's model id maps to it.
 *
 * Projects name their model the way the desktop's litellm does —
 * `openai/gpt-4o`, `anthropic/claude-…`, `ollama/qwen3:8b`,
 * `openrouter/anthropic/claude-…`. The prefix selects a connection the user
 * configured on the phone (API keys never travel with the project: `.env` is
 * not mirrored). The rest is the model name sent to that connection.
 */

import { streamAnthropicChat } from './anthropic.js';
import { streamOpenAiChat } from './openai.js';

export const PROVIDER_PRESETS = {
  openai: { protocol: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  anthropic: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true },
  gemini: { protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true },
  openrouter: { protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true },
  ollama: { protocol: 'openai', baseUrl: 'https://ollama.com/v1', needsKey: false },
  deepseek: { protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', needsKey: true },
  groq: { protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true },
  mistral: { protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1', needsKey: true },
  xai: { protocol: 'openai', baseUrl: 'https://api.x.ai/v1', needsKey: true },
  custom: { protocol: 'openai', baseUrl: '', needsKey: false },
};

// litellm prefixes that are spellings of a provider above.
const PREFIX_ALIASES = {
  ollama_chat: 'ollama',
  google: 'gemini',
  vertex_ai: 'gemini',
  mistralai: 'mistral',
};

/** Split `provider/model` the way litellm does: at the first slash. */
export function parseModelId(modelId) {
  const text = String(modelId || '').trim();
  const slash = text.indexOf('/');
  if (slash < 0) return { provider: '', model: text };
  const prefix = text.slice(0, slash).toLowerCase();
  return { provider: PREFIX_ALIASES[prefix] || prefix, model: text.slice(slash + 1) };
}

/**
 * Resolve a model id against the configured connections.
 *
 * Fails with a reason instead of picking some other connection: answering on a
 * provider the user did not choose would bill an account they did not mean to
 * use and run a model they did not pick.
 */
export function resolveModel(modelId, connections) {
  const { provider, model } = parseModelId(modelId);
  if (!model) return { ok: false, reason: 'no-model' };
  if (!provider) return { ok: false, reason: 'no-provider', model };
  const connection = connections.find((candidate) => candidate.provider === provider);
  if (!connection) return { ok: false, reason: 'no-connection', provider, model };
  const preset = PROVIDER_PRESETS[connection.provider] || PROVIDER_PRESETS.custom;
  const baseUrl = connection.baseUrl || preset.baseUrl;
  if (!baseUrl) return { ok: false, reason: 'no-base-url', provider, model };
  return { ok: true, provider, model, connection, protocol: preset.protocol, baseUrl };
}

/**
 * Resolve a model the user picked on the phone: a model name on a specific
 * connection. Addressed by connection id rather than provider prefix, so two
 * connections of one kind (two OpenAI-compatible servers) stay distinct.
 */
export function resolveChoice(choice, connections) {
  if (!choice?.model) return { ok: false, reason: 'no-model' };
  const connection = connections.find((candidate) => candidate.id === choice.connectionId);
  if (!connection) return { ok: false, reason: 'connection-removed', model: choice.model };
  const preset = PROVIDER_PRESETS[connection.provider] || PROVIDER_PRESETS.custom;
  const baseUrl = connection.baseUrl || preset.baseUrl;
  if (!baseUrl) return { ok: false, reason: 'no-base-url', provider: connection.provider, model: choice.model };
  return { ok: true, provider: connection.provider, model: choice.model, connection, protocol: preset.protocol, baseUrl };
}

/**
 * The models a connection offers, from the provider's own listing:
 * `GET {base}/models` on OpenAI-compatible servers (Ollama included),
 * `GET {base}/v1/models` on Anthropic. Ids are returned as the provider
 * spells them; that spelling is what a request must carry.
 */
export async function listProviderModels({ connection, apiKey, transport }) {
  const preset = PROVIDER_PRESETS[connection.provider] || PROVIDER_PRESETS.custom;
  const base = (connection.baseUrl || preset.baseUrl).replace(/\/+$/, '');
  if (!base) throw new Error('The connection has no address.');
  const anthropic = preset.protocol === 'anthropic';
  const headers = anthropic
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
    : (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
  const response = await transport({ url: anthropic ? `${base}/v1/models` : `${base}/models`, method: 'GET', headers });
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The provider answered HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('The provider did not return a model list.');
  }
  const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const ids = items.map((item) => (typeof item === 'string' ? item : item?.id || item?.name || '')).filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** A completion function bound to one resolved model. */
export function createCompletion({ resolved, apiKey, transport, params = {} }) {
  const stream = resolved.protocol === 'anthropic' ? streamAnthropicChat : streamOpenAiChat;
  return (request) => stream({
    transport,
    baseUrl: resolved.baseUrl,
    apiKey,
    model: resolved.model,
    params,
    ...request,
  });
}

/**
 * Generation parameters the phone honours from the project's `model_params`.
 * Desktop-only switches (`force_vision`, `stream`) are not request fields.
 */
export function portableParams(modelParamsText) {
  let params = {};
  try {
    params = JSON.parse(modelParamsText || '{}') || {};
  } catch {
    params = {};
  }
  const out = {};
  for (const key of ['temperature', 'top_p', 'max_tokens']) {
    if (typeof params[key] === 'number') out[key] = params[key];
  }
  return out;
}
