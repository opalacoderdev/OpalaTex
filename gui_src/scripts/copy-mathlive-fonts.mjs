/**
 * Copy MathLive's font files into `public/` so the equation editor renders
 * correctly offline.
 *
 * MathLive loads its faces at runtime from a directory it is told about
 * (`MathfieldElement.fontsDirectory`), not through the bundler, so the files
 * have to exist as static assets. Copying them at build time keeps them in
 * step with the installed package instead of pinning binaries in the
 * repository.
 */

import { cp, mkdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../node_modules/mathlive/fonts');
const destination = resolve(here, '../public/mathlive-fonts');

try {
  await access(source);
} catch {
  console.warn('[mathlive-fonts] mathlive is not installed; skipping font copy.');
  process.exit(0);
}

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
console.log(`[mathlive-fonts] copied ${source} -> ${destination}`);
