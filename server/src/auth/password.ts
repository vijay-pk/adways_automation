import { hash, verify, Algorithm } from '@node-rs/argon2';
import { z } from 'zod';

const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const passwordPolicy = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200)
  .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), 'Password must contain letters and numbers');

export const hashPassword = (password: string) => hash(password, OPTIONS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Used to equalize timing when the account does not exist.
let dummyHash: Promise<string> | null = null;
export async function dummyVerify(password: string) {
  dummyHash ??= hashPassword('dummy-password-for-timing-1');
  await verifyPassword(await dummyHash, password);
}
