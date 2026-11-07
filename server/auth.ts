import fs from 'node:fs';
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

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

function scryptAsync(password: string, salt: Buffer, length: number, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, length, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Verifies a password against an encoded scrypt hash (runs off the main thread). */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  try {
    const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
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

/** Used when no user name matches, so unknown and known user names take equally long. */
const DUMMY_HASH = hashPassword('dummy password never used');

export type AuthResult = 'global' | 'survey' | 'other' | 'busy' | null;

const MAX_PARALLEL_CHECKS = 2;
const MAX_QUEUED_CHECKS = 50;
const FAILURE_WINDOW_MS = 5 * 60_000;

export class AdminAuth {
  private file: string;
  private failures: number[] = [];
  private active = 0;
  private waiting: (() => void)[] = [];

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

  /**
   * Pause before answering a failed attempt. It grows with the number of recent failures, so
   * guessing gets slower, but it never blocks correct credentials.
   */
  failureDelay(now = Date.now()): number {
    this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    return Math.min(600 + this.failures.length * 150, 5000);
  }

  /** Limits concurrent password checks so a flood of attempts cannot exhaust the CPU. */
  private async withSlot<T>(fn: () => Promise<T>): Promise<T | 'busy'> {
    if (this.active >= MAX_PARALLEL_CHECKS) {
      if (this.waiting.length >= MAX_QUEUED_CHECKS) return 'busy';
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  /**
   * Checks an Authorization header. Global credentials give full access; survey credentials
   * only give access to the results of that one survey. Correct credentials are always
   * accepted; only failures are slowed down (see failureDelay).
   */
  async authenticate(header: string | undefined, surveyId?: string): Promise<AuthResult> {
    if (!header || !header.startsWith('Basic ')) return null;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 1 || decoded.length > 1024) return null;
    const user = decoded.slice(0, sep);
    const password = decoded.slice(sep + 1);
    const creds = this.read();
    const valid = (c: Credential | undefined): c is Credential => typeof c?.user === 'string' && typeof c?.hash === 'string';
    const scopes: { scope: 'global' | 'survey' | 'other'; cred: Credential }[] = [];
    for (const c of creds.global ?? []) if (valid(c) && safeEqualText(c.user, user)) scopes.push({ scope: 'global', cred: c });
    for (const [id, list] of Object.entries(creds.surveys ?? {})) {
      for (const c of list ?? []) {
        if (valid(c) && safeEqualText(c.user, user)) scopes.push({ scope: id === surveyId ? 'survey' : 'other', cred: c });
      }
    }
    const result = await this.withSlot(async (): Promise<AuthResult> => {
      if (scopes.length === 0) {
        await verifyPassword(password, DUMMY_HASH);
        return null;
      }
      let best: AuthResult = null;
      const rank = { global: 3, survey: 2, other: 1 } as const;
      for (const { scope, cred } of scopes) {
        if ((best === null || rank[scope] > rank[best as keyof typeof rank]) && (await verifyPassword(password, cred.hash))) best = scope;
      }
      return best;
    });
    if (result === null) this.failures.push(Date.now());
    return result;
  }
}
