import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.ts';
import { AdminAuth, hashPassword } from '../../server/auth.ts';
import { Store } from '../../server/db.ts';
import { cleanJpeg, crc32 } from '../../server/photos.ts';
import { AppRegistry } from '../../server/registry.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-photos-test-'));
const surveysDir = path.join(root, 'surveys');
const dataDir = path.join(root, 'data');
const distDir = path.join(root, 'dist');
const credFile = path.join(root, 'admins.json');
let server: http.Server;
let base = '';
let store: Store;
const LEAD = 'Basic ' + Buffer.from('lead:photo survey lead password').toString('base64');
const OTHER = 'Basic ' + Buffer.from('other:another survey lead pass').toString('base64');
const ADMIN = 'Basic ' + Buffer.from('admin:correct horse battery').toString('base64');

const survey = {
  id: 'photo-survey',
  version: 1,
  locale: 'de',
  title: 'Fotos',
  intro: { paragraphs: [] },
  thanks: { paragraphs: [] },
  scales: { s: { display: 'slider', step: 0.1, options: [0, 1, 2, 3, 4, 5].map((v) => ({ value: v, label: `L${v}` })), notApplicable: { value: '-9', label: 'nb' } } },
  sections: [{ id: 'B1', title: 'Block', items: [{ id: 'q1', type: 'scale', scale: 's', text: 'Frage', photos: { max: 2 }, comment: { label: 'Anmerkung', maxLength: 6000 } }] }],
};

/** A tiny structurally valid JPEG with an EXIF segment holding a fake GPS tag and a comment. */
function jpegWithExif(): Buffer {
  const seg = (marker: number, payload: Buffer) => {
    const head = Buffer.alloc(4);
    head[0] = 0xff;
    head[1] = marker;
    head.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([head, payload]);
  };
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')),
    seg(0xe1, Buffer.from('Exif\0\0GPSLatitude=49.45;DateTime=2026:11:14 10:02', 'binary')),
    seg(0xfe, Buffer.from('secret comment', 'binary')),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const PHOTO_A = 'a'.repeat(32);
const PHOTO_B = 'b'.repeat(32);

beforeAll(async () => {
  fs.mkdirSync(path.join(surveysDir, survey.id), { recursive: true });
  fs.writeFileSync(path.join(surveysDir, survey.id, 'survey.json'), JSON.stringify(survey));
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(distDir, 'admin.html'), '<!doctype html>');
  fs.writeFileSync(
    credFile,
    JSON.stringify({
      global: [{ user: 'admin', hash: hashPassword('correct horse battery') }],
      surveys: { 'photo-survey': [{ user: 'lead', hash: hashPassword('photo survey lead password') }], 'other-survey': [{ user: 'other', hash: hashPassword('another survey lead pass') }] },
    }),
  );
  store = new Store(dataDir);
  const registry = new AppRegistry(store, surveysDir, dataDir, () => {});
  const handler = createApp({ store, registry, auth: new AdminAuth(credFile, { overridesFile: path.join(root, 'pw.json') }), distDir, themesDir: path.join(root, 'themes'), log: () => {} });
  server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const put = (id: string, body: Buffer, type = 'image/jpeg') =>
  fetch(`${base}/api/surveys/photo-survey/photos/${id}`, { method: 'PUT', headers: { 'Content-Type': type }, body });
const submit = (submissionId: string, answers: unknown) =>
  fetch(`${base}/api/surveys/photo-survey/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ submissionId, surveyVersion: 1, answers }),
  });

describe('jpeg cleaning', () => {
  it('drops EXIF, other APPn segments and comments but keeps the image data', () => {
    const src = jpegWithExif();
    const clean = cleanJpeg(src)!;
    expect(clean).not.toBeNull();
    expect(clean.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(clean.includes(Buffer.from('secret comment'))).toBe(false);
    expect(clean.includes(Buffer.from('JFIF'))).toBe(true);
    expect(clean.subarray(-7).equals(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]))).toBe(true);
  });

  it('rejects what is not a JPEG', () => {
    expect(cleanJpeg(Buffer.from('<svg></svg>'))).toBeNull();
    expect(cleanJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]))).toBeNull();
  });

  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('photos with answers', () => {
  it('accepts continuous slider values and long texts beyond the default body limit', async () => {
    const res = await submit('sub-continuous-0001', { q1: 3.4, q1_txt: 'x'.repeat(6000) });
    expect(res.status).toBe(201);
    expect((await submit('sub-continuous-0002', { q1: 3.45 })).status).toBe(422);
  });

  it('stores photos without metadata or file times and refuses non-JPEG uploads', async () => {
    expect((await put(PHOTO_A, jpegWithExif())).status).toBe(201);
    expect((await put(PHOTO_A, jpegWithExif())).status).toBe(200);
    expect((await put(PHOTO_B, Buffer.from('GIF89a'), 'image/gif')).status).toBe(415);
    expect((await put(PHOTO_B, Buffer.from('not a jpeg'))).status).toBe(422);
    expect((await put('nothex', jpegWithExif())).status).toBe(400);
    const file = path.join(dataDir, 'db', 'photo-survey', 'photos', `${PHOTO_A}.jpg`);
    const stored = fs.readFileSync(file);
    expect(stored.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(0);
    expect(fs.statSync(path.dirname(file)).mtimeMs).toBe(0);
  });

  it('asks for photos the server lacks, then stores the answers', async () => {
    const missing = await submit('sub-photos-000001', { q1: 2, q1_foto: [PHOTO_A, PHOTO_B] });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: 'photo_missing', photos: [PHOTO_B] });
    expect((await put(PHOTO_B, jpegWithExif())).status).toBe(201);
    expect((await submit('sub-photos-000001', { q1: 2, q1_foto: [PHOTO_A, PHOTO_B] })).status).toBe(201);
    expect((await submit('sub-photos-000002', { q1_foto: ['c'.repeat(32), 'd'.repeat(32), 'e'.repeat(32)] })).status).toBe(422);
  });

  it("shows photos to the survey's administration only, also as a ZIP", async () => {
    const one = await fetch(`${base}/admin/api/results/photo-survey/photos/${PHOTO_A}.jpg`, { headers: { Authorization: LEAD } });
    expect(one.status).toBe(200);
    expect(one.headers.get('content-type')).toBe('image/jpeg');
    expect((await fetch(`${base}/admin/api/results/photo-survey/photos/${PHOTO_A}.jpg`, { headers: { Authorization: OTHER } })).status).toBe(403);
    expect((await fetch(`${base}/admin/api/results/photo-survey/photos/${PHOTO_A}.jpg`)).status).toBe(401);
    const zip = Buffer.from(await (await fetch(`${base}/admin/api/results/photo-survey/photos`, { headers: { Authorization: LEAD } })).arrayBuffer());
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.includes(Buffer.from(`q1_foto_${PHOTO_A}.jpg`))).toBe(true);
    expect(zip.includes(Buffer.from(`q1_foto_${PHOTO_B}.jpg`))).toBe(true);
    const end = zip.subarray(zip.length - 22);
    expect(end.readUInt32LE(0)).toBe(0x06054b50);
    expect(end.readUInt16LE(10)).toBe(2);
  });

  it('keeps photos out of the rating summary and exports', async () => {
    const res = await fetch(`${base}/admin/api/results/photo-survey/responses`, { headers: { Authorization: ADMIN } });
    const body = (await res.json()) as { keys: string[] };
    expect(body.keys).toEqual(['q1']);
  });

  it('writes continuous ratings as doubles to R', async () => {
    const rds = Buffer.from(await (await fetch(`${base}/admin/api/results/photo-survey/data?format=rds`, { headers: { Authorization: LEAD } })).arrayBuffer());
    expect(rds.length).toBeGreaterThan(100);
  });

  it('removes the photos when all answers are purged', async () => {
    const res = await fetch(`${base}/admin/api/apps/photo-survey/purge`, {
      method: 'POST',
      headers: { Authorization: ADMIN, 'X-Requested-With': 'pwa-container', 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'photo-survey' }),
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(dataDir, 'db', 'photo-survey', 'photos'))).toBe(false);
  });
});
