import test from 'node:test';
import assert from 'node:assert/strict';

import {
  answerIdeCommand,
  connectWindowCommandChannel,
  newWindowId,
  windowCommandStreamUrl,
} from '../windowCommandChannel.js';

class FakeEventSource {
  static last = null;

  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.last = this;
  }

  addEventListener(name, handler) {
    this.listeners[name] = handler;
  }

  emit(name, data) {
    this.listeners[name]?.({ data });
  }

  close() {
    this.closed = true;
  }
}

test('the stream URL carries the window id and the encoded project path', () => {
  assert.equal(
    windowCommandStreamUrl('w 1', '/home/me/My Thesis'),
    '/api/ide/window/stream?windowId=w+1&projectPath=%2Fhome%2Fme%2FMy+Thesis',
  );
});

test('window ids are unique', () => {
  assert.notEqual(newWindowId(), newWindowId());
});

test('commands on the stream reach onCommand and closing closes the stream', () => {
  const commands = [];
  const errors = [];
  const close = connectWindowCommandChannel({
    windowId: 'w1',
    projectPath: '/p',
    onCommand: (command) => commands.push(command),
    onError: (err) => errors.push(err),
    EventSourceImpl: FakeEventSource,
  });
  const source = FakeEventSource.last;
  assert.equal(source.url, '/api/ide/window/stream?windowId=w1&projectPath=%2Fp');

  source.emit('ide_command', JSON.stringify({ id: 'c1', action: 'get_problems' }));
  source.emit('ide_command', '{broken');
  assert.deepEqual(commands, [{ id: 'c1', action: 'get_problems' }]);
  assert.equal(errors.length, 1);
  // Without an onEvent handler, an event is dropped rather than taken for a command.
  source.emit('ide_event', JSON.stringify({ event: 'latex_compiled' }));
  assert.equal(commands.length, 1);

  close();
  assert.equal(source.closed, true);
});

test('the answer is posted with the command id, refusals included', async () => {
  const posted = [];
  const post = async (body) => { posted.push(body); };

  await answerIdeCommand({ id: 'c1', action: 'set_layout' }, { runner: async () => ({ ok: true, layout: 'chat' }), post });
  await answerIdeCommand({ id: 'c2', action: 'open_file' }, { runner: async () => ({ ok: false, error: 'no' }), post });
  const thrown = await answerIdeCommand({ id: 'c3', action: 'close_file' }, {
    runner: async () => { throw new Error('boom'); },
    post,
  });

  assert.deepEqual(posted, [
    { ok: true, layout: 'chat', id: 'c1' },
    { ok: false, error: 'no', id: 'c2' },
    { ok: false, error: "The IDE failed to carry out 'close_file': boom", id: 'c3' },
  ]);
  assert.equal(thrown.ok, false);
});

test('registration commands quote paths for the shell they will be pasted in', async () => {
  const { agentRegistrationCommands, formatCommandLine } = await import('../windowCommandChannel.js');
  assert.equal(
    formatCommandLine(['/home/me/My Apps/python', '/opt/opalatex/main.py', 'mcp']),
    "'/home/me/My Apps/python' /opt/opalatex/main.py mcp",
  );
  assert.equal(
    formatCommandLine(['C:\\Program Files\\OpalaTex\\OpalaTex.exe', 'mcp']),
    '"C:\\Program Files\\OpalaTex\\OpalaTex.exe" mcp',
  );
  assert.equal(formatCommandLine(["/tmp/it's", 'mcp']), "'/tmp/it'\\''s' mcp");
  assert.equal(formatCommandLine(['/tmp/a\\b', 'mcp']), "'/tmp/a\\b' mcp");
  assert.equal(formatCommandLine(['C:\\OpalaTex\\OpalaTex.exe', 'mcp']), 'C:\\OpalaTex\\OpalaTex.exe mcp');
  assert.deepEqual(agentRegistrationCommands(['/snap/bin/opalatex', 'mcp']), {
    claude: 'claude mcp add opalatex -- /snap/bin/opalatex mcp',
    antigravity: 'agy mcp add opalatex /snap/bin/opalatex mcp',
  });
});

test('events that are only shown reach onEvent, not onCommand', () => {
  const commands = [];
  const events = [];
  connectWindowCommandChannel({
    windowId: 'w1', projectPath: '/p',
    onCommand: (c) => commands.push(c), onEvent: (e) => events.push(e),
    EventSourceImpl: FakeEventSource,
  });
  FakeEventSource.last.emit('ide_event', JSON.stringify({ event: 'latex_compiled', success: true }));
  assert.deepEqual(events, [{ event: 'latex_compiled', success: true }]);
  assert.deepEqual(commands, []);
});
