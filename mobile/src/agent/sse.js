/**
 * Server-sent events, parsed from a stream of text chunks.
 *
 * Chunks arrive split at arbitrary points — mid-line, mid-character never
 * (the transport decodes UTF-8 first) — so lines are buffered until complete.
 */

/**
 * @param {AsyncIterable<string>} chunks
 * @returns {AsyncGenerator<{event: string, data: string}>}
 */
export async function* parseSse(chunks) {
  let buffer = '';
  let event = '';
  let data = [];
  const dispatch = function* () {
    if (data.length) yield { event: event || 'message', data: data.join('\n') };
    event = '';
    data = [];
  };
  for await (const chunk of chunks) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(buffer[newline] === '\r' ? newline + 2 : newline + 1);
      if (line === '') {
        yield* dispatch();
      } else if (line.startsWith(':')) {
        // comment / keep-alive
      } else {
        const colon = line.indexOf(':');
        const field = colon >= 0 ? line.slice(0, colon) : line;
        let value = colon >= 0 ? line.slice(colon + 1) : '';
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
    }
  }
  if (buffer) {
    // A stream that ends without its final blank line still carries an event.
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
  }
  yield* dispatch();
}
