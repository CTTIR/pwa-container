import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.ts';
import { AdminAuth, SOURCE_MAX_FAILURES, hashPassword, sourceGroup } from '../../server/auth.ts';
import { Store } from '../../server/db.ts';
import { AppRegistry } from '../../server/registry.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-container-test-'));
const surveysDir = path.join(root, 'surveys');
const dataDir = path.join(root, 'data');
const distDir = path.join(root, 'dist');
const credFile = path.join(root, 'admins.json');
let server: http.Server;
let base = '';
let store: Store;

const ADMIN = 'Basic ' + Buffer.from('admin:correct horse battery').toString('base64');
const LEAD = 'Basic ' + Buffer.from('lead:course lead password').toString('base64');
const WRITE = { 'X-Requested-With': 'pwa-container', 'Content-Type': 'application/json' };

beforeAll(async () => {
  fs.mkdirSync(path.join(surveysDir, 'example-course-feedback'), { recursive: true });
  fs.copyFileSync(
    new URL('../../examples/surveys/example-course-feedback/survey.json', import.meta.url),
    path.join(surveysDir, 'example-course-feedback', 'survey.json'),
  );
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>participant</title>');
  fs.writeFileSync(path.join(distDir, 'admin.html'), '<!doctype html><title>admin</title>');
  fs.writeFileSync(
    credFile,
    JSON.stringify({
      global: [{ user: 'admin', hash: hashPassword('correct horse battery') }],
      surveys: { 'example-course-feedback': [{ user: 'lead', hash: hashPassword('course lead password') }] },
    }),
  );
  store = new Store(dataDir);
  const registry = new AppRegistry(store, surveysDir, dataDir, () => {});
  const handler = createApp({ store, registry, auth: new AdminAuth(credFile), distDir, themesDir: path.join(root, 'themes'), log: () => {} });
  server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const answers = { C01: 4, C02: 'NA', C03_PRE: 2, C03_POST: 5, C04: ['Lectures'], O01: '=cmd() and more' };

async function submit(submissionId: string, body: unknown = answers) {
  return fetch(`${base}/api/surveys/example-course-feedback/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ submissionId, surveyVersion: 1, answers: body }),
  });
}

describe('participant API', () => {
  it('serves the definition with status and security headers', async () => {
    const res = await fetch(`${base}/api/surveys/example-course-feedback`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const body = (await res.json()) as { definition: { id: string }; status: string };
    expect(body.definition.id).toBe('example-course-feedback');
    expect(body.status).toBe('open');
  });

  it('stores a valid response once and treats a retry as duplicate', async () => {
    expect((await submit('11111111-1111-4111-8111-111111111111')).status).toBe(201);
    expect((await submit('11111111-1111-4111-8111-111111111111')).status).toBe(200);
    expect(store.count('example-course-feedback')).toBe(1);
  });

  it('rejects invalid answers', async () => {
    const res = await submit('22222222-2222-4222-8222-222222222222', { C01: 7 });
    expect(res.status).toBe(422);
  });

  it('stores only the day, never a time or client details', () => {
    const [row] = store.list('example-course-feedback');
    expect(row.submittedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(row)).toEqual(['surveyVersion', 'submittedOn', 'answers']);
  });

  it('serves the SPA for survey links and hides admin.html', async () => {
    expect((await fetch(`${base}/s/example-course-feedback`)).status).toBe(200);
    expect((await fetch(`${base}/admin.html`)).status).toBe(404);
  });
});

describe('administration', () => {
  it('requires authentication', async () => {
    const res = await fetch(`${base}/admin/api/apps`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Basic');
  });

  it('lists apps for the global admin', async () => {
    const res = await fetch(`${base}/admin/api/apps`, { headers: { Authorization: ADMIN } });
    const body = (await res.json()) as { apps: { id: string; responses: number }[] };
    expect(body.apps.map((a) => a.id)).toContain('example-course-feedback');
  });

  it('gives survey credentials access to their results only', async () => {
    const results = await fetch(`${base}/admin/api/results/example-course-feedback/summary`, { headers: { Authorization: LEAD } });
    expect(results.status).toBe(200);
    const dash = await fetch(`${base}/admin/api/apps`, { headers: { Authorization: LEAD } });
    expect(dash.status).toBe(403);
  });

  it('exports CSV with formula-neutralised text', async () => {
    const res = await fetch(`${base}/admin/api/results/example-course-feedback/export.csv`, { headers: { Authorization: ADMIN } });
    const csv = await res.text();
    expect(csv).toContain('C03_PRE');
    expect(csv).toContain("'=cmd() and more");
  });

  it('refuses changes without the admin page header', async () => {
    const res = await fetch(`${base}/admin/api/apps/example-course-feedback`, {
      method: 'PATCH',
      headers: { Authorization: ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ statusOverride: 'closed' }),
    });
    expect(res.status).toBe(403);
  });

  it('closes a survey by hand, which blocks new answers', async () => {
    const res = await fetch(`${base}/admin/api/apps/example-course-feedback`, {
      method: 'PATCH',
      headers: { Authorization: ADMIN, ...WRITE },
      body: JSON.stringify({ statusOverride: 'closed' }),
    });
    expect(res.status).toBe(200);
    expect((await submit('33333333-3333-4333-8333-333333333333')).status).toBe(409);
    await fetch(`${base}/admin/api/apps/example-course-feedback`, {
      method: 'PATCH',
      headers: { Authorization: ADMIN, ...WRITE },
      body: JSON.stringify({ statusOverride: null }),
    });
  });

  it('installs an uploaded survey and refuses content changes without a version bump once answered', async () => {
    const def = JSON.parse(fs.readFileSync(path.join(surveysDir, 'example-course-feedback', 'survey.json'), 'utf8'));
    def.id = 'uploaded-survey';
    const install = (d: unknown) =>
      fetch(`${base}/admin/api/apps/surveys`, { method: 'POST', headers: { Authorization: ADMIN, ...WRITE }, body: JSON.stringify(d) });
    expect((await install(def)).status).toBe(201);
    const post = await fetch(`${base}/api/surveys/uploaded-survey/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissionId: '44444444-4444-4444-8444-444444444444', answers }),
    });
    expect(post.status).toBe(201);
    expect((await install({ ...def, title: 'Changed' })).status).toBe(422);
    expect((await install({ ...def, title: 'Changed', version: 2 })).status).toBe(201);
  });

  it('uploads, publishes and serves a static web app', async () => {
    const auth = { Authorization: ADMIN, 'X-Requested-With': 'pwa-container' };
    expect(
      (await fetch(`${base}/admin/api/apps/demo-app/static/begin`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"title":"Demo"}' })).status,
    ).toBe(200);
    await fetch(`${base}/admin/api/apps/demo-app/static/files/index.html`, { method: 'PUT', headers: auth, body: '<!doctype html><p>demo</p>' });
    await fetch(`${base}/admin/api/apps/demo-app/static/files/assets/app.js`, { method: 'PUT', headers: auth, body: 'console.log(1)' });
    const bad = await fetch(`${base}/admin/api/apps/demo-app/static/files/..%2F..%2Fescape.txt`, { method: 'PUT', headers: auth, body: 'x' });
    expect(bad.status).toBe(422);
    expect((await fetch(`${base}/admin/api/apps/demo-app/static/publish`, { method: 'POST', headers: auth })).status).toBe(200);
    const page = await fetch(`${base}/a/demo-app/`);
    expect(await page.text()).toContain('demo');
    expect((await fetch(`${base}/a/demo-app/assets/app.js`)).headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/a/demo-app/some/route`)).status).toBe(200);
    expect(fs.existsSync(path.join(root, 'escape.txt'))).toBe(false);
  });

  it('purges responses only with the matching confirmation', async () => {
    const purge = (confirm: string) =>
      fetch(`${base}/admin/api/apps/example-course-feedback/purge`, {
        method: 'POST',
        headers: { Authorization: ADMIN, ...WRITE },
        body: JSON.stringify({ confirm }),
      });
    expect((await purge('wrong')).status).toBe(400);
    expect((await purge('example-course-feedback')).status).toBe(200);
    expect(store.count('example-course-feedback')).toBe(0);
  });
});

describe('admin authentication', () => {
  const wrong = 'Basic ' + Buffer.from('admin:wrong password!!').toString('base64');
  const noPause = { sleep: async () => {} };

  it('never locks out correct credentials, also from a guessing source', async () => {
    const auth = new AdminAuth(credFile, noPause);
    for (let i = 0; i < SOURCE_MAX_FAILURES; i++) expect(await auth.authenticate(wrong, undefined, '203.0.113.7')).toBeNull();
    expect(await auth.authenticate(wrong, undefined, '203.0.113.7')).toBe('blocked');
    expect(await auth.authenticate(ADMIN, undefined, '203.0.113.7')).toBe('global');
    expect(await auth.authenticate(ADMIN, undefined, '198.51.100.2')).toBe('global');
    expect(await auth.authenticate(LEAD, 'example-course-feedback', '198.51.100.2')).toBe('survey');
    expect(await auth.authenticate(LEAD, 'another-survey', '198.51.100.2')).toBe('other');
  });

  it('pauses failed attempts while holding the source slot, which caps parallel guessing', async () => {
    const pauses: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const auth = new AdminAuth(credFile, {
      sleep: (ms) => {
        pauses.push(ms);
        return gate;
      },
    });
    const pending = Array.from({ length: 5 }, () => auth.authenticate(wrong, undefined, '203.0.113.9'));
    await new Promise((r) => setTimeout(r, 300));
    const busyNow = await auth.authenticate(wrong, undefined, '203.0.113.9');
    expect(busyNow).toBe('busy');
    release();
    const results = await Promise.all(pending);
    expect(results.filter((r) => r === 'busy').length).toBe(3);
    expect(Math.min(...pauses)).toBeGreaterThanOrEqual(600);
    expect(await auth.authenticate(ADMIN, undefined, '198.51.100.3')).toBe('global');
  });

  it('groups IPv6 addresses per /64 network', async () => {
    expect(sourceGroup('2001:db8:1:2::1')).toBe(sourceGroup('2001:0db8:0001:0002:ffff::99'));
    expect(sourceGroup('2001:db8:1:2::1')).not.toBe(sourceGroup('2001:db8:1:3::1'));
    expect(sourceGroup('::ffff:192.0.2.5')).toBe('v4:192.0.2.5');
    const auth = new AdminAuth(credFile, noPause);
    for (let i = 0; i < SOURCE_MAX_FAILURES; i++) await auth.authenticate(wrong, undefined, `2001:db8:1:2::${i + 1}`);
    expect(await auth.authenticate(wrong, undefined, '2001:db8:1:2:abcd::5')).toBe('blocked');
    expect(await auth.authenticate(wrong, undefined, '2001:db8:1:3::1')).toBeNull();
  });

  it('does not forget sources with recent failures when the table is full', async () => {
    const auth = new AdminAuth(credFile, { ...noPause, maxSources: 3 });
    for (let i = 0; i < SOURCE_MAX_FAILURES; i++) await auth.authenticate(wrong, undefined, '203.0.113.1');
    for (let n = 2; n < 40; n++) await auth.authenticate(wrong, undefined, `203.0.113.${n}`);
    expect(await auth.authenticate(wrong, undefined, '203.0.113.1')).toBe('blocked');
  });
});
