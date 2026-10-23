// Bringing editor buffers up to date after an agent wrote files on disk.
//
// The agent never edits a buffer: it writes the file. What the editor holds
// for that file is then one of three things, told apart by the disk baseline
// (the content last read from or written to disk for that buffer):
//
// - 'none'     the disk still matches the baseline: this write is already
//              reflected, or did not touch the file;
// - 'reload'   the buffer has no edits of its own (it equals the baseline, or
//              already equals the new disk content): take the disk version;
// - 'conflict' the buffer holds unsaved edits: only the user may decide which
//              version survives. Nothing is discarded without asking.

/** What to do with one buffer once the file's new disk content is known. */
export function agentWriteAction({ baseline, buffer, disk }) {
  if (disk === undefined) return 'none';
  if (baseline !== undefined && disk === baseline) return 'none';
  if (buffer === undefined || buffer === disk) return 'reload';
  if (baseline !== undefined && buffer === baseline) return 'reload';
  return 'conflict';
}

const toSlashes = (value) => String(value ?? '').replace(/\\/g, '/');

/**
 * The project-relative POSIX path a tool argument or a checkpoint entry names,
 * or null when it points outside the project. Tools accept both absolute and
 * project-relative paths.
 */
export function projectRelativePath(path, projectPath, { caseInsensitive = false } = {}) {
  let value = toSlashes(path).trim();
  if (!value) return null;
  const root = toSlashes(projectPath).replace(/\/+$/, '');
  const isAbsolute = value.startsWith('/') || /^[a-z]:\//i.test(value);
  if (isAbsolute) {
    const fold = (text) => (caseInsensitive ? text.toLowerCase() : text);
    if (!root || !fold(value).startsWith(`${fold(root)}/`)) return null;
    value = value.slice(root.length + 1);
  }
  value = value.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!value || value === '.' || value.split('/').includes('..')) return null;
  return value;
}

/**
 * The reconciliation itself, with every piece of editor state reached through
 * `deps` so it always reads the current values (the caller's event handler may
 * be an old closure) and can be exercised without the app.
 *
 *   getProjectPath()           project on screen ('' when none)
 *   caseInsensitive()          whether paths compare case-insensitively
 *   bufferedPaths()            paths that have a buffer (open or cached)
 *   bufferOf(path)             live buffer content, undefined when none
 *   baselineOf(path) / setBaseline(path, content)   disk baseline
 *   samePath(a, b), pathKey(path), isBinary(path)
 *   readDisk(projectPath, path)       file content, undefined on failure
 *   apply(path, content)              replace the buffer with `content`
 *   confirmLoad(path)                 ask the user; true = take the disk
 *   log(kind, path)                   'reloaded' | 'kept'
 *
 * Conflicts are asked one at a time (the dialog has a single slot), and a file
 * already waiting for an answer is not asked about twice.
 */
export function createAgentFileSync(deps) {
  let queue = Promise.resolve();
  const pending = new Set();

  const askAboutConflict = (projectPath, filePath) => {
    const key = deps.pathKey(filePath);
    if (pending.has(key)) return queue;
    pending.add(key);
    queue = queue.then(async () => {
      try {
        if (deps.getProjectPath() !== projectPath) return;
        const load = await deps.confirmLoad(filePath);
        if (!load || deps.getProjectPath() !== projectPath) {
          deps.log('kept', filePath);
          return;
        }
        const content = await deps.readDisk(projectPath, filePath);
        if (content === undefined || deps.getProjectPath() !== projectPath) return;
        deps.setBaseline(filePath, content);
        deps.apply(filePath, content);
        deps.log('reloaded', filePath);
      } finally {
        pending.delete(key);
      }
    });
    return queue;
  };

  const reconcile = async (paths) => {
    const projectPath = deps.getProjectPath();
    if (!projectPath || !paths?.length) return;
    const caseInsensitive = deps.caseInsensitive();
    const relative = paths
      .map((path) => projectRelativePath(path, projectPath, { caseInsensitive }))
      .filter(Boolean);
    const targets = [...new Set(deps.bufferedPaths())].filter((filePath) => (
      !deps.isBinary(filePath) && relative.some((path) => deps.samePath(path, filePath))
    ));
    await Promise.all(targets.map(async (filePath) => {
      const disk = await deps.readDisk(projectPath, filePath);
      if (deps.getProjectPath() !== projectPath) return;
      // Read after the await: a save, or another reconciliation of the same
      // file, may have moved the baseline meanwhile.
      const action = agentWriteAction({
        baseline: deps.baselineOf(filePath),
        buffer: deps.bufferOf(filePath),
        disk,
      });
      if (action === 'none') return;
      // The baseline follows the disk either way, so a kept edit stays marked
      // unsaved and this write is not reported twice.
      deps.setBaseline(filePath, disk);
      if (action === 'reload') deps.apply(filePath, disk);
      else askAboutConflict(projectPath, filePath);
    }));
  };

  return {
    reconcile,
    /** Settles once every conflict question asked so far has been answered. */
    idle: () => queue,
  };
}
