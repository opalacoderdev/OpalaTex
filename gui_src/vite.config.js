import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function packageNameFromId(id) {
  const normalized = id.replace(/\\/g, '/');
  const marker = '/node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return '';
  const parts = normalized.slice(index + marker.length).split('/');
  if (parts[0]?.startsWith('@')) {
    return `${parts[0]}/${parts[1] || ''}`;
  }
  return parts[0] || '';
}

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
        find: /^pptx-react-viewer$/,
        replacement: path.resolve(__dirname, 'vendor/pptx-react-viewer/packages/react/src/index.ts'),
      },
      {
        find: /^pptx-react-viewer\/i18n$/,
        replacement: path.resolve(__dirname, 'vendor/pptx-react-viewer/packages/react/src/i18n.ts'),
      },
      {
        find: /^pptx-react-viewer\/styles$/,
        replacement: path.resolve(__dirname, 'vendor/pptx-react-viewer/packages/react/dist/pptx-viewer.css'),
      },
      {
        find: /^pptx-react-viewer\/styles\.css$/,
        replacement: path.resolve(__dirname, 'vendor/pptx-react-viewer/packages/react/dist/pptx-viewer.css'),
      },
      {
        find: /^pptx-react-viewer\/theme\.css$/,
        replacement: path.resolve(__dirname, 'vendor/pptx-react-viewer/packages/react/src/styles/theme.css'),
      },
      {
        find: /^pptx-viewer-core$/,
        replacement: path.resolve(__dirname, 'vendor/pptx-react-viewer/packages/core/src/index.ts'),
      },
      {
        find: /^pptx-viewer-core\/converter$/,
        replacement: path.resolve(__dirname, 'vendor/pptx-react-viewer/packages/core/src/converter/index.ts'),
      },
      {
        find: /^pptx-viewer-core\/signature-node$/,
        replacement: path.resolve(__dirname, 'vendor/pptx-react-viewer/packages/core/src/signature-node/index.ts'),
      },
      {
        find: /^pptx-viewer-shared$/,
        replacement: path.resolve(__dirname, 'vendor/pptx-react-viewer/packages/shared/src/index.ts'),
      },
      {
        find: /^pptx-viewer-shared\/i18n$/,
        replacement: path.resolve(__dirname, 'vendor/pptx-react-viewer/packages/shared/src/i18n/index.ts'),
      },
      {
        find: /^pptx-viewer-shared\/theme$/,
        replacement: path.resolve(__dirname, 'vendor/pptx-react-viewer/packages/shared/src/theme/index.ts'),
      },
      {
        find: /^pptx-viewer-shared\/loader$/,
        replacement: path.resolve(__dirname, 'vendor/pptx-react-viewer/packages/shared/src/loader/index.ts'),
      },
      {
        find: /^pptx-viewer-shared\/smartart-3d$/,
        replacement: path.resolve(__dirname, 'vendor/pptx-react-viewer/packages/shared/src/smartart-3d/index.ts'),
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
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');

          if (normalized.includes('/vendor/pptx-react-viewer/packages/react/src/')) {
            return 'vendor-pptx-viewer-source';
          }
          if (normalized.includes('/vendor/pptx-react-viewer/packages/core/src/')) {
            return 'vendor-pptx-core-source';
          }
          if (normalized.includes('/vendor/pptx-react-viewer/packages/shared/src/')) {
            return 'vendor-pptx-shared-source';
          }

          if (id.includes('node_modules')) {
            const packageName = packageNameFromId(id);

            if (
              packageName === 'html2canvas-pro'
              || packageName === 'jspdf'
            ) {
              return 'vendor-pptx-export';
            }
            if (
              packageName === 'jszip'
              || packageName === 'fast-xml-parser'
            ) {
              return 'vendor-pptx-io';
            }
            if (
              packageName === 'yjs'
              || packageName === 'y-webrtc'
              || packageName === 'y-websocket'
              || packageName === 'lib0'
            ) {
              return 'vendor-pptx-collaboration';
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
