// The chat shows the most recent agent reasoning up to a size in tokens
// (editor settings -> thought_context_tokens). Nothing is dropped from storage;
// this only decides what is on screen.
//
// Each chunk carries `tokens`: the backend's running token count of the turn's
// reasoning, including that chunk. Chunks without it (older activity) fall back
// to an estimate of four characters per token.

export const DEFAULT_THOUGHT_CONTEXT_TOKENS = 32000;

const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

export const createThoughtTail = () => ({ chunks: [], startTokens: 0, lastTokens: 0, omittedTokens: 0 });

// Append a chunk and keep only the most recent chunks within `limit` tokens.
export const appendThoughtChunk = (state, content, tokens, limit) => {
  const text = String(content || '');
  if (!text) return state;
  const end = Number.isFinite(tokens) && tokens > state.lastTokens
    ? tokens
    : state.lastTokens + estimateTokens(text);
  const chunks = [...state.chunks, { text, end }];
  // A chunk starts where the previous one ended; the first kept chunk starts at
  // the tokens already omitted.
  const startOf = (index) => (index === 0 ? state.startTokens : chunks[index - 1].end);
  let first = 0;
  while (first < chunks.length - 1 && end - startOf(first) > limit) first += 1;
  const omittedTokens = startOf(first);
  return { chunks: chunks.slice(first), startTokens: omittedTokens, lastTokens: end, omittedTokens };
};

export const thoughtTailText = (state) => state.chunks.map(chunk => chunk.text).join('');

// Build the visible tail of a finished list of chunks ({ content, tokens }).
export const tailThoughtChunks = (items, limit) => {
  let state = createThoughtTail();
  for (const item of items || []) {
    state = appendThoughtChunk(state, item.content, item.tokens, limit);
  }
  return state;
};

// Estimate-only tail for plain text (the Output panel merges text without counts).
export const tailTextByTokens = (text, limit) => {
  const value = String(text || '');
  const maxChars = Math.max(1, limit) * 4;
  if (value.length <= maxChars) return { text: value, omittedTokens: 0 };
  return { text: value.slice(value.length - maxChars), omittedTokens: estimateTokens(value.slice(0, value.length - maxChars)) };
};

export const clampThoughtContextTokens = (value) => {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_THOUGHT_CONTEXT_TOKENS;
  return Math.max(1000, Math.min(1000000, n));
};
