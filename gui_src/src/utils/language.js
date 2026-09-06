// Maps a file extension to the Monaco Editor language identifier.

const EXT_MAP = {
  py: 'python',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  html: 'html',
  css: 'css',
  json: 'json',
  // A presentation is JSON. It normally opens in the deck editor rather than in
  // Monaco, but every surface that does show it as text — a diff, a checkpoint
  // preview — should highlight it as what it is.
  jpt: 'json',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  tex: 'latex',
};

export const getLanguage = (filename) => {
  if (!filename) return 'plaintext';
  const ext = filename.split('.').pop().toLowerCase();
  return EXT_MAP[ext] || 'plaintext';
};
