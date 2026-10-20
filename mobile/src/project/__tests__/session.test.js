import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriveClient } from '../../drive/client.js';
import { createFakeDrive, goodToken } from '../../drive/__tests__/fakeDrive.js';
import { createMemoryKv } from '../../platform/kv.js';
import { createProjectSession } from '../session.js';
import { runChatTurn } from '../turn.js';
import { createTools } from '../../agent/tools.js';

const device = { id: 'dev-1', name: 'Pixel' };

function exportDoc(extra = {}) {
  return {
    version: 1,
    project: 'thesis_db',
    updated_at: '2026-10-19T10:00:00.000000+00:00',
    settings: { model: 'openai/gpt-x', description: 'A thesis', use_shared_memory: '0' },
    chats: [{ id: 'main_thesis_db', name: 'Main Chat', created_at: '2026-10-19T10:00:00.000000+00:00', agent_state: '{}', core_memory: '' }],
    messages: [
      { chat_id: 'main_thesis_db', timestamp: '2026-10-19T10:00:01.000000+00:00', role: 'user', content: 'desktop question', client_message_id: 'd1', attachments: '[]', deleted_at: '', superseded_by: '' },
      { chat_id: 'main_thesis_db', timestamp: '2026-10-19T10:00:02.000000+00:00', role: 'assistant', content: 'desktop answer', client_message_id: '', attachments: '[]', deleted_at: '', superseded_by: '' },
    ],
    activity: [],
    ...extra,
  };
}

function setup() {
  const fake = createFakeDrive();
  const container = fake.folder('OpalaTex');
  const root = fake.folder('thesis', container);
  fake.write('.opalatex/session/chats.json', JSON.stringify(exportDoc()), root);
  fake.write('main.tex', '\\section{Intro}\nHello', root);
  const drive = createDriveClient({ getToken: goodToken(), fetchImpl: fake.fetchImpl, sleep: async () => {} });
  const kv = createMemoryKv();
  const session = createProjectSession({ drive, kv, device, project: { name: 'thesis', root } });
  return { fake, root, drive, kv, session };
}

function scripted(responses) {
  return async ({ onText, onReasoning }) => {
    const next = { content: '', reasoning: '', toolCalls: [], ...responses.shift() };
    if (next.reasoning) onReasoning(next.reasoning);
    if (next.content) onText(next.content);
    return next;
  };
}

test('pull shows the desktop conversation', async () => {
  const { session } = setup();
  const { chats, settings } = await session.pull();
  assert.equal(settings.model, 'openai/gpt-x');
  assert.deepEqual(chats[0].messages.map((m) => m.content), ['desktop question', 'desktop answer']);
  assert.equal(session.projectName, 'thesis_db');
});

test('a turn lands in the journal on Drive, in the desktop format', async () => {
  const { fake, root, session } = setup();
  await session.pull();
  const [chat] = (await session.conversation()).chats;
  const complete = scripted([
    { reasoning: 'look at the file', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"main.tex"}' }] },
    { content: 'The intro says Hello.' },
  ]);
  const result = await runChatTurn({
    session, chat, text: 'What does the intro say?', complete,
    tools: createTools(session.workspace), approve: async () => true, today: '2026-10-19', device,
  });
  assert.equal(result.uploaded, true);
  const journal = JSON.parse(fake.read('.opalatex/session/devices/dev-1.json', root));
  assert.equal(journal.kind, 'opalatex.device-journal');
  assert.equal(journal.project, 'thesis_db');
  assert.deepEqual(journal.messages.map((m) => [m.role, m.content]), [
    ['user', 'What does the intro say?'], ['assistant', 'The intro says Hello.'],
  ]);
  assert.ok(journal.messages.every((m) => m.client_message_id && /\+00:00$/.test(m.timestamp)));
  const [thought] = journal.activity;
  assert.equal(thought.event, 'thought');
  assert.match(thought.content, /look at the file/);
  assert.ok(journal.messages[0].timestamp < thought.timestamp && thought.timestamp < journal.messages[1].timestamp);
  const view = (await session.conversation()).chats.find((c) => c.id === chat.id);
  assert.equal(view.messages.at(-1).thoughts.includes('look at the file'), true);
});

test('a new chat travels in the journal with its identity', async () => {
  const { fake, root, session } = setup();
  await session.pull();
  await runChatTurn({
    session, chat: null, text: 'Start a new topic here please', complete: scripted([{ content: 'Sure.' }]),
    tools: [], approve: async () => true, today: '2026-10-19', device,
  });
  const journal = JSON.parse(fake.read('.opalatex/session/devices/dev-1.json', root));
  assert.equal(journal.chats.length, 1);
  assert.equal(journal.chats[0].name, 'Start a new topic here please');
  assert.ok(journal.messages.every((m) => m.chat_id === journal.chats[0].id));
});

test('once a desktop folds the journal in, the journal shrinks and nothing doubles', async () => {
  const { fake, root, session } = setup();
  await session.pull();
  const [chat] = (await session.conversation()).chats;
  await runChatTurn({ session, chat, text: 'phone q', complete: scripted([{ content: 'phone a' }]), tools: [], approve: async () => true, today: 't', device });
  const journal = JSON.parse(fake.read('.opalatex/session/devices/dev-1.json', root));
  // The desktop merges the journal and republishes the union.
  const folded = exportDoc();
  folded.messages.push(...journal.messages.map((m) => ({ ...m, deleted_at: '', superseded_by: '' })));
  folded.activity.push(...journal.activity.map((a) => ({ ...a, deleted_at: '' })));
  fake.write('.opalatex/session/chats.json', JSON.stringify(folded), root);

  const { chats } = await session.pull();
  assert.deepEqual(chats[0].messages.map((m) => m.content), ['desktop question', 'desktop answer', 'phone q', 'phone a']);
  await session.push();
  const after = JSON.parse(fake.read('.opalatex/session/devices/dev-1.json', root));
  assert.deepEqual(after.messages, []);
  assert.deepEqual(after.activity, []);
});

test('offline, the turn is kept and uploaded on the next push', async () => {
  const { fake, root, session } = setup();
  await session.pull();
  const [chat] = (await session.conversation()).chats;
  fake.failures.push(...Array(40).fill(503));
  const result = await runChatTurn({ session, chat, text: 'offline q', complete: scripted([{ content: 'offline a' }]), tools: [], approve: async () => true, today: 't', device });
  assert.equal(result.uploaded, false);
  assert.equal(await session.pendingUpload(), true);
  fake.failures.length = 0;
  await session.push();
  assert.equal(await session.pendingUpload(), false);
  const journal = JSON.parse(fake.read('.opalatex/session/devices/dev-1.json', root));
  assert.deepEqual(journal.messages.map((m) => m.content), ['offline q', 'offline a']);
});

test('other devices\' journals are shown, a foreign file is not', async () => {
  const { fake, root, session } = setup();
  fake.write('.opalatex/session/devices/tablet.json', JSON.stringify({
    kind: 'opalatex.device-journal', version: 1, device: { id: 'tablet' }, chats: [],
    messages: [{ chat_id: 'main_thesis_db', timestamp: '2026-10-19T10:00:03.000000+00:00', role: 'user', content: 'from the tablet', client_message_id: 't1', attachments: '[]' }],
    activity: [],
  }), root);
  fake.write('.opalatex/session/devices/notes.json', JSON.stringify({ hello: 1 }), root);
  const { chats } = await session.pull();
  assert.deepEqual(chats[0].messages.map((m) => [m.content, m.origin]).at(-1), ['from the tablet', 'other-device']);
});

test('the cached index and files keep the project readable offline', async () => {
  const { fake, session } = setup();
  await session.pull();
  await session.workspace.readText('main.tex');
  fake.failures.push(...Array(40).fill(503));
  await session.pull();
  assert.equal(session.workspace.offline, true);
  const { content } = await session.workspace.readText('main.tex');
  assert.equal(content, '\\section{Intro}\nHello');
});

test('concurrent pushes create one journal file', async () => {
  const { fake, session } = setup();
  await session.pull();
  await session.appendMessage({ chat_id: 'main_thesis_db', timestamp: 't', role: 'user', content: 'x', client_message_id: 'x1' });
  await Promise.all([session.push(), session.push(), session.push()]);
  assert.equal([...fake.files.values()].filter((f) => f.name === 'dev-1.json').length, 1);
});

test('a project re-opened on this device shows its cached state without the network', async () => {
  const { fake, drive, kv, root } = setup();
  const first = createProjectSession({ drive, kv, device, project: { name: 'thesis', root } });
  await first.pull();
  await first.workspace.readText('main.tex');

  // Later — even with Drive unreachable — a fresh session restores at once.
  fake.failures.push(...Array(40).fill(503));
  const callsBefore = fake.calls.length;
  const again = createProjectSession({ drive, kv, device, project: { name: 'thesis', root } });
  const { chats } = await again.restore();
  assert.equal(fake.calls.length, callsBefore, 'restore must not touch the network');
  assert.deepEqual(chats[0].messages.map((m) => m.content), ['desktop question', 'desktop answer']);
  assert.ok((await again.workspace.listPaths()).includes('main.tex'));
});

test('restoring a project never opened on this device yields nothing', async () => {
  const { session } = setup();
  assert.equal(await session.restore(), null);
});

test('a pull keeps the previous conversation until the new one is read', async () => {
  const { session } = setup();
  await session.pull();
  const pending = session.pull();
  // While the second pull is walking Drive, the conversation is still there.
  const { chats } = await session.conversation();
  assert.equal(chats[0].messages.length, 2);
  await pending;
});
