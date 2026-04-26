import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Tauri configures its own protocol; Vite must serve at a fixed port and
// not clear the screen so Tauri's logs survive next to Vite's.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Tauri expects a fixed port and opens it itself; never auto-open in browser.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      // Don't try to watch the Rust shell from the Vite side.
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*', 'POS_BUILD_PROFILE'],
  build: {
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: true,
    outDir: 'dist',
  },
}));
