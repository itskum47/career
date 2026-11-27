import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
  resolve: {
    alias: {
      '@job-agent/core': path.resolve(__dirname, 'src/core'),
      '@job-agent/discovery': path.resolve(__dirname, 'src/discovery'),
      '@job-agent/jd': path.resolve(__dirname, 'src/jd'),
      '@job-agent/match': path.resolve(__dirname, 'src/match'),
      '@job-agent/resume': path.resolve(__dirname, 'src/resume'),
      '@job-agent/cover': path.resolve(__dirname, 'src/cover'),
      '@job-agent/ats': path.resolve(__dirname, 'src/ats'),
      '@job-agent/browser': path.resolve(__dirname, 'src/browser'),
      '@job-agent/application': path.resolve(__dirname, 'src/application'),
      '@job-agent/profile': path.resolve(__dirname, 'src/profile'),
      '@job-agent/database': path.resolve(__dirname, 'src/database'),
      '@job-agent/shared': path.resolve(__dirname, 'src/shared'),
      '@job-agent/worker': path.resolve(__dirname, 'src/worker'),
      '@job-agent/escalation': path.resolve(__dirname, 'src/escalation'),
      '@job-agent/artifacts': path.resolve(__dirname, 'src/artifacts'),
      '@job-agent/sync': path.resolve(__dirname, 'src/sync'),
      '@apps/orchestrator': path.resolve(__dirname, 'apps/orchestrator'),
    },
  },
});