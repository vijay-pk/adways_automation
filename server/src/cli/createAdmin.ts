/**
 * One-time bootstrap: creates the first super admin from INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD.
 * Does nothing if any administrator already exists. The password must be changed at first login.
 */
import { bootstrapInitialAdmin } from '../auth/authService.js';
import { prisma } from '../db/prisma.js';

try {
  const result = await bootstrapInitialAdmin(process.env.INITIAL_ADMIN_EMAIL, process.env.INITIAL_ADMIN_PASSWORD);
  if (result.created) {
    console.log(`Created super admin ${result.admin.email}. A password change is required at first login.`);
    console.log('Remove INITIAL_ADMIN_PASSWORD from your environment now.');
  } else {
    console.log('An administrator already exists; nothing was created.');
  }
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
