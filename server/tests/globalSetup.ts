import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

/** Applies all migrations to the isolated test schema before the suite runs. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL!;
  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
  return () => rmSync('.test-uploads', { recursive: true, force: true });
}
