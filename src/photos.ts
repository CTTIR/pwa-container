// Photos on the participant's device until the server has them. They live in IndexedDB (too
// big for localStorage), keyed by a random id that also goes into the answers. Like drafts they
// expire after KEEP_MS. Photos are re-encoded in the browser before they are stored: this drops
// all camera metadata (EXIF with GPS position and time, maker notes, XMP) and shrinks them.

import { KEEP_MS } from './storage.ts';

const DB_NAME = 'pwa-container-photos';
const STORE = 'photos';
/** Longest side of a stored photo in pixels, and its JPEG quality. */
const MAX_SIDE = 1600;
const QUALITY = 0.82;

interface PhotoRecord {
  id: string;
  survey: string;
  blob: Blob;
  expiresAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('survey', 'survey');
      };
      req.onsuccess = () => {
        const db = req.result;
        // A lost connection (iOS after some time in the background) or a newer version elsewhere:
        // open a fresh connection next time instead of failing for the rest of the session.
        db.onclose = () => (dbPromise = null);
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        resolve(null);
      };
      req.onblocked = () => {
        dbPromise = null;
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** A failed storage operation, as opposed to an empty result. */
const FAILED = Symbol('failed');

function attempt<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null | typeof FAILED> {
  return openDb().then(
    (db) =>
      new Promise<T | null | typeof FAILED>((resolve) => {
        if (!db) return resolve(FAILED);
        try {
          const tx = db.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req ? (req.result as T) : null);
          tx.onerror = () => resolve(FAILED);
          tx.onabort = () => resolve(FAILED);
        } catch {
          // e.g. InvalidStateError on a connection that was closed meanwhile.
          dbPromise = null;
          resolve(FAILED);
        }
      }),
  );
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  let r = await attempt(mode, fn);
  if (r === FAILED) r = await attempt(mode, fn); // once more on a fresh connection
  return r === FAILED ? null : r;
}

export function newPhotoId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether photos can be kept on this device at all (IndexedDB works). */
export async function photosAvailable(): Promise<boolean> {
  return (await openDb()) !== null;
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode'));
    };
    img.src = url;
  });
}

/**
 * Decodes a picked image, turns it upright, scales it to at most MAX_SIDE and encodes it as a
 * fresh JPEG. The canvas carries no metadata over, so nothing but the pixels leaves the device.
 */
export async function preparePhoto(file: Blob): Promise<Blob> {
  // Image elements apply the EXIF orientation when drawn (image-orientation: from-image).
  const img = await loadImage(file);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error('decode');
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('encode');
  return blob;
}

export const photoDb = {
  save: async (survey: string, id: string, blob: Blob): Promise<boolean> =>
    (await run('readwrite', (s) => s.put({ id, survey, blob, expiresAt: Date.now() + KEEP_MS } satisfies PhotoRecord))) !== null,
  get: async (id: string): Promise<Blob | null> => {
    const r = await photoDb.load(id);
    return r instanceof Blob ? r : null;
  },
  /** The photo, 'missing' when it is not (or no longer) on the device, 'error' when storage failed. */
  load: async (id: string): Promise<Blob | 'missing' | 'error'> => {
    let r = await attempt<PhotoRecord | undefined>('readonly', (s) => s.get(id));
    if (r === FAILED) r = await attempt<PhotoRecord | undefined>('readonly', (s) => s.get(id));
    if (r === FAILED) return 'error';
    if (!r || r.expiresAt <= Date.now()) return 'missing';
    return r.blob;
  },
  remove: async (ids: string[]): Promise<void> => {
    if (ids.length) await run('readwrite', (s) => void ids.forEach((id) => s.delete(id)));
  },
  /** Removes the photos of a survey that are not in `keep` (and every expired photo). */
  prune: async (survey: string, keep: Set<string>): Promise<void> => {
    const all = (await run<PhotoRecord[]>('readonly', (s) => s.getAll())) ?? [];
    const now = Date.now();
    const drop = all.filter((r) => r.expiresAt <= now || (r.survey === survey && !keep.has(r.id))).map((r) => r.id);
    await photoDb.remove(drop);
  },
  sweepExpired: async (): Promise<void> => {
    const all = (await run<PhotoRecord[]>('readonly', (s) => s.getAll())) ?? [];
    const now = Date.now();
    await photoDb.remove(all.filter((r) => r.expiresAt <= now || r.expiresAt > now + KEEP_MS).map((r) => r.id));
  },
};

const PHOTO_ID = /^[0-9a-f]{32}$/;

/** Photo ids in an answer set (any list value made only of photo ids). */
export function photoIdsIn(answers: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const v of Object.values(answers)) {
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && PHOTO_ID.test(x))) out.push(...(v as string[]));
  }
  return out;
}
