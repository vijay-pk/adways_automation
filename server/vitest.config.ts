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
      WHATSAPP_WEB_SESSION_DIR: '.test-wa-session',
      // Real Cloud API credentials from .env must never reach tests (tests inject their own config).
      WHATSAPP_CLOUD_PHONE_NUMBER_ID: '',
      WHATSAPP_CLOUD_ACCESS_TOKEN: '',
      WHATSAPP_CLOUD_APP_SECRET: '',
      WHATSAPP_CLOUD_VERIFY_TOKEN: '',
      SESSION_SECRET: 'test-secret-test-secret-test-secret-123',
    },
  },
});
