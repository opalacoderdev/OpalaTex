import { defineConfig } from 'vitest/config';

// Scoped on purpose: the vendored editor ships a large upstream test suite that
// this repository does not run. Only the equation code added here is wired up,
// so `npm run test:math` stays fast and meaningful.
export default defineConfig({
  test: {
    include: [
      'vendor/docx-editor/core/math/**/*.test.ts',
      'vendor/docx-editor/core/flow-model/metrics/mathMetrics.test.ts',
      'vendor/docx-editor/core/painter-model/renderParagraph/mathRun.test.ts',
    ],
    environment: 'node',
  },
});
