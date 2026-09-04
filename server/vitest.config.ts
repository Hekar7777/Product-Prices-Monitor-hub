import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    // Each test file gets its own process and its own in-memory database, so
    // files are fully isolated and can run in parallel.
    pool: 'forks',
    poolOptions: {
      forks: {
        // `node:sqlite` is still flagged experimental; the notice would
        // otherwise be printed once per worker process.
        execArgv: ['--disable-warning=ExperimentalWarning'],
      },
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['default'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    },
  },
});
