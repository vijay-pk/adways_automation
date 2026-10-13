import { authenticator } from 'otplib';

authenticator.options = { window: 1 };

export const generateTotpSecret = () => authenticator.generateSecret();
export const totpUri = (email: string, secret: string) => authenticator.keyuri(email, 'Course Tutor Admin', secret);
export const verifyTotp = (secret: string, code: string) => {
  try {
    return authenticator.verify({ token: code.replace(/\s/g, ''), secret });
  } catch {
    return false;
  }
};
