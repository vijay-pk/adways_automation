import { prisma, type Db } from '../db/prisma.js';

export async function audit(
  adminId: string | null,
  action: string,
  resourceType?: string,
  resourceId?: string,
  metadata?: Record<string, unknown>,
  db: Db = prisma,
) {
  await db.auditLog.create({
    data: { administratorId: adminId, action, resourceType, resourceId, metadata: metadata as never },
  });
}
