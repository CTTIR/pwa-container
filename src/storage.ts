import type { Answers } from '../shared/schema.ts';

// Browser storage on the participant's device. Every access is guarded because storage can
// be unavailable (private mode, blocked site data); the survey must still work without it.

const PREFIX = 'pwa-container';

function get<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function set(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep working in memory */
  }
}

function remove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export interface Draft {
  answers: Answers;
  step: number;
  code?: string;
  course?: string | null;
}

export interface Outbox {
  submissionId: string;
  surveyVersion: number;
  answers: Answers;
  code?: string;
  course?: string | null;
}

const draftKey = (id: string, version: number) => `${PREFIX}:draft:${id}:v${version}`;
const outboxKey = (id: string) => `${PREFIX}:outbox:${id}`;
const doneKey = (id: string) => `${PREFIX}:done:${id}`;

export const storage = {
  loadDraft: (id: string, version: number) => get<Draft>(draftKey(id, version)),
  saveDraft: (id: string, version: number, draft: Draft) => set(draftKey(id, version), draft),
  clearDraft: (id: string, version: number) => remove(draftKey(id, version)),
  loadOutbox: (id: string) => get<Outbox>(outboxKey(id)),
  saveOutbox: (id: string, outbox: Outbox) => set(outboxKey(id), outbox),
  clearOutbox: (id: string) => remove(outboxKey(id)),
  isDone: (id: string) => get<boolean>(doneKey(id)) === true,
  markDone: (id: string) => set(doneKey(id), true),
  clearDone: (id: string) => remove(doneKey(id)),
};

export function newSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
