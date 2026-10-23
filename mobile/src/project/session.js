/**
 * One open project on the phone: its files, its conversations, its journal.
 *
 * pull()  refreshes the file index, the desktops' `chats.json` and the other
 *         devices' journals, and drops from this device's journal what the
 *         export already holds.
 * push()  uploads this device's journal when it changed. It is the only file
 *         this device writes besides approved edits, and it has one writer, so
 *         there is nothing to reconcile.
 *
 * The journal is saved locally before any upload, so a turn made offline is
 * kept and goes up on the next push.
 */

import { buildConversation } from './conversation.js';
import {
  CHATS_EXPORT_PATH,
  addActivity,
  addChat,
  addMessage,
  compactJournal,
  createJournal,
  isDeviceJournalPath,
  journalPath,
  serializeJournal,
  validateJournal,
} from './journal.js';
import { createWorkspace } from './workspace.js';

export function createProjectSession({ drive, kv, device, project }) {
  const workspace = createWorkspace({ drive, kv, root: project.root });
  const journalKey = `journal:${project.root}`;
  const ownPath = journalPath(device.id);
  let exportDoc = null;
  let others = [];
  let state = null;
  const problems = [];

  async function loadOwn() {
    if (!state) {
      state = (await kv.get(journalKey)) || {
        journal: createJournal(device, ''),
        dirty: false,
        uploaded: '',
      };
    }
    return state;
  }

  async function saveOwn(next) {
    state = next;
    await kv.set(journalKey, state);
  }

  async function readJson(path) {
    const { content, stale } = await workspace.readInternalText(path);
    return { value: JSON.parse(content), stale };
  }

  /**
   * Read the export and other devices' journals named by the current index.
   * `cachedOnly` uses what this device already holds and never downloads; a
   * document it does not hold is simply not shown yet.
   */
  async function loadDocuments({ cachedOnly }) {
    const read = async (path) => {
      if (!cachedOnly) return (await readJson(path)).value;
      const cached = await workspace.readCachedText(path);
      return cached ? JSON.parse(cached.content) : undefined;
    };
    const paths = await workspace.listPaths({ includeInternal: true });
    const found = [];

    let nextExport = null;
    if (paths.includes(CHATS_EXPORT_PATH)) {
      try {
        nextExport = (await read(CHATS_EXPORT_PATH)) ?? null;
        if (Number(nextExport?.version || 0) > 1) {
          found.push({ code: 'export-newer-format' });
          nextExport = null;
        }
      } catch (error) {
        found.push({ code: 'export-unreadable', detail: error.message });
      }
    } else {
      found.push({ code: 'no-export' });
    }

    const nextOthers = [];
    for (const path of paths) {
      if (!isDeviceJournalPath(path) || path === ownPath) continue;
      try {
        const value = await read(path);
        if (value && validateJournal(value).ok) nextOthers.push(value);
      } catch {
        found.push({ code: 'journal-unreadable', path });
      }
    }
    exportDoc = nextExport;
    others = nextOthers;
    problems.length = 0;
    problems.push(...found);
  }

  /**
   * Show the project as this device last saw it, without the network. Returns
   * null when nothing is cached (first open on this device). Holding the last
   * state in memory as well means re-entering a project shows it instantly.
   */
  async function restore() {
    if (!exportDoc && !others.length) {
      if (!(await workspace.loadCachedIndex())) return null;
      await loadDocuments({ cachedOnly: true });
    }
    return conversation();
  }

  async function pull() {
    await workspace.refresh();
    await loadDocuments({ cachedOnly: false });

    const snapshot = (await loadOwn()).journal;
    const compacted = await compactJournal(snapshot, exportDoc);
    // Compaction is asynchronous and a turn may append meanwhile. Mutations
    // only ever append, so whatever lies past the snapshot is kept as is.
    const current = state.journal;
    const merged = {
      ...current,
      project: current.project || exportDoc?.project || '',
      chats: [...compacted.chats, ...current.chats.slice(snapshot.chats.length)],
      messages: [...compacted.messages, ...current.messages.slice(snapshot.messages.length)],
      activity: [...compacted.activity, ...current.activity.slice(snapshot.activity.length)],
    };
    const changed = serializeJournal(merged) !== serializeJournal(current);
    await saveOwn({ ...state, journal: merged, dirty: state.dirty || changed });
    return conversation();
  }

  // Pushes are serialized: two concurrent first uploads would each create the
  // journal, and Drive happily keeps two files with one name.
  let pushing = Promise.resolve();
  function push() {
    const next = pushing.then(pushOnce, pushOnce);
    pushing = next.catch(() => {});
    return next;
  }

  async function pushOnce() {
    const own = await loadOwn();
    if (!own.dirty) return false;
    const text = serializeJournal(own.journal);
    if (text === own.uploaded) {
      await saveOwn({ ...own, dirty: false });
      return false;
    }
    await workspace.writeText(ownPath, text, undefined);
    await saveOwn({ ...state, dirty: serializeJournal(state.journal) !== text, uploaded: text });
    return true;
  }

  async function mutate(change) {
    await loadOwn();
    // Read and replace `state` with no await in between, so two mutations in
    // flight cannot both start from the same journal and drop one another.
    await saveOwn({ ...state, journal: change(state.journal), dirty: true });
  }

  async function conversation() {
    const own = await loadOwn();
    return buildConversation({
      exportDoc,
      journals: [{ journal: own.journal, own: true }, ...others.map((journal) => ({ journal, own: false }))],
    });
  }

  return {
    workspace,
    restore,
    pull,
    push,
    conversation,
    createChat: (chat) => mutate((journal) => addChat(journal, chat)),
    appendMessage: (message) => mutate((journal) => addMessage(journal, message)),
    appendActivity: (row) => mutate((journal) => addActivity(journal, row)),
    /** A chat with its rows in one write, however many rows it has. */
    appendChat: ({ chat, messages = [], activity = [] }) => mutate((journal) => {
      let next = addChat(journal, chat);
      for (const message of messages) next = addMessage(next, message);
      for (const row of activity) next = addActivity(next, row);
      return next;
    }),
    async pendingUpload() { return (await loadOwn()).dirty; },
    get problems() { return [...problems]; },
    get exportDoc() { return exportDoc; },
    get projectName() { return exportDoc?.project || state?.journal?.project || project.name; },
  };
}
