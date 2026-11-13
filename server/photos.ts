import { randomInt } from 'node:crypto';
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
      // Start of scan: its entropy-coded data runs up to the next real marker (FF00 is a stuffed
      // byte, RSTn and fill bytes belong to the data). The image ends at the first end-of-image
      // marker: anything after it (a second image with its own EXIF, a gain map, a motion-photo
      // video) is dropped. Segments between the scans of a progressive JPEG go through the loop.
      out.push(segment);
      let j = i;
      while (j + 1 < buf.length) {
        const m = buf[j + 1];
        if (buf[j] !== 0xff || m === 0x00 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) {
          j += buf[j] === 0xff && m !== 0xff ? 2 : 1;
          continue;
        }
        break;
      }
      if (j + 1 >= buf.length) return null;
      out.push(buf.subarray(i, j));
      i = j;
      if (buf[j + 1] === 0xd9) {
        out.push(buf.subarray(j, j + 2));
        return Buffer.concat(out);
      }
      continue;
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
  /** Photos stored since the last maintenance run, per app (memory only, never written down). */
  private fresh = new Map<string, Set<string>>();

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
    let f2 = this.fresh.get(appId);
    if (!f2) this.fresh.set(appId, (f2 = new Set()));
    f2.add(id);
    return 'stored';
  }

  /** Overwrites a photo file with zeros before removing it, like the databases' secure_delete. */
  private remove(appId: string, id: string): void {
    const f = this.file(appId, id);
    if (!f) {
      this.mem(appId).delete(id);
      return;
    }
    try {
      const fd = fs.openSync(f, 'r+');
      try {
        fs.writeSync(fd, Buffer.alloc(fs.fstatSync(fd).size));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* already gone */
    }
    fs.rmSync(f, { force: true });
  }

  /**
   * Periodic maintenance. Removes photos no stored answer refers to, except those stored since the
   * last run (their answers may still be on the way). If anything changed, every remaining photo is
   * then rewritten in random order: utimes cannot reset a file's change time, and inode numbers
   * follow creation order, so without this the files would tell when and in which order answers
   * were sent. Afterwards they only tell "before this run". Returns how many photos were removed.
   */
  maintain(appId: string, referenced: Set<string>): number {
    const fresh = this.fresh.get(appId) ?? new Set<string>();
    this.fresh.delete(appId);
    let removed = 0;
    for (const id of this.ids(appId)) {
      if (referenced.has(id) || fresh.has(id)) continue;
      this.remove(appId, id);
      removed++;
    }
    const dir = this.dir(appId);
    if (dir && (removed || fresh.size)) {
      const ids = this.ids(appId);
      for (let i = ids.length - 1; i > 0; i--) {
        const j = randomInt(0, i + 1);
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      for (const id of ids) {
        const f = path.join(dir, `${id}.jpg`);
        const tmp = path.join(dir, `.${id}.tmp`);
        try {
          fs.copyFileSync(f, tmp);
          fs.utimesSync(tmp, EPOCH, EPOCH);
          fs.renameSync(tmp, f);
        } catch {
          fs.rmSync(tmp, { force: true });
        }
      }
      if (fs.existsSync(dir)) fs.utimesSync(dir, EPOCH, EPOCH);
    }
    this.usage.delete(appId);
    return removed;
  }

  /** Removes every photo of the app that no stored answer refers to; returns how many. */
  sweep(appId: string, referenced: Set<string>): number {
    let removed = 0;
    for (const id of this.ids(appId)) {
      if (referenced.has(id)) continue;
      this.remove(appId, id);
      removed++;
    }
    const dir = this.dir(appId);
    if (removed && dir && fs.existsSync(dir)) fs.utimesSync(dir, EPOCH, EPOCH);
    this.usage.delete(appId);
    return removed;
  }

  removeAll(appId: string): void {
    for (const id of this.ids(appId)) this.remove(appId, id);
    this.fresh.delete(appId);
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
      if (res.destroyed) return reject(new Error('download aborted'));
      if (res.write(b)) return resolve();
      // An aborted download emits neither 'drain' nor 'error', only 'close'.
      const done = (err?: Error) => {
        res.off('drain', onDrain);
        res.off('error', done);
        res.off('close', onClose);
        if (err) reject(err);
        else resolve();
      };
      const onDrain = () => done();
      const onClose = () => done(new Error('download aborted'));
      res.on('drain', onDrain);
      res.on('error', done);
      res.on('close', onClose);
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
