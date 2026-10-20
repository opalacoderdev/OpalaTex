/**
 * Streaming HTTP for the model providers.
 *
 * Shape: `transport({url, method, headers, body, signal})` resolves to
 * `{status, headers, body, text}` where `body` is an async iterable of decoded
 * text chunks. `fetchTransport` is the browser's; `nativeTransport` goes
 * through the plugin, whose callback delivers `head`, `data` and `end` events.
 */

export function fetchTransport(fetchImpl = globalThis.fetch.bind(globalThis)) {
  return async ({ url, method = 'GET', headers = {}, body, signal }) => {
    const response = await fetchImpl(url, { method, headers, body, signal });
    let consumed = false;
    async function* chunks() {
      consumed = true;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield decoder.decode(value, { stream: true });
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: chunks(),
      text: () => (consumed ? Promise.resolve('') : response.text()),
    };
  };
}

export function nativeTransport(plugin) {
  return ({ url, method = 'GET', headers = {}, body, signal }) => new Promise((resolve, reject) => {
    const id = globalThis.crypto.randomUUID();
    const queue = [];
    let wake = null;
    let finished = false;
    let failure = null;
    let headResolved = false;

    const notify = () => { if (wake) { const resume = wake; wake = null; resume(); } };
    const onAbort = () => { plugin.cancelRequest({ id }).catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });

    async function* chunks() {
      for (;;) {
        if (queue.length) { yield queue.shift(); continue; }
        if (failure) throw failure;
        if (finished) return;
        await new Promise((resume) => { wake = resume; });
      }
    }
    const response = (status, responseHeaders) => ({
      status,
      headers: responseHeaders || {},
      body: chunks(),
      async text() {
        let text = '';
        for await (const chunk of this.body) text += chunk;
        return text;
      },
    });

    plugin.streamRequest({ id, url, method, headers, body: body ?? null }, (event, error) => {
      if (error) {
        const abort = signal?.aborted;
        failure = abort ? new DOMException('The request was cancelled.', 'AbortError') : new TypeError(error.message || String(error));
        if (!headResolved) { headResolved = true; reject(failure); }
        notify();
        return;
      }
      if (!event) return;
      if (event.type === 'head') {
        headResolved = true;
        resolve(response(event.status, event.headers));
      } else if (event.type === 'data') {
        queue.push(event.chunk);
        notify();
      } else if (event.type === 'end') {
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        notify();
      }
    }).catch((error) => {
      if (!headResolved) { headResolved = true; reject(error); }
    });
  });
}
