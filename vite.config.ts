/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import path from 'path';

const devPort = Number.parseInt(process.env.AEON_VITE_PORT ?? '5173', 10);
const devHost = process.env.AEON_VITE_HOST ?? 'localhost';
const viteOnly = process.env.AEON_VITE_ONLY === '1';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    ...(process.env.VITEST
      ? []
      : [
          electron([
          {
        entry: 'electron/main.ts',
        onstart(args) {
          if (!viteOnly) {
            args.startup();
          }
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron', 'ffmpeg-static', 'ws', 'bufferutil', 'utf-8-validate'],
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(args) {
          if (!viteOnly) {
            args.reload();
          }
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
        ]),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'url': path.resolve(__dirname, 'src/shims/url.ts'),
    },
  },
  optimizeDeps: {
    // Include the PixiJS 8 Live2D runtime so Vite pre-bundles each runtime entry.
    include: [
      'pixi.js',
      'gsap',
      'untitled-pixi-live2d-engine/cubism-legacy',
      'untitled-pixi-live2d-engine/cubism',
    ],
    esbuildOptions: {
      alias: {
        'url': path.resolve(__dirname, 'src/shims/url.ts'),
      },
    },
  },
  server: {
    host: devHost,
    port: devPort,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4500,
    commonjsOptions: {
      include: [/node_modules/],
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return;
          }
          if (id.includes('monaco-editor') || id.includes('@monaco-editor')) {
            return 'editor-monaco';
          }
          // The legacy engine reads Live2D globals at module scope. Keep it
          // behind its dynamic import; merging it with eagerly imported Pixi
          // makes cold startup execute it before runtime-bootstrap settles.
          if (id.includes('untitled-pixi-live2d-engine')) {
            return id.includes('cubism-legacy') ? 'live2d-legacy-runtime' : 'live2d-cubism-runtime';
          }
          if (
            id.includes('eventemitter3') ||
            id.includes('pixi.js') ||
            id.includes('pixi-filters') ||
            id.includes('@pixi/')
          ) {
            return 'render-runtime';
          }
          if (id.includes('gsap')) {
            return 'animation-runtime';
          }
          if (id.includes('react-dom') || id.includes('react')) {
            return 'react-runtime';
          }
          if (id.includes('yjs')) {
            return 'collab-runtime';
          }
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['src/__tests__/setup.ts'],
    exclude: ['node_modules', 'dist', 'dist-electron', '.claude/**', 'tests/e2e/**', 'test-results/**'],
    pool: 'threads',
    maxWorkers: 4,
  },
});
