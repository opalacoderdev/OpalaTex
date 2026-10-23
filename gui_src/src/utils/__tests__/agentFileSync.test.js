import test from 'node:test';
import assert from 'node:assert/strict';

import { agentWriteAction, createAgentFileSync, projectRelativePath } from '../agentFileSync.js';

test('a disk that still matches the baseline needs nothing', () => {
  assert.equal(agentWriteAction({ baseline: 'a', buffer: 'edited', disk: 'a' }), 'none');
  assert.equal(agentWriteAction({ baseline: 'a', buffer: 'a', disk: undefined }), 'none');
});

test('a buffer without edits of its own takes the agent version', () => {
  assert.equal(agentWriteAction({ baseline: 'a', buffer: 'a', disk: 'agent' }), 'reload');
  assert.equal(agentWriteAction({ baseline: 'a', buffer: undefined, disk: 'agent' }), 'reload');
  assert.equal(agentWriteAction({ baseline: 'a', buffer: 'agent', disk: 'agent' }), 'reload');
});

test('unsaved edits are never replaced without asking', () => {
  assert.equal(agentWriteAction({ baseline: 'a', buffer: 'user edit', disk: 'agent' }), 'conflict');
  // No baseline: nothing proves the buffer is clean.
  assert.equal(agentWriteAction({ baseline: undefined, buffer: 'user edit', disk: 'agent' }), 'conflict');
});

test('relative tool paths are taken as project-relative', () => {
  assert.equal(projectRelativePath('chapters/intro.tex', '/p/thesis'), 'chapters/intro.tex');
  assert.equal(projectRelativePath('./main.tex', '/p/thesis'), 'main.tex');
  assert.equal(projectRelativePath('chapters\\intro.tex', 'C:\\p\\thesis'), 'chapters/intro.tex');
});

test('absolute tool paths are made relative to the project, and only inside it', () => {
  assert.equal(projectRelativePath('/p/thesis/chapters/intro.tex', '/p/thesis/'), 'chapters/intro.tex');
  assert.equal(projectRelativePath('/p/thesis2/main.tex', '/p/thesis'), null);
  assert.equal(projectRelativePath('/etc/passwd', '/p/thesis'), null);
  assert.equal(projectRelativePath('C:\\P\\Thesis\\main.tex', 'c:\\p\\thesis', { caseInsensitive: true }), 'main.tex');
  assert.equal(projectRelativePath('C:\\P\\Thesis\\main.tex', 'c:\\p\\thesis'), null);
});

test('paths escaping the project or naming nothing are rejected', () => {
  assert.equal(projectRelativePath('../other/main.tex', '/p/thesis'), null);
  assert.equal(projectRelativePath('', '/p/thesis'), null);
  assert.equal(projectRelativePath('.', '/p/thesis'), null);
});

// A small editor: buffers, disk baselines and the disk itself, with the
// question answered by `answers` (true = load the agent's version).
function editor({ project = '/p/thesis', buffers = {}, baselines = {}, disk = {}, selected = null, answers = [] } = {}) {
  const state = { project, buffers: { ...buffers }, baselines: { ...baselines }, disk: { ...disk }, asked: [], logs: [], applied: [] };
  const deps = {
    getProjectPath: () => state.project,
    caseInsensitive: () => false,
    bufferedPaths: () => [...Object.keys(state.buffers), ...(selected ? [selected] : [])],
    bufferOf: (path) => state.buffers[path],
    baselineOf: (path) => state.baselines[path],
    setBaseline: (path, content) => { state.baselines[path] = content; },
    samePath: (a, b) => a.replace(/\\/g, '/') === b.replace(/\\/g, '/'),
    pathKey: (path) => path.replace(/\\/g, '/'),
    isBinary: (path) => path.endsWith('.pdf'),
    readDisk: async (_project, path) => state.disk[path],
    apply: (path, content) => { state.buffers[path] = content; state.applied.push(path); },
    confirmLoad: async (path) => { state.asked.push(path); return answers.shift() ?? false; },
    log: (kind, path) => state.logs.push(`${kind}:${path}`),
  };
  return { state, sync: createAgentFileSync(deps) };
}

test('a clean buffer takes the agent version, and only the file the agent named', async () => {
  const { state, sync } = editor({
    buffers: { 'chapters/intro.tex': 'old', 'appendix/intro.tex': 'mine, unsaved' },
    baselines: { 'chapters/intro.tex': 'old', 'appendix/intro.tex': 'appendix on disk' },
    disk: { 'chapters/intro.tex': 'agent', 'appendix/intro.tex': 'appendix on disk' },
  });
  await sync.reconcile(['/p/thesis/chapters/intro.tex']);
  await sync.idle();

  assert.equal(state.buffers['chapters/intro.tex'], 'agent');
  assert.equal(state.baselines['chapters/intro.tex'], 'agent');
  // The same-named file elsewhere is not touched: the old code matched by
  // basename and reloaded it, discarding these edits.
  assert.equal(state.buffers['appendix/intro.tex'], 'mine, unsaved');
  assert.deepEqual(state.asked, []);
});

test('unsaved edits are kept unless the user chooses the agent version', async () => {
  const { state, sync } = editor({
    buffers: { 'main.tex': 'my edit' },
    baselines: { 'main.tex': 'old' },
    disk: { 'main.tex': 'agent' },
    answers: [false],
  });
  await sync.reconcile(['main.tex']);
  await sync.idle();

  assert.deepEqual(state.asked, ['main.tex']);
  assert.equal(state.buffers['main.tex'], 'my edit');
  // The baseline follows the disk, so the buffer stays marked unsaved.
  assert.equal(state.baselines['main.tex'], 'agent');
  assert.deepEqual(state.logs, ['kept:main.tex']);

  // The same write reported again (tool result, then the checkpoint) is not
  // asked about twice.
  await sync.reconcile(['main.tex']);
  await sync.idle();
  assert.deepEqual(state.asked, ['main.tex']);
});

test('choosing the agent version loads what is on disk at that moment', async () => {
  const { state, sync } = editor({
    buffers: { 'main.tex': 'my edit' },
    baselines: { 'main.tex': 'old' },
    disk: { 'main.tex': 'agent v1' },
    answers: [true],
  });
  const reconciled = sync.reconcile(['main.tex']);
  state.disk['main.tex'] = 'agent v2';
  await reconciled;
  await sync.idle();

  assert.equal(state.buffers['main.tex'], 'agent v2');
  assert.equal(state.baselines['main.tex'], 'agent v2');
  assert.deepEqual(state.logs, ['reloaded:main.tex']);
});

test('conflicts are asked one at a time and each file once', async () => {
  const { state, sync } = editor({
    buffers: { 'a.tex': 'mine a', 'b.tex': 'mine b' },
    baselines: { 'a.tex': 'old a', 'b.tex': 'old b' },
    disk: { 'a.tex': 'agent a', 'b.tex': 'agent b' },
    answers: [true, false],
  });
  await Promise.all([sync.reconcile(['a.tex', 'b.tex']), sync.reconcile(['a.tex'])]);
  await sync.idle();

  assert.deepEqual(state.asked, ['a.tex', 'b.tex']);
  assert.equal(state.buffers['a.tex'], 'agent a');
  assert.equal(state.buffers['b.tex'], 'mine b');
});

test('nothing happens when the disk did not change, the path is outside the project, or the file is binary', async () => {
  const { state, sync } = editor({
    buffers: { 'main.tex': 'my edit', 'out.pdf': 'x' },
    baselines: { 'main.tex': 'same', 'out.pdf': 'y' },
    disk: { 'main.tex': 'same', 'out.pdf': 'z' },
  });
  await sync.reconcile(['main.tex', '/elsewhere/main.tex', 'out.pdf']);
  await sync.idle();

  assert.deepEqual(state.asked, []);
  assert.deepEqual(state.applied, []);
});

test('a project switch while reading or asking leaves the new project alone', async () => {
  const { state, sync } = editor({
    buffers: { 'main.tex': 'my edit', 'clean.tex': 'old' },
    baselines: { 'main.tex': 'old', 'clean.tex': 'old' },
    disk: { 'main.tex': 'agent', 'clean.tex': 'agent' },
    answers: [true],
  });
  const reconciled = sync.reconcile(['main.tex', 'clean.tex']);
  state.project = '/p/other';
  await reconciled;
  await sync.idle();

  assert.deepEqual(state.applied, []);
  assert.deepEqual(state.asked, []);
});
