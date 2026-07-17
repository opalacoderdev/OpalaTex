import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^stream$/,
        replacement: path.resolve(__dirname, 'src/shims/nodeStream.js'),
      },
      {
        find: /^@docx-editor\.dev\/react$/,
        replacement: path.resolve(__dirname, 'vendor/docx-editor/react/opalatex-entry.ts'),
      },
      {
        find: /^@docx-editor\.dev\/react\/ui$/,
        replacement: path.resolve(__dirname, 'vendor/docx-editor/react/ui.ts'),
      },
      {
        find: /^@docx-editor\.dev\/react\/dialogs$/,
        replacement: path.resolve(__dirname, 'vendor/docx-editor/react/components/dialogs/index.ts'),
      },
      {
        find: /^@docx-editor\.dev\/react\/hooks$/,
        replacement: path.resolve(__dirname, 'vendor/docx-editor/react/hooks/index.ts'),
      },
      {
        find: /^@docx-editor\.dev\/react\/plugin-api$/,
        replacement: path.resolve(__dirname, 'vendor/docx-editor/react/plugin-api/index.ts'),
      },
      {
        find: /^@docx-editor\.dev\/react\/styles$/,
        replacement: path.resolve(__dirname, 'vendor/docx-editor/react/styles/index.ts'),
      },
      {
        find: /^@docx-editor\.dev\/core$/,
        replacement: path.resolve(__dirname, 'vendor/docx-editor/core/opalatex-core.ts'),
      },
      {
        find: /^@docx-editor\.dev\/core\/utils$/,
        replacement: path.resolve(__dirname, 'vendor/docx-editor/core/opalatex-utils.ts'),
      },
      {
        find: /^@docx-editor\.dev\/core\/agent$/,
        replacement: path.resolve(__dirname, 'vendor/docx-editor/core/opalatex-agent.ts'),
      },
      {
        find: /^@docx-editor\.dev\/core\/(.*)$/,
        replacement: path.resolve(__dirname, 'vendor/docx-editor/core/$1'),
      },
      {
        find: /^@docx-editor\.dev\/i18n$/,
        replacement: path.resolve(__dirname, 'vendor/docx-editor/i18n/index.ts'),
      },
      {
        find: /^@docx-editor\.dev\/i18n\/(.*)$/,
        replacement: path.resolve(__dirname, 'vendor/docx-editor/i18n/$1.ts'),
      },
      // ── PPTX Editor (vendored) ──
      {
        find: /^@pptx-editor\/react$/,
        replacement: path.resolve(__dirname, 'vendor/pptx-editor/react/index.ts'),
      },
      {
        find: /^@pptx-editor\/core$/,
        replacement: path.resolve(__dirname, 'vendor/pptx-editor/core/index.ts'),
      },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: path.resolve(__dirname, '../opalatex/gui'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (
              id.includes('pptx-react-viewer')
              || id.includes('pptx-viewer')
              || id.includes('html2canvas-pro')
              || id.includes('jspdf')
            ) {
              return 'vendor-pptx-viewer';
            }
            if (id.includes('react') || id.includes('react-dom')) {
              return 'vendor-react';
            }
            if (id.includes('@monaco-editor')) {
              return 'vendor-monaco';
            }
            if (id.includes('@xterm')) {
              return 'vendor-xterm';
            }
          }
        }
      }
    }
  }
});
