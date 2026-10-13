import { Channel, EnrollmentStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { notFound } from '../lib/errors.js';

const CSV_HEADER = ['channel', 'platform_user_id', 'phone', 'display_name', 'enrollment_status'];

function csvCell(v: unknown) {
  const s = v == null ? '' : String(v);
  // Neutralise spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function exportCsv() {
  const rows = await prisma.student.findMany({ orderBy: { createdAt: 'asc' } });
  const lines = rows.map((r) =>
    [r.channel, r.platformUserId, r.normalizedPhone, r.displayName, r.enrollmentStatus].map(csvCell).join(','),
  );
  return [CSV_HEADER.join(','), ...lines].join('\n');
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Imports enrollment records: channel,platform_user_id,phone,display_name,enrollment_status */
export async function importCsv(text: string) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const errors: { line: number; error: string }[] = [];
  let created = 0;
  let updated = 0;
  const start = lines[0]?.toLowerCase().startsWith('channel') ? 1 : 0;
  for (let i = start; i < lines.length && i < 5000; i++) {
    const [channelRaw, platformUserId, phone, displayName, statusRaw] = parseCsvLine(lines[i]);
    const channel = (channelRaw || 'MOCK').toUpperCase() as Channel;
    const status = (statusRaw || 'ACTIVE').toUpperCase() as EnrollmentStatus;
    if (!Object.values(Channel).includes(channel)) {
      errors.push({ line: i + 1, error: `Unknown channel ${channelRaw}` });
      continue;
    }
    if (!Object.values(EnrollmentStatus).includes(status)) {
      errors.push({ line: i + 1, error: `Unknown status ${statusRaw}` });
      continue;
    }
    if (!platformUserId || platformUserId.length < 3) {
      errors.push({ line: i + 1, error: 'platform_user_id is required' });
      continue;
    }
    const existing = await prisma.student.findUnique({ where: { channel_platformUserId: { channel, platformUserId } } });
    const data = {
      normalizedPhone: phone ? phone.replace(/[^\d+]/g, '') : undefined,
      displayName: displayName || undefined,
      enrollmentStatus: status,
    };
    if (existing) {
      await prisma.student.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.student.create({ data: { channel, platformUserId, ...data } });
      created++;
    }
  }
  return { created, updated, errors };
}

/**
 * Deletes a student's messages and derived data. Private (non-reusable) examples from their
 * conversations are deleted; reusable examples are kept but stripped of the original wording.
 */
export async function deleteStudentData(studentId: string) {
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw notFound('Student not found');
  return prisma.$transaction(async (tx) => {
    const jobs = await tx.responseJob.findMany({
      where: { senderExternalId: { in: [student.platformUserId, `web:${student.id}`] } },
      select: { id: true },
    });
    const jobIds = jobs.map((j) => j.id);
    const privateEx = await tx.approvedAnswerExample.deleteMany({ where: { responseJobId: { in: jobIds }, reusable: false } });
    const scrubbed = await tx.approvedAnswerExample.updateMany({
      where: { responseJobId: { in: jobIds }, reusable: true },
      data: { originalQuestion: '[removed]', contextSnapshot: [] as never, responseJobId: null },
    });
    await tx.aiUsage.updateMany({ where: { responseJobId: { in: jobIds } }, data: { responseJobId: null } });
    const deletedJobs = await tx.responseJob.deleteMany({ where: { id: { in: jobIds } } });
    const messages = await tx.incomingMessage.deleteMany({ where: { studentId } });
    await tx.conversation.deleteMany({ where: { studentId } });
    await tx.student.delete({ where: { id: studentId } });
    return { deletedMessages: messages.count, deletedResponses: deletedJobs.count, deletedPrivateExamples: privateEx.count, scrubbedReusableExamples: scrubbed.count };
  });
}
