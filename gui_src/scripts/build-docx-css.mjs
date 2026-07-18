import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  [
    'node_modules/tailwindcss/lib/cli.js',
    '-c',
    'vendor/docx-editor/react/tailwind.config.cjs',
    '-i',
    'vendor/docx-editor/core/styles/editor.css',
    '-o',
    'vendor/docx-editor/react/styles/editor.compiled.css',
    '--minify',
  ],
  {
    env: {
      ...process.env,
      BROWSERSLIST_IGNORE_OLD_DATA: '1',
    },
    shell: false,
    stdio: 'inherit',
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
