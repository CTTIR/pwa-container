import type { Answers } from '../shared/schema.ts';
import { isSurveyResponse, type SurveyResponse } from './api.ts';

// Browser storage on the participant's device. Every access is guarded because storage can
// be unavailable (private mode, blocked site data); the survey must still work without it.
//
// Privacy: nothing here records when somebody took part. Drafts and outboxes carry only an
// expiry time (milliseconds, set once when they are created, never sent anywhere) so that
// unfinished answers disappear from the device after at most KEEP_MS. For surveys with access
// codes the "done" flag lives in sessionStorage only, so no lasting participation marker stays.

const PREFIX = 'pwa-container';
/** How long unsent answers (draft, outbox) stay on the device. */
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

type Area = 'local' | 'session';

function area(which: Area): Storage {
  return which === 'session' ? window.sessionStorage : window.localStorage;
}

function get<T>(key: string, which: Area = 'local'): T | null {
  try {
    const raw = area(which).getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function set(key: string, value: unknown, which: Area = 'local'): void {
  try {
    area(which).setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep working in memory */
  }
}

function remove(key: string, which: Area = 'local'): void {
  try {
    area(which).removeItem(key);
  } catch {
    /* ignore */
  }
}

function keys(): string[] {
  try {
    const ls = window.localStorage;
    const out: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k !== null) out.push(k);
    }
    return out;
  } catch {
    return [];
  }
}

export interface Draft {
  answers: Answers;
  step: number;
  code?: string;
  course?: string | null;
  /** Epoch milliseconds after which the draft is discarded. Never leaves the device. */
  expiresAt?: number;
}

export interface Outbox {
  submissionId: string;
  surveyVersion: number;
  answers: Answers;
  code?: string;
  course?: string | null;
  /** Epoch milliseconds after which the outbox is discarded. Never sent to the server. */
  expiresAt?: number;
}

const draftKey = (id: string, version: number) => `${PREFIX}:draft:${id}:v${version}`;
const outboxKey = (id: string) => `${PREFIX}:outbox:${id}`;
const doneKey = (id: string) => `${PREFIX}:done:${id}`;
const definitionKey = (id: string) => `${PREFIX}:definition:${id}`;

const freshExpiry = () => Date.now() + KEEP_MS;
const expired = (v: { expiresAt?: unknown } | null) => !!v && typeof v.expiresAt === 'number' && v.expiresAt <= Date.now();

function loadExpiring<T extends { expiresAt?: number }>(key: string): T | null {
  const v = get<T>(key);
  if (!v || typeof v !== 'object') return null;
  if (expired(v)) {
    remove(key);
    return null;
  }
  return v;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const storage = {
  loadDraft: (id: string, version: number) => loadExpiring<Draft>(draftKey(id, version)),
  /**
   * Saves a draft. An existing draft under the same key keeps its expiry; otherwise `expiresAt`
   * (e.g. carried over from an older version's draft) or a fresh one is used.
   */
  saveDraft: (id: string, version: number, draft: Omit<Draft, 'expiresAt'>, expiresAt?: number) => {
    const key = draftKey(id, version);
    const previous = get<Draft>(key);
    const keep = previous && typeof previous.expiresAt === 'number' && !expired(previous) ? previous.expiresAt : undefined;
    set(key, { ...draft, expiresAt: keep ?? expiresAt ?? freshExpiry() });
  },
  clearDraft: (id: string, version: number) => remove(draftKey(id, version)),
  /** Drafts of this survey saved under other definition versions, newest version first. */
  otherDrafts: (id: string, exceptVersion: number): { version: number; draft: Draft }[] => {
    const pattern = new RegExp(`^${escapeRegExp(`${PREFIX}:draft:${id}:v`)}(\\d+)$`);
    const out: { version: number; draft: Draft }[] = [];
    for (const k of keys()) {
      const m = k.match(pattern);
      if (!m) continue;
      const version = Number(m[1]);
      if (version === exceptVersion) continue;
      const draft = loadExpiring<Draft>(k);
      if (draft) out.push({ version, draft });
    }
    return out.sort((a, b) => b.version - a.version);
  },
  /** Removes the drafts of every version of this survey. */
  clearAllDrafts: (id: string) => {
    const prefix = `${PREFIX}:draft:${id}:v`;
    for (const k of keys()) if (k.startsWith(prefix)) remove(k);
  },
  loadOutbox: (id: string) => loadExpiring<Outbox>(outboxKey(id)),
  saveOutbox: (id: string, outbox: Outbox) => set(outboxKey(id), { ...outbox, expiresAt: outbox.expiresAt ?? freshExpiry() }),
  clearOutbox: (id: string) => remove(outboxKey(id)),
  /**
   * `sessionOnly` (surveys with access codes): the flag lives in sessionStorage only, and a
   * lasting flag from an older app version is removed.
   */
  isDone: (id: string, sessionOnly: boolean) => {
    if (!sessionOnly) return get<boolean>(doneKey(id)) === true;
    remove(doneKey(id));
    return get<boolean>(doneKey(id), 'session') === true;
  },
  markDone: (id: string, sessionOnly: boolean) => {
    set(doneKey(id), true, sessionOnly ? 'session' : 'local');
    remove(doneKey(id), sessionOnly ? 'local' : 'session');
  },
  clearDone: (id: string) => {
    remove(doneKey(id));
    remove(doneKey(id), 'session');
  },
  /** Last definition (and status) loaded from the server, for offline visits. */
  loadDefinitionCopy: (id: string): SurveyResponse | null => {
    const v = get<unknown>(definitionKey(id));
    return isSurveyResponse(v) ? v : null;
  },
  saveDefinitionCopy: (id: string, data: SurveyResponse) =>
    set(definitionKey(id), { definition: data.definition, status: data.status, opensAt: data.opensAt, closesAt: data.closesAt }),
  /**
   * Discards expired drafts and outboxes of every survey on this device. Entries without an
   * expiry (older app version) get one now; an expiry further away than KEEP_MS (clock was
   * wrong) is pulled in.
   */
  sweepExpired: () => {
    const now = Date.now();
    for (const k of keys()) {
      if (!k.startsWith(`${PREFIX}:draft:`) && !k.startsWith(`${PREFIX}:outbox:`)) continue;
      const v = get<{ expiresAt?: unknown }>(k);
      if (!v || typeof v !== 'object') {
        remove(k);
      } else if (typeof v.expiresAt !== 'number' || v.expiresAt > now + KEEP_MS) {
        set(k, { ...v, expiresAt: now + KEEP_MS });
      } else if (v.expiresAt <= now) {
        remove(k);
      }
    }
  },
};

export function newSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
