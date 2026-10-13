import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

config();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('TEST_DATABASE_URL must be set for tests (use a separate schema, e.g. ?schema=tutor_test)');
if (testUrl === process.env.DATABASE_URL) throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL');

export default defineConfig({
  test: {
    globalSetup: ['./tests/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testUrl,
      DIRECT_URL: testUrl,
      AI_PROVIDER: 'mock',
      WORKER_ENABLED: 'false',
      ENABLE_DEV_ROUTES: 'false',
      UPLOAD_DIR: '.test-uploads',
      SESSION_SECRET: 'test-secret-test-secret-test-secret-123',
    },
  },
});
