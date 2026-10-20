/** An in-memory Google Drive answering the REST routes the client uses. */
import { createHash } from 'node:crypto';

const FOLDER = 'application/vnd.google-apps.folder';

export function createFakeDrive() {
  const files = new Map([['root', { id: 'root', name: 'My Drive', mimeType: FOLDER, parents: [], trashed: false }]]);
  let counter = 0;
  let clock = Date.UTC(2026, 9, 19);
  const calls = [];
  const failures = [];

  const tick = () => new Date((clock += 1000)).toISOString();
  const md5 = (text) => createHash('md5').update(text).digest('hex');
  const meta = (file) => ({
    id: file.id, name: file.name, mimeType: file.mimeType, trashed: file.trashed,
    modifiedTime: file.modifiedTime, size: file.content === undefined ? undefined : String(Buffer.byteLength(file.content)),
    md5Checksum: file.content === undefined ? undefined : md5(file.content),
  });

  function add({ name, parent, mimeType = 'text/plain', content }) {
    const id = `f${++counter}`;
    files.set(id, { id, name, mimeType, parents: [parent], content, trashed: false, modifiedTime: tick() });
    return id;
  }
  function folder(name, parent = 'root') { return add({ name, parent, mimeType: FOLDER }); }
  function write(path, content, root) {
    let parent = root;
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) {
      const existing = [...files.values()].find((f) => f.name === part && f.parents.includes(parent) && f.mimeType === FOLDER);
      parent = existing ? existing.id : folder(part, parent);
    }
    const name = parts.at(-1);
    const existing = [...files.values()].find((f) => f.name === name && f.parents.includes(parent) && f.mimeType !== FOLDER);
    if (existing) { existing.content = content; existing.modifiedTime = tick(); return existing.id; }
    return add({ name, parent, content });
  }
  function read(path, root) {
    let parent = root;
    for (const part of path.split('/')) {
      const found = [...files.values()].filter((f) => f.name === part && f.parents.includes(parent) && !f.trashed);
      if (found.length !== 1) return found.length ? { duplicates: found.length } : undefined;
      parent = found[0].id;
    }
    return files.get(parent).content;
  }

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  async function fetchImpl(input, init = {}) {
    const url = new URL(input);
    const method = init.method || 'GET';
    calls.push({ method, path: url.pathname, params: Object.fromEntries(url.searchParams), auth: init.headers?.Authorization });
    if (failures.length) {
      const status = failures.shift();
      return json(status, { error: { message: `injected ${status}` } });
    }
    if (init.headers?.Authorization !== 'Bearer good') return json(401, { error: { message: 'Invalid Credentials' } });
    const path = url.pathname;
    if (method === 'GET' && path === '/drive/v3/files') {
      const q = url.searchParams.get('q');
      const parent = q.match(/'([^']+)' in parents/)[1];
      const name = q.match(/^name = '((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\'/g, "'");
      const onlyFolders = q.includes(`mimeType = '${FOLDER}'`);
      const matched = [...files.values()].filter((f) => f.parents.includes(parent) && !f.trashed
        && (!name || f.name === name) && (!onlyFolders || f.mimeType === FOLDER));
      return json(200, { files: matched.map(meta) });
    }
    let match = path.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (method === 'GET' && match) {
      const file = files.get(decodeURIComponent(match[1]));
      if (!file) return json(404, { error: { message: 'File not found' } });
      if (url.searchParams.get('alt') === 'media') return new Response(file.content, { status: 200 });
      return json(200, meta(file));
    }
    if (method === 'POST' && path === '/drive/v3/files') {
      const body = JSON.parse(init.body);
      const id = add({ name: body.name, parent: body.parents[0], mimeType: body.mimeType });
      return json(200, meta(files.get(id)));
    }
    if (method === 'POST' && path === '/upload/drive/v3/files') {
      const boundary = init.headers['Content-Type'].split('boundary=')[1];
      const parts = init.body.split(`--${boundary}`);
      const metadata = JSON.parse(parts[1].split('\r\n\r\n')[1].trim());
      const content = parts[2].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
      const id = add({ name: metadata.name, parent: metadata.parents[0], content });
      return json(200, meta(files.get(id)));
    }
    match = path.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (method === 'PATCH' && match) {
      const file = files.get(decodeURIComponent(match[1]));
      file.content = init.body;
      file.modifiedTime = tick();
      return json(200, meta(file));
    }
    return json(400, { error: { message: `unhandled ${method} ${path}` } });
  }

  return { files, calls, failures, fetchImpl, folder, write, read, add };
}

export function goodToken() {
  const getToken = async ({ refresh } = {}) => { getToken.refreshes += refresh ? 1 : 0; return getToken.value; };
  getToken.value = 'good';
  getToken.refreshes = 0;
  return getToken;
}
