// Inline creation of files, directories and presentations in the workspace
// tree. The tree row only collects a name; these helpers decide which path that
// name stands for and which directories must be expanded to show the row.

const toSlashes = (value) => String(value ?? '').replace(/\\/g, '/');

export const normalizeTreePath = (value) => toSlashes(value).replace(/\/+$/g, '');

export const isSameTreePath = (left, right) => normalizeTreePath(left) === normalizeTreePath(right);

/** Whether `dirPath` is `targetPath` or one of its ancestors. */
export const treePathContains = (dirPath, targetPath) => {
  const dir = normalizeTreePath(dirPath);
  const target = normalizeTreePath(targetPath);
  if (!dir) return false;
  return target === dir || target.startsWith(`${dir}/`);
};

/** Names of the entries directly inside `parentPath` ('' is the project root). */
export const childNamesAt = (tree, parentPath) => {
  const target = normalizeTreePath(parentPath);
  let nodes = Array.isArray(tree) ? tree : [];
  if (target) {
    const findDir = (list) => {
      for (const node of list) {
        if (!node.isDirectory) continue;
        if (isSameTreePath(node.path, target)) return node;
        if (treePathContains(node.path, target)) return findDir(node.children || []);
      }
      return null;
    };
    nodes = findDir(nodes)?.children || [];
  }
  return nodes.map((node) => node.name);
};

/** First of `stem.ext`, `stem-2.ext`, ... not taken by `existingNames` (case-insensitive). */
export const suggestUniqueName = (stem, extension, existingNames = []) => {
  const taken = new Set(existingNames.map((name) => String(name).toLowerCase()));
  for (let index = 1; ; index += 1) {
    const candidate = `${stem}${index === 1 ? '' : `-${index}`}${extension}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
};

/**
 * Resolve the name typed in the tree into a project-relative path.
 *
 * Returns `{ path }` for a valid name, `{ cancelled: true }` for an empty one
 * (nothing is created), or `{ error: 'invalid' }` for an absolute path or a name
 * with empty, "." or ".." segments. Nested names such as `a/b` are allowed.
 * Presentations get the `.jpt` extension that routes them to the deck editor.
 */
export const resolveInlineCreatePath = ({ kind, parentPath = '', name }) => {
  const trimmed = toSlashes(name).trim();
  if (!trimmed) return { cancelled: true };
  if (trimmed.startsWith('/') || /^[a-z]:/i.test(trimmed)) return { error: 'invalid' };

  const segments = trimmed.replace(/\/+$/g, '').split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { error: 'invalid' };
  }

  let relative = segments.join('/');
  if (kind === 'presentation' && !/\.jpt$/i.test(relative)) {
    relative = `${relative.replace(/\.json$/i, '')}.jpt`;
  }

  const parent = normalizeTreePath(parentPath);
  return { path: parent ? `${parent}/${relative}` : relative };
};
