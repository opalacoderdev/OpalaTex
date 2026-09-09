import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { createFileSaveQueue, contentAfterSave } from '../fileSave.js';

// Exercise the actual App handler with deferred HTTP responses and a small
// state adapter. This catches accidental removal of its document identity and
// live-buffer checks, which pure snapshot-helper tests alone cannot cover.
const app = fs.readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
const handler = app.slice(app.indexOf('  const saveFile = async'), app.indexOf('  useEffect(() => { saveFileRef.current = saveFile; }'));
function editor() {
  const state = { project: '/project', file: 'a.txt', content: 'old', buffers: { 'a.txt': 'old' }, saving: false };
  const requests = [];
  const diskFileContentsRef = { current: {} };
  const fileContentRef = { current: state.content };
  const documentContextRef = { current: null };
  const refresh = () => {
    documentContextRef.current = { projectPath: state.project, selectedFile: state.file, getContent: () => state.content };
  };
  const dependencies = {
    contentAfterSave, isBinaryEditorFile: () => false, fileContentRef, diskFileContentsRef, documentContextRef,
    fileSaveQueueRef: { current: createFileSaveQueue() }, pendingSaveCountRef: { current: 0 },
    setFileContent: value => { state.content = value; },
    setFileContents: update => { state.buffers = update(state.buffers); },
    setIsSaving: value => { state.saving = value; },
    filePathKey: path => path, sameFilePath: (a, b) => a === b,
    addLog() {}, t() {}, gitQuerySuffix() {}, setOriginalFileContents() {},
    fetchGitStatus() {}, fetchProblems() {}, setTriggerCompileRequest() {},
    fetch: async (url, options) => {
      if (url !== '/api/file/write') return { ok: true, json: async () => ({}) };
      return new Promise(resolve => requests.push({
        submitted: JSON.parse(options.body),
        finish(content) { resolve({ ok: true, json: async () => content === undefined ? {} : { content } }); },
        fail() { resolve({ ok: false }); },
      }));
    },
  };
  function save() {
    refresh();
    const scope = { ...dependencies, activeProject: { project_path: state.project }, selectedFile: state.file,
      fileContent: state.content, getCurrentTextFileContent: () => state.content };
    return new Function(...Object.keys(scope), `${handler}\nreturn saveFile;`)(...Object.values(scope))();
  }
  refresh();
  return { state, requests, diskFileContentsRef, save, refresh };
}

test('typing while a save is pending survives its response', async () => {
  const e = editor();
  const saving = e.save();
  await setImmediate();
  e.state.content = 'typed after save';
  e.requests[0].finish();
  await saving;
  assert.equal(e.state.content, 'typed after save');
  assert.equal(e.state.buffers['a.txt'], 'typed after save');
  assert.equal(e.diskFileContentsRef.current['a.txt'], 'old');
});

test('switching tabs while saving never replaces the new tab', async () => {
  const e = editor();
  const saving = e.save();
  await setImmediate();
  e.state.file = 'b.txt'; e.state.content = 'other file'; e.refresh();
  e.requests[0].finish();
  await saving;
  assert.equal(e.state.content, 'other file');
  assert.equal(e.state.buffers['a.txt'], 'old');
});

test('switching projects with the same filename rejects the old receipt', async () => {
  const e = editor();
  const saving = e.save();
  await setImmediate();
  e.state.project = '/other'; e.state.content = 'other project';
  e.diskFileContentsRef.current = {}; e.state.buffers = { 'a.txt': 'other project' }; e.refresh();
  e.requests[0].finish();
  await saving;
  assert.equal(e.state.content, 'other project');
  assert.deepEqual(e.diskFileContentsRef.current, {});
  assert.equal(e.state.buffers['a.txt'], 'other project');
});

test('overlapping saves write in order and keep saving until all finish', async () => {
  const e = editor();
  const first = e.save();
  await setImmediate();
  e.state.content = 'new';
  const second = e.save();
  await setImmediate();
  assert.equal(e.requests.length, 1);
  e.requests[0].finish();
  await first; await setImmediate();
  assert.equal(e.requests.length, 2);
  assert.equal(e.requests[1].submitted.content, 'new');
  assert.equal(e.state.saving, true);
  e.requests[1].finish(); await second;
  assert.equal(e.state.content, 'new');
  assert.equal(e.diskFileContentsRef.current['a.txt'], 'new');
  assert.equal(e.state.saving, false);
});

test('canonical JPT response updates an unchanged buffer', async () => {
  const e = editor();
  const saving = e.save(); await setImmediate();
  e.requests[0].finish('canonical jpt:asset'); await saving;
  assert.equal(e.state.content, 'canonical jpt:asset');
  assert.equal(e.state.buffers['a.txt'], 'canonical jpt:asset');
});

test('a failed save does not stop subsequent saves or mark its contents saved', async () => {
  const e = editor();
  const saving = e.save(); await setImmediate();
  e.requests[0].fail(); assert.equal(await saving, false);
  assert.deepEqual(e.diskFileContentsRef.current, {});
  const next = e.save(); await setImmediate();
  e.requests[1].finish(); assert.equal(await next, true);
});

test('canonicalization never overwrites a newer buffer', () => {
  assert.equal(contentAfterSave('newer', 'old', 'canonical'), 'newer');
});
