import fs from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Admin access uses HTTP Basic authentication over HTTPS. Passwords are stored as scrypt
// hashes in a JSON file that is mounted into the container and never committed:
// { "global": [{ "user": "...", "hash": "scrypt$..." }], "surveys": { "<surveyId>": [ ... ] } }

interface Credential {
  user: string;
  hash: string;
}

interface CredentialFile {
  global?: Credential[];
  surveys?: Record<string, Credential[]>;
}

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

export function hashPassword(password: string): string {
  if (password.length < 12) throw new Error('password must have at least 12 characters');
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  try {
    const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function safeEqualText(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class AdminAuth {
  private file: string;
  private failures: number[] = [];

  constructor(file: string) {
    this.file = file;
  }

  private read(): CredentialFile {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as CredentialFile;
    } catch {
      return {};
    }
  }

  /** True when too many failed attempts happened recently (simple global brake). */
  throttled(now = Date.now()): boolean {
    this.failures = this.failures.filter((t) => now - t < 5 * 60_000);
    return this.failures.length >= 30;
  }

  /**
   * Checks an Authorization header. Global credentials give full access; survey credentials
   * only give access to the results of that one survey.
   */
  authenticate(header: string | undefined, surveyId?: string): 'global' | 'survey' | 'other' | null {
    if (!header || !header.startsWith('Basic ')) return null;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 1) return null;
    const user = decoded.slice(0, sep);
    const password = decoded.slice(sep + 1);
    const creds = this.read();
    const matches = (list: Credential[] | undefined) =>
      (list ?? []).some(
        (c) => typeof c?.user === 'string' && typeof c?.hash === 'string' && safeEqualText(c.user, user) && verifyPassword(password, c.hash),
      );
    if (matches(creds.global)) return 'global';
    if (surveyId && matches(creds.surveys?.[surveyId])) return 'survey';
    // Valid credentials of another survey are not a failed attempt, but give no access here.
    const otherSurvey = Object.values(creds.surveys ?? {}).some((list) => matches(list));
    if (otherSurvey) return 'other';
    this.failures.push(Date.now());
    return null;
  }
}
