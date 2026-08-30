import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.resolve(here, 'vendor/pptx-react-viewer/packages');

/**
 * Test runner for the vendored pptx-viewer packages.
 *
 * The vendor tree is compiled from source by Vite (see vite.config.js) but has
 * no node_modules of its own, so its cross-package imports are resolved here
 * the same way the app resolves them.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^pptx-viewer-core$/, replacement: path.join(vendor, 'core/src/index.ts') },
      { find: /^pptx-viewer-shared$/, replacement: path.join(vendor, 'shared/src/index.ts') },
      { find: /^pptx-viewer-locales$/, replacement: path.join(vendor, 'locales/src/index.ts') },
      // Sub-path entry points, mirroring the aliases in vite.config.js.
      { find: /^pptx-viewer-shared\/(.*)$/, replacement: path.join(vendor, 'shared/src/$1/index.ts') },
      { find: /^pptx-viewer-core\/(.*)$/, replacement: path.join(vendor, 'core/src/$1/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: [
      'vendor/pptx-react-viewer/packages/shared/src/**/*.test.ts',
      'vendor/pptx-react-viewer/packages/react/src/viewer/hooks/**/*.test.ts',
      'vendor/pptx-react-viewer/packages/locales/src/**/*.test.ts',
      'vendor/pptx-react-viewer/packages/react/src/viewer/components/toolbar/Toolbar.test.tsx',
    ],
    // These two assert that `three` is *absent* and take the no-op path. It is
    // present in this app's dependency tree, so they cannot hold here; they are
    // upstream's, and unrelated to anything OpalaTex changes.
    exclude: [
      'vendor/pptx-react-viewer/packages/shared/src/render/model3d-scene.test.ts',
      'vendor/pptx-react-viewer/packages/shared/src/render/surface-chart-3d-scene.test.ts',
    ],
  },
});
