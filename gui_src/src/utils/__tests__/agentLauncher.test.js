import test from 'node:test';
import assert from 'node:assert/strict';

import { launchAgentInTerminal, snapWarning } from '../agentLauncher.js';

const t = (key, fallback, values = {}) => fallback.replace(/{{(\w+)}}/g, (_, name) => String(values[name] ?? ''));
const claude = { id: 'claude', label: 'Claude Code' };
const agy = { id: 'antigravity', label: 'Antigravity CLI' };
const target = { projectPath: '/p/thesis', termId: 'main-2' };

// A backend answering from a script: `routes[method url]` is a list of answers, consumed in order.
function fakeBackend(routes) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push([method, url, body]);
    const queue = routes[`${method} ${url}`];
    assert.ok(queue && queue.length, `unexpected request ${method} ${url}`);
    const [status, payload] = queue.shift();
    return { status, ok: status >= 200 && status < 300, json: async () => payload };
  };
  return { fetchImpl, requests };
}

function dialogs(answers) {
  const asked = [];
  return {
    asked,
    confirm: async (message, title) => { asked.push(title); return answers.shift(); },
  };
}

test('with access on, Claude Code is launched without a question', async () => {
  const backend = fakeBackend({
    'GET /api/settings/external-access': [[200, { enabled: true }]],
    'POST /api/external-agents/launch': [[200, { ok: true, label: 'Claude Code' }]],
  });
  const ui = dialogs([]);
  const result = await launchAgentInTerminal({ agent: claude, ...target }, { fetchImpl: backend.fetchImpl, confirm: ui.confirm, t });
  assert.deepEqual(result, { ok: true, termId: 'main-2', label: 'Claude Code' });
  assert.deepEqual(ui.asked, []);
  assert.deepEqual(backend.requests[1], ['POST', '/api/external-agents/launch', { agent: 'claude', projectPath: '/p/thesis', term_id: 'main-2' }]);
});

test('with access off, the user is asked first; declining changes nothing', async () => {
  const backend = fakeBackend({ 'GET /api/settings/external-access': [[200, { enabled: false }]] });
  const ui = dialogs([false]);
  const result = await launchAgentInTerminal({ agent: claude, ...target }, { fetchImpl: backend.fetchImpl, confirm: ui.confirm, t });
  assert.deepEqual(result, { ok: false, cancelled: true });
  assert.deepEqual(backend.requests.map(([m, u]) => `${m} ${u}`), ['GET /api/settings/external-access']);
});

test('agreeing turns the access on, announces it, then launches', async () => {
  const backend = fakeBackend({
    'GET /api/settings/external-access': [[200, { enabled: false }]],
    'POST /api/settings/external-access': [[200, { enabled: true }]],
    'POST /api/external-agents/launch': [[200, { ok: true, label: 'Claude Code' }]],
  });
  const announced = [];
  const result = await launchAgentInTerminal({ agent: claude, ...target }, {
    fetchImpl: backend.fetchImpl, confirm: dialogs([true]).confirm, t, notify: (on) => announced.push(on),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(announced, [true]);
  assert.deepEqual(backend.requests[1], ['POST', '/api/settings/external-access', { enabled: true }]);
});

function messages(answers) {
  const shown = [];
  return { shown, confirm: async (message) => { shown.push(message); return answers.shift(); } };
}

test('in the snap, the question to turn the access on starts with the snap warning', async () => {
  const backend = fakeBackend({ 'GET /api/settings/external-access': [[200, { enabled: false, snap: true }]] });
  const ui = messages([false]);
  await launchAgentInTerminal({ agent: claude, ...target }, { fetchImpl: backend.fetchImpl, confirm: ui.confirm, t });
  assert.equal(ui.shown.length, 1);
  assert.ok(ui.shown[0].startsWith(`${snapWarning(t)}\n\n`));
  assert.match(ui.shown[0], /\.deb package or with install\.sh/);
});

test('outside the snap, the question has no snap warning', async () => {
  const backend = fakeBackend({ 'GET /api/settings/external-access': [[200, { enabled: false, snap: false }]] });
  const ui = messages([false]);
  await launchAgentInTerminal({ agent: claude, ...target }, { fetchImpl: backend.fetchImpl, confirm: ui.confirm, t });
  assert.ok(!ui.shown[0].includes(snapWarning(t)));
});

test('Antigravity is registered only after the user agrees to it', async () => {
  const needs = { code: 'needs_registration', registration: 'missing', config_path: '/h/.gemini/config/mcp_config.json', command_line: 'agy mcp add opalatex -- x mcp' };
  const declined = fakeBackend({
    'GET /api/settings/external-access': [[200, { enabled: true }]],
    'POST /api/external-agents/launch': [[409, needs]],
  });
  const no = dialogs([false]);
  assert.deepEqual(
    await launchAgentInTerminal({ agent: agy, ...target }, { fetchImpl: declined.fetchImpl, confirm: no.confirm, t }),
    { ok: false, cancelled: true },
  );
  assert.deepEqual(no.asked, ['Register OpalaTex in Antigravity CLI']);
  assert.equal(declined.requests.length, 2);

  const agreed = fakeBackend({
    'GET /api/settings/external-access': [[200, { enabled: true }]],
    'POST /api/external-agents/launch': [[409, needs], [200, { ok: true, label: 'Antigravity CLI' }]],
  });
  const result = await launchAgentInTerminal({ agent: agy, ...target }, { fetchImpl: agreed.fetchImpl, confirm: dialogs([true]).confirm, t });
  assert.equal(result.ok, true);
  assert.deepEqual(agreed.requests[2][2], { agent: 'antigravity', projectPath: '/p/thesis', term_id: 'main-2', register: true });
});

test('a refusal comes back with the backend\'s reason', async () => {
  const backend = fakeBackend({
    'GET /api/settings/external-access': [[200, { enabled: true }]],
    'POST /api/external-agents/launch': [[404, { code: 'not_found', error: 'Claude Code was not found.' }]],
  });
  const result = await launchAgentInTerminal({ agent: claude, ...target }, { fetchImpl: backend.fetchImpl, confirm: dialogs([]).confirm, t });
  assert.deepEqual(result, { ok: false, error: 'Claude Code was not found.', code: 'not_found' });
});
