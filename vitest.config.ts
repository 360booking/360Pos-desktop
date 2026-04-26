import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/core/pos-core/**/*.ts', 'src/lib/sync/**/*.ts', 'src/lib/db/**/*.ts'],
      exclude: [
        '**/__tests__/**',
        'src/core/pos-core/**/index.ts',
        'src/lib/sync/bootstrap.ts',           // requires Tauri runtime
        'src/lib/sync/useSyncStatus.ts',       // React hook, covered separately later
        'src/lib/db/tauriExecutor.ts',         // wraps tauri-plugin-sql
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
