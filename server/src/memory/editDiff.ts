import { prisma } from '../db/prisma.js';

export interface EditSummary {
  draftChars: number;
  finalChars: number;
  lengthChange: number;
  removedTerms: string[];
  addedTerms: string[];
  categories: string[];
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []);

/** Lightweight word-level diff used to spot recurring correction patterns. */
export function summarizeEdit(draft: string, final: string): EditSummary {
  const a = words(draft);
  const b = words(final);
  const removed = [...a].filter((w) => !b.has(w));
  const added = [...b].filter((w) => !a.has(w));
  const categories: string[] = [];
  const change = final.length - draft.length;
  if (draft.length && change < -draft.length * 0.25) categories.push('shortened');
  if (draft.length && change > draft.length * 0.25) categories.push('expanded');
  if (/\d/.test(final) && !/\d/.test(draft)) categories.push('added_numbers');
  if (/example|e\.g\.|for instance/i.test(final) && !/example|e\.g\.|for instance/i.test(draft)) categories.push('added_example');
  if (removed.length > 0 && added.length > 0 && categories.length === 0) categories.push('reworded');
  return {
    draftChars: draft.length,
    finalChars: final.length,
    lengthChange: change,
    removedTerms: removed.slice(0, 30),
    addedTerms: added.slice(0, 30),
    categories,
  };
}

/** Aggregates admin edits to show recurring correction patterns. */
export async function correctionPatterns() {
  const edited = await prisma.approvedAnswerExample.findMany({
    where: { wasEdited: true },
    select: { editSummary: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const cat = new Map<string, number>();
  const removed = new Map<string, number>();
  const added = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const e of edited) {
    const s = e.editSummary as EditSummary | null;
    if (!s) continue;
    s.categories.forEach((c) => bump(cat, c));
    s.removedTerms.forEach((t) => bump(removed, t));
    s.addedTerms.forEach((t) => bump(added, t));
  }
  const top = (m: Map<string, number>) =>
    [...m.entries()].filter(([, n]) => n > 1).sort((x, y) => y[1] - x[1]).slice(0, 15).map(([term, count]) => ({ term, count }));
  const total = await prisma.approvedAnswerExample.count();
  return {
    totalExamples: total,
    editedExamples: edited.length,
    editRate: total ? edited.length / total : 0,
    categories: [...cat.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    frequentlyRemovedTerms: top(removed),
    frequentlyAddedTerms: top(added),
  };
}
