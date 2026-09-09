import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendTarget = process.env.OPALATEX_BACKEND_URL || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^stream$/,
        replacement: path.resolve(__dirname, 'src/shims/nodeStream.js'),
      },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            // Preserve same-origin semantics across the development proxy.
            // A foreign Origin is kept verbatim so the backend refuses it.
            if (req.headers.origin === `http://${req.headers.host}`) {
              proxyReq.setHeader('origin', new URL(backendTarget).origin);
            }
          });
        }
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
          if (id.includes('node_modules')) {
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
