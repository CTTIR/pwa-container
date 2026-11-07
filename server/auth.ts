import fs from 'node:fs';
import { createHmac, randomBytes, randomInt, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

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

export const MIN_PASSWORD_LENGTH = 16;
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** A random password of `length` characters (default 24, about 140 bits). */
export function generatePassword(length = 24): string {
  let out = '';
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[randomInt(0, PASSWORD_ALPHABET.length)];
  return out;
}

export function hashPassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`password must have at least ${MIN_PASSWORD_LENGTH} characters`);
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

export type AuthResult = 'global' | 'survey' | 'other' | 'busy' | 'blocked' | null;

const MAX_PARALLEL_CHECKS = 2;
const MAX_QUEUED_CHECKS = 50;
const GLOBAL_WINDOW_MS = 5 * 60_000;
/** Per source: failures within the window after which further failures are answered with 429. */
export const SOURCE_MAX_FAILURES = 10;
const SOURCE_WINDOW_MS = 15 * 60_000;
/** Per source: sign-ins that may be in progress (checking or pausing after a failure) at once. */
const SOURCE_MAX_CONCURRENT = 2;
const MAX_DELAY_MS = 10_000;
/** Sources past SOURCE_MAX_FAILURES: the pause doubles per further failure up to this. */
const BLOCKED_MAX_DELAY_MS = 5 * 60_000;
const OVERFLOW_KEY = 'overflow';
/** The shared bucket for sources beyond the table limit gets more room than a single source. */
const OVERFLOW_MAX_CONCURRENT = 10;
/**
 * Password checks of cooling-down sources (and of everybody during a broad attack) share one
 * narrow lane: one check at a time, at most one per PENALTY_INTERVAL_MS, short queue.
 */
const PENALTY_PARALLEL = 1;
const PENALTY_QUEUE = 4;
const PENALTY_INTERVAL_MS = 1000;
/** More failures than this within GLOBAL_WINDOW_MS count as a broad attack. */
const GLOBAL_ALARM_FAILURES = 200;
/** Sources that signed in successfully stay on the normal path during a broad attack this long. */
const TRUSTED_FOR_MS = 30 * 24 * 60 * 60_000;
const MAX_TRUSTED_SOURCES = 1000;

interface SourceState {
  failures: number[];
  inFlight: number;
  /** Until then the source is cooling down: attempts are refused without a password check. */
  blockedUntil: number;
}

export interface AdminAuthOptions {
  /** Upper bound of tracked sources; new sources share one bucket beyond it. */
  maxSources?: number;
  /** Pause implementation (tests replace it). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock (tests replace it). */
  now?: () => number;
}

/**
 * Groups client addresses: IPv4 per address, IPv6 per /64 network (one subscriber usually
 * controls a whole /64), IPv4-mapped IPv6 as IPv4.
 */
export function sourceGroup(address: string): string {
  let a = address.trim().toLowerCase();
  if (a.startsWith('::ffff:') && a.includes('.')) a = a.slice(7);
  if (!a.includes(':')) return `v4:${a}`;
  a = a.split('%')[0];
  const [head, tail = ''] = a.split('::');
  const left = head ? head.split(':') : [];
  const right = a.includes('::') && tail ? tail.split(':') : [];
  const groups = a.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `v6:${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}`;
}

export class AdminAuth {
  private file: string;
  private failures: number[] = [];
  private active = 0;
  private waiting: (() => void)[] = [];
  /** Narrow lane for sources with failures or in cooldown. */
  private penaltyLane: Lane;
  /** Separate narrow lane for clean but unknown sources during a broad attack. */
  private cleanLane: Lane;
  /**
   * Sources (as keyed hashes) that signed in successfully, with expiry. Only in memory; used so
   * that known administrators are not slowed down during a broad attack.
   */
  private trusted = new Map<string, number>();
  /**
   * Sign-in attempts per source group. Kept only in memory, only as keyed hashes with a secret
   * that changes on every start, and only for the administration sign-in.
   */
  private sources = new Map<string, SourceState>();
  private sourceSecret = randomBytes(32);
  private maxSources: number;
  private sleep: (ms: number) => Promise<void>;
  private clock: () => number;

  constructor(file: string, options: AdminAuthOptions = {}) {
    this.file = file;
    this.maxSources = options.maxSources ?? 10_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.clock = options.now ?? Date.now;
    this.penaltyLane = new Lane(this.clock, this.sleep);
    this.cleanLane = new Lane(this.clock, this.sleep);
  }

  private read(): CredentialFile {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as CredentialFile;
    } catch {
      return {};
    }
  }

  private recentGlobalFailures(now: number): number {
    this.failures = this.failures.filter((t) => now - t < GLOBAL_WINDOW_MS);
    return this.failures.length;
  }

  /**
   * After a failed attempt: below SOURCE_MAX_FAILURES this is the answer delay (0.6–10 s, the
   * sign-in slot is not held meanwhile); from the limit on it is the cooldown during which the
   * source is refused outright, doubling with every further failure up to five minutes.
   */
  delayFor(state: Pick<SourceState, 'failures'>, now = this.clock()): number {
    const f = state.failures.length;
    if (f >= SOURCE_MAX_FAILURES) return Math.min(MAX_DELAY_MS * 2 ** (f - SOURCE_MAX_FAILURES), BLOCKED_MAX_DELAY_MS);
    return Math.min(600 + 300 * f + 10 * this.recentGlobalFailures(now), MAX_DELAY_MS);
  }

  private sourceState(address: string, now: number): SourceState & { key: string } {
    const prune = (st: SourceState) => {
      st.failures = st.failures.filter((t) => now - t < SOURCE_WINDOW_MS);
      return st;
    };
    let key = createHmac('sha256', this.sourceSecret).update(sourceGroup(address)).digest('base64url');
    const existing = this.sources.get(key);
    if (existing) return Object.assign(prune(existing), { key });
    if (this.sources.size >= this.maxSources) {
      // Only forget sources with nothing to remember; never evict a source with recent failures.
      for (const [k, v] of this.sources) {
        if (k !== OVERFLOW_KEY && v.inFlight === 0 && v.blockedUntil <= now && prune(v).failures.length === 0) this.sources.delete(k);
      }
      if (this.sources.size >= this.maxSources) key = OVERFLOW_KEY;
    }
    let state = this.sources.get(key);
    if (!state) {
      state = { failures: [], inFlight: 0, blockedUntil: 0 };
      this.sources.set(key, state);
    }
    return Object.assign(prune(state), { key });
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
   * only give access to the results of that one survey.
   *
   * Brute-force protection:
   * - per source (IPv4 address or IPv6 /64; the shared overflow bucket and unknown sources
   *   included): at most two checks at the same time, slots held only while checking, a short
   *   growing delay after each failure;
   * - after SOURCE_MAX_FAILURES failures the source cools down (10 s, doubling per further
   *   failure, at most 5 min);
   * - checks of cooling-down sources, and during a broad attack (more than GLOBAL_ALARM_FAILURES
   *   failures in five minutes) of every source with failures of its own, go through the penalty
   *   lane; during an attack clean sources that never signed in successfully use a separate
   *   clean lane. Each lane runs one check at a
   *   time and at most one per second overall. Guessing is therefore limited to about one
   *   attempt per second in total, while correct credentials are never refused outright (under
   *   load they may get 'busy' and have to try again).
   * Long random passwords (see generatePassword) remain the main protection.
   */
  async authenticate(header: string | undefined, surveyId?: string, source = 'unknown'): Promise<AuthResult> {
    if (!header || !header.startsWith('Basic ')) return null;
    const now = this.clock();
    const state = this.sourceState(source, now);
    // Sources with failures of their own (or in cooldown) use the penalty lane. During a broad
    // attack, clean sources that have not signed in successfully before use a separate lane,
    // so failing attackers cannot fill it; known administrators keep the normal path.
    const attack = this.recentGlobalFailures(now) > GLOBAL_ALARM_FAILURES;
    const trusted = (this.trusted.get(state.key) ?? 0) > now;
    const lane =
      state.blockedUntil > now || (attack && state.failures.length > 0)
        ? this.penaltyLane
        : attack && !trusted
          ? this.cleanLane
          : null;
    const limit = state.key === OVERFLOW_KEY ? OVERFLOW_MAX_CONCURRENT : SOURCE_MAX_CONCURRENT;
    if (state.inFlight >= limit) return 'busy';
    state.inFlight += 1;
    let result: AuthResult;
    try {
      result = lane ? await lane.run(() => this.check(header, surveyId)) : await this.check(header, surveyId);
    } finally {
      state.inFlight -= 1;
    }
    if (result === 'global' || result === 'survey') {
      // Successful sign-in for this very page: remember the source as known-good. Existing
      // entries are never evicted early; when the table is full, no new ones are added.
      if (state.key !== OVERFLOW_KEY) {
        if (!this.trusted.has(state.key) && this.trusted.size >= MAX_TRUSTED_SOURCES) {
          for (const [k, until] of this.trusted) if (until <= now) this.trusted.delete(k);
        }
        if (this.trusted.has(state.key) || this.trusted.size < MAX_TRUSTED_SOURCES) this.trusted.set(state.key, now + TRUSTED_FOR_MS);
      }
      return result;
    }
    if (result !== null) return result;
    const failedAt = this.clock();
    state.failures.push(failedAt);
    this.failures.push(failedAt);
    const delay = this.delayFor(state, failedAt);
    if (state.failures.length >= SOURCE_MAX_FAILURES) {
      state.blockedUntil = failedAt + delay;
      return 'blocked';
    }
    await this.sleep(Math.min(delay, MAX_DELAY_MS));
    return null;
  }

  private async check(header: string, surveyId?: string): Promise<AuthResult> {
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
    return this.withSlot(async (): Promise<AuthResult> => {
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
  }
}

/** A narrow check lane: one check at a time, at most one per PENALTY_INTERVAL_MS, short queue. */
class Lane {
  private active = 0;
  private waiting: (() => void)[] = [];
  private last = 0;
  private clock: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(clock: () => number, sleep: (ms: number) => Promise<void>) {
    this.clock = clock;
    this.sleep = sleep;
  }

  async run<T>(fn: () => Promise<T>): Promise<T | 'busy'> {
    if (this.active >= PENALTY_PARALLEL) {
      if (this.waiting.length >= PENALTY_QUEUE) return 'busy';
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      const wait = this.last + PENALTY_INTERVAL_MS - this.clock();
      if (wait > 0) await this.sleep(wait);
      this.last = this.clock();
      return await fn();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
