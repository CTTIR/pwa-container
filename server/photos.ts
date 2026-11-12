import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { MAX_PHOTO_BYTES, PHOTO_ID_PATTERN } from '../shared/schema.ts';

// Photos attached to survey answers. One folder per app (`<dataDir>/db/<app>/photos/`), one
// file per photo, named by the random id the device chose. Like the answers, the files carry no
// time: content metadata (EXIF, XMP, comments) is removed, and file and folder times are set to
// the epoch after every write, so neither the files nor their order tell when anyone took part.

/** Most photos per app, and their total size. */
export const MAX_PHOTOS_PER_APP = 5000;
export const MAX_PHOTO_BYTES_PER_APP = 4 * 1024 * 1024 * 1024;

const EPOCH = new Date(0);

/**
 * Returns the JPEG without application segments (APP1–APP15: EXIF, XMP, ICC …) and comments, or
 * null if the data is not a well-formed baseline/progressive JPEG.
 */
export function cleanJpeg(buf: Buffer): Buffer | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (marker === 0xd9) return null;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    const segment = buf.subarray(i, i + 2 + len);
    i += 2 + len;
    if (marker === 0xda) {
      // Start of scan: the entropy-coded data and everything after it are kept as they are, up
      // to the end-of-image marker. Later APPn/COM segments between scans are very rare and
      // carry no camera metadata.
      const rest = buf.subarray(i);
      const end = rest.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (end < 0) return null;
      out.push(segment, rest.subarray(0, end + 2));
      return Buffer.concat(out);
    }
    const isApp = marker >= 0xe1 && marker <= 0xef;
    if (isApp || marker === 0xfe) continue;
    out.push(segment);
  }
  return null;
}

export class PhotoStore {
  private memory = new Map<string, Map<string, Buffer>>();
  private usage = new Map<string, { count: number; bytes: number }>();

  /** `root(appId)` gives the app's database folder, or null to keep photos in memory (tests). */
  private appRoot: (appId: string) => string | null;
  constructor(appRoot: (appId: string) => string | null) {
    this.appRoot = appRoot;
  }

  private dir(appId: string): string | null {
    const base = this.appRoot(appId);
    return base ? path.join(base, 'photos') : null;
  }

  private mem(appId: string): Map<string, Buffer> {
    let m = this.memory.get(appId);
    if (!m) this.memory.set(appId, (m = new Map()));
    return m;
  }

  private file(appId: string, id: string): string | null {
    if (!PHOTO_ID_PATTERN.test(id)) throw new Error('invalid photo id');
    const dir = this.dir(appId);
    return dir ? path.join(dir, `${id}.jpg`) : null;
  }

  ids(appId: string): string[] {
    const dir = this.dir(appId);
    if (!dir) return [...this.mem(appId).keys()];
    try {
      return fs
        .readdirSync(dir)
        .filter((n) => n.endsWith('.jpg') && PHOTO_ID_PATTERN.test(n.slice(0, -4)))
        .map((n) => n.slice(0, -4));
    } catch {
      return [];
    }
  }

  private stats(appId: string): { count: number; bytes: number } {
    let u = this.usage.get(appId);
    if (u) return u;
    const dir = this.dir(appId);
    u = { count: 0, bytes: 0 };
    for (const id of this.ids(appId)) {
      u.count++;
      if (dir) {
        try {
          u.bytes += fs.statSync(path.join(dir, `${id}.jpg`)).size;
        } catch {
          /* removed meanwhile */
        }
      } else {
        u.bytes += this.mem(appId).get(id)?.length ?? 0;
      }
    }
    this.usage.set(appId, u);
    return u;
  }

  has(appId: string, id: string): boolean {
    const f = this.file(appId, id);
    return f ? fs.existsSync(f) : this.mem(appId).has(id);
  }

  read(appId: string, id: string): Buffer | null {
    const f = this.file(appId, id);
    if (!f) return this.mem(appId).get(id) ?? null;
    try {
      return fs.readFileSync(f);
    } catch {
      return null;
    }
  }

  /** Stores one photo. An existing photo with that id is kept (resends are harmless). */
  put(appId: string, id: string, data: Buffer): 'stored' | 'exists' | 'invalid' | 'full' {
    if (data.length > MAX_PHOTO_BYTES) return 'invalid';
    const clean = cleanJpeg(data);
    if (!clean) return 'invalid';
    if (this.has(appId, id)) return 'exists';
    const u = this.stats(appId);
    if (u.count >= MAX_PHOTOS_PER_APP || u.bytes + clean.length > MAX_PHOTO_BYTES_PER_APP) return 'full';
    const f = this.file(appId, id);
    if (!f) {
      this.mem(appId).set(id, clean);
    } else {
      const dir = path.dirname(f);
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
      const tmp = path.join(dir, `.${id}.tmp`);
      fs.writeFileSync(tmp, clean, { mode: 0o640 });
      fs.utimesSync(tmp, EPOCH, EPOCH);
      fs.renameSync(tmp, f);
      fs.utimesSync(dir, EPOCH, EPOCH);
    }
    u.count++;
    u.bytes += clean.length;
    return 'stored';
  }

  /** Removes every photo of the app that no stored answer refers to; returns how many. */
  sweep(appId: string, referenced: Set<string>): number {
    let removed = 0;
    for (const id of this.ids(appId)) {
      if (referenced.has(id)) continue;
      const f = this.file(appId, id);
      if (f) fs.rmSync(f, { force: true });
      else this.mem(appId).delete(id);
      removed++;
    }
    const dir = this.dir(appId);
    if (removed && dir && fs.existsSync(dir)) fs.utimesSync(dir, EPOCH, EPOCH);
    this.usage.delete(appId);
    return removed;
  }

  removeAll(appId: string): void {
    const dir = this.dir(appId);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    this.memory.delete(appId);
    this.usage.delete(appId);
  }
}

// ---- ZIP (stored, no compression: JPEGs do not compress) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Streams a ZIP archive of the given entries to the response, one file at a time, so memory use
 * stays at one photo. Entry times are fixed (1980-01-01), like the files themselves carry none.
 */
export async function streamZip(res: ServerResponse, entries: { name: string; load: () => Buffer | null }[]): Promise<void> {
  const central: Buffer[] = [];
  let offset = 0;
  const write = (b: Buffer) =>
    new Promise<void>((resolve, reject) => {
      offset += b.length;
      if (res.write(b)) resolve();
      else {
        res.once('drain', resolve);
        res.once('error', reject);
      }
    });
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  let count = 0;
  for (const e of entries) {
    const data = e.load();
    if (!data) continue;
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const at = offset;
    await write(local);
    await write(name);
    await write(data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(DOS_DATE, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(at, 42);
    central.push(c, name);
    count++;
  }
  const cd = Buffer.concat(central);
  const start = offset;
  await write(cd);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(start, 16);
  await write(end);
  res.end();
}
