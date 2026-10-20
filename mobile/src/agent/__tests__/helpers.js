/** A transport that replays canned SSE text, split at awkward points. */
export function sseTransport(responses, { split = 7 } = {}) {
  const requests = [];
  const queue = [...responses];
  const transport = async (request) => {
    requests.push({ ...request, json: request.body ? JSON.parse(request.body) : null });
    const next = queue.shift();
    if (!next) throw new Error('no canned response left');
    const { status = 200, events = [], text = '' } = next;
    const raw = text || events.map((event) => `${event.event ? `event: ${event.event}\n` : ''}data: ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}\n\n`).join('');
    async function* body() {
      for (let index = 0; index < raw.length; index += split) yield raw.slice(index, index + split);
    }
    return { status, headers: {}, body: body(), text: async () => raw };
  };
  transport.requests = requests;
  return transport;
}

export function openAiChunks({ content = '', reasoning = '', calls = [] } = {}) {
  const events = [];
  for (const piece of reasoning ? [reasoning] : []) events.push({ data: { choices: [{ delta: { reasoning_content: piece } }] } });
  for (const char of content) events.push({ data: { choices: [{ delta: { content: char } }] } });
  calls.forEach((call, index) => {
    events.push({ data: { choices: [{ delta: { tool_calls: [{ index, id: call.id, function: { name: call.name, arguments: '' } }] } }] } });
    const args = JSON.stringify(call.args);
    events.push({ data: { choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(0, 5) } }] } }] } });
    events.push({ data: { choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(5) } }] } }] } });
  });
  events.push({ data: { choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] } });
  events.push({ data: '[DONE]' });
  return { events };
}
