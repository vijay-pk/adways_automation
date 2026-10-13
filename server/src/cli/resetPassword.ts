/**
 * Break-glass password reset for server operators: prints a one-time reset token
 * (valid 60 minutes) to use on the dashboard "Reset password" page.
 * Usage: npm run admin:reset-password -- admin@example.com
 */
import { prisma } from '../db/prisma.js';
import { issueResetToken } from '../auth/authService.js';
import { audit } from '../audit/auditService.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run admin:reset-password -- <email>');
  process.exit(1);
}
const admin = await prisma.administrator.findUnique({ where: { email } });
if (!admin) {
  console.error('No administrator with that email.');
  process.exit(1);
}
const token = await issueResetToken(admin.id);
await audit(null, 'admin.reset_token_cli', 'administrator', admin.id);
console.log(`One-time reset token (expires in 60 minutes):\n${token}`);
await prisma.$disconnect();
