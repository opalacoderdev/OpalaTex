export class ProviderError extends Error {
  constructor(message, { status = 0, provider = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
  }

  static async fromResponse(response, provider) {
    let detail = '';
    try {
      const text = await response.text();
      try {
        const payload = JSON.parse(text);
        detail = payload?.error?.message || payload?.error || payload?.message || text;
      } catch {
        detail = text;
      }
    } catch {
      detail = '';
    }
    let summary = typeof detail === 'string' ? detail.slice(0, 500) : JSON.stringify(detail).slice(0, 500);
    if (/^\s*<(!doctype|html)/i.test(summary)) {
      // A web page instead of an API error: a gateway or filter in front of the
      // API answered, not the API itself. Its markup tells the user nothing.
      summary = 'the request was refused before it reached the API (a web page came back instead of an API error)';
    }
    return new ProviderError(
      `The model provider answered HTTP ${response.status}${summary ? `: ${summary}` : '.'}`,
      { status: response.status, provider },
    );
  }
}

/** The run hit a bound that keeps a misbehaving model from looping forever. */
export class AgentLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentLimitError';
  }
}
