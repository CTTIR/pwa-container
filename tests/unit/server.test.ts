import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.ts';
import { AdminAuth, SOURCE_MAX_FAILURES, generatePassword, hashPassword, sourceGroup } from '../../server/auth.ts';
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
    expect(Object.keys(row)).toEqual(['surveyVersion', 'submittedOn', 'course', 'answers']);
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

  it('cools down a guessing source, but correct credentials still work', async () => {
    let clock = 1_000_000;
    const auth = new AdminAuth(credFile, { ...noPause, now: () => clock });
    for (let i = 0; i < SOURCE_MAX_FAILURES - 1; i++) expect(await auth.authenticate(wrong, undefined, '203.0.113.7')).toBeNull();
    expect(await auth.authenticate(wrong, undefined, '203.0.113.7')).toBe('blocked'); // limit reached: cooldown 10 s
    expect(await auth.authenticate(wrong, undefined, '203.0.113.7')).toBe('blocked'); // during cooldown: extended to 20 s
    expect(await auth.authenticate(ADMIN, undefined, '203.0.113.7')).toBe('global');
    expect(await auth.authenticate(ADMIN, undefined, '198.51.100.2')).toBe('global');
    expect(await auth.authenticate(LEAD, 'example-course-feedback', '198.51.100.2')).toBe('survey');
    expect(await auth.authenticate(LEAD, 'another-survey', '198.51.100.2')).toBe('other');
    expect(auth.delayFor({ failures: Array(SOURCE_MAX_FAILURES + 2).fill(clock) })).toBe(40_000);
    expect(auth.delayFor({ failures: Array(SOURCE_MAX_FAILURES + 20).fill(clock) })).toBe(300_000);
  });

  it('also cools down requests without a known source, but lets correct credentials through', async () => {
    const auth = new AdminAuth(credFile, noPause);
    for (let i = 0; i < SOURCE_MAX_FAILURES - 1; i++) expect(await auth.authenticate(wrong)).toBeNull();
    expect(await auth.authenticate(wrong)).toBe('blocked');
    expect(await auth.authenticate(ADMIN)).toBe('global');
  });

  it('spaces checks in the narrow lane to one per second', async () => {
    let clock = 5_000_000;
    const waits: number[] = [];
    const auth = new AdminAuth(credFile, {
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    for (let i = 0; i < SOURCE_MAX_FAILURES; i++) await auth.authenticate(wrong, undefined, '203.0.113.50');
    waits.length = 0;
    await auth.authenticate(wrong, undefined, '203.0.113.50');
    await auth.authenticate(wrong, undefined, '203.0.113.50');
    expect(waits.some((w) => w > 0 && w <= 1000)).toBe(true);
  });

  it('keeps clean sources on the normal path during a broad attack', async () => {
    const pauses: number[] = [];
    const auth = new AdminAuth(credFile, { sleep: async (ms) => void pauses.push(ms) });
    for (let n = 0; n < 230; n++) await auth.authenticate(wrong, undefined, `10.${Math.floor(n / 250)}.${n % 250}.1`);
    pauses.length = 0;
    expect(await auth.authenticate(ADMIN, undefined, '198.51.100.77')).toBe('global');
    expect(pauses).toEqual([]); // no lane spacing for a clean source
  }, 60_000);

  it('generates long random passwords and refuses short ones', () => {
    const pw = generatePassword();
    expect(pw).toHaveLength(24);
    expect(() => hashPassword('too short pw')).toThrow();
  });

  it('limits parallel checks per source but does not hold slots during pauses', async () => {
    const pauses: number[] = [];
    const auth = new AdminAuth(credFile, {
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    const results = await Promise.all(Array.from({ length: 5 }, () => auth.authenticate(wrong, undefined, '203.0.113.9')));
    expect(results.filter((r) => r === 'busy').length).toBe(3);
    expect(Math.min(...pauses)).toBeGreaterThanOrEqual(600);
    expect(await auth.authenticate(ADMIN, undefined, '203.0.113.9')).toBe('global');
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

describe('courses and single-use codes', () => {
  const def = () => {
    const d = JSON.parse(fs.readFileSync(path.join(surveysDir, 'example-course-feedback', 'survey.json'), 'utf8'));
    d.id = 'coded-survey';
    d.accessCodes = 'required';
    return d;
  };
  const adminWrite = { Authorization: ADMIN, ...WRITE };
  let codes: string[] = [];
  let courseId = '';

  it('installs a survey that requires codes and creates a course with codes', async () => {
    expect((await fetch(`${base}/admin/api/apps/surveys`, { method: 'POST', headers: adminWrite, body: JSON.stringify(def()) })).status).toBe(201);
    const res = await fetch(`${base}/admin/api/results/coded-survey/courses`, {
      method: 'POST',
      headers: adminWrite,
      body: JSON.stringify({ label: 'Neuwied, November 2026', count: 3 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { course: { id: string }; codes: string[] };
    courseId = body.course.id;
    codes = body.codes;
    expect(codes).toHaveLength(3);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  const post = (submissionId: string, code?: string) =>
    fetch(`${base}/api/surveys/coded-survey/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissionId, answers, code }),
    });

  it('checks codes, accepts each once and links the response to the course only', async () => {
    const check = await fetch(`${base}/api/surveys/coded-survey/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: codes[0].toLowerCase() }),
    });
    expect(await check.json()).toEqual({ status: 'ok', course: 'Neuwied, November 2026' });
    expect((await post('55555555-5555-4555-8555-555555555555')).status).toBe(422);
    expect((await post('55555555-5555-4555-8555-555555555555', 'ZZZZ-ZZZZ')).status).toBe(422);
    expect((await post('55555555-5555-4555-8555-555555555555', codes[0])).status).toBe(201);
    expect((await post('55555555-5555-4555-8555-555555555555', codes[0])).status).toBe(200); // retry of the same submission
    expect((await post('66666666-6666-4666-8666-666666666666', codes[0])).status).toBe(409); // code already used
    const [row] = store.list('coded-survey');
    expect(row.course).toBe('Neuwied, November 2026');
    expect(JSON.stringify(row)).not.toContain(codes[0].replace('-', ''));
  });

  it('lists, blocks and unblocks codes, renames the course and filters exports by course', async () => {
    const list = (await (await fetch(`${base}/admin/api/results/coded-survey/courses/${courseId}/codes`, { headers: { Authorization: ADMIN } })).json()) as {
      codes: { code: string; used: boolean; revoked: boolean }[];
    };
    expect(list.codes.filter((c) => c.used)).toHaveLength(1);
    await fetch(`${base}/admin/api/results/coded-survey/courses/${courseId}/revoke`, {
      method: 'POST',
      headers: adminWrite,
      body: JSON.stringify({ codes: [codes[1]], revoked: true }),
    });
    expect((await post('77777777-7777-4777-8777-777777777777', codes[1])).status).toBe(422);
    await fetch(`${base}/admin/api/results/coded-survey/courses/${courseId}/revoke`, {
      method: 'POST',
      headers: adminWrite,
      body: JSON.stringify({ codes: [codes[1]], revoked: false }),
    });
    expect((await post('77777777-7777-4777-8777-777777777777', codes[1])).status).toBe(201);
    await fetch(`${base}/admin/api/results/coded-survey/courses/${courseId}`, { method: 'PATCH', headers: adminWrite, body: JSON.stringify({ label: 'Neuwied 11/2026' }) });
    const csv = await (await fetch(`${base}/admin/api/results/coded-survey/export.csv?course=${courseId}`, { headers: { Authorization: ADMIN } })).text();
    expect(csv.split('\r\n')[0]).toContain('course');
    expect(csv).toContain('Neuwied 11/2026');
    expect(csv.trim().split('\r\n')).toHaveLength(3);
    const del = await fetch(`${base}/admin/api/results/coded-survey/courses/${courseId}`, { method: 'DELETE', headers: adminWrite });
    expect(del.status).toBe(409); // responses still belong to the course
  });
});

describe('records of web apps', () => {
  const auth = { Authorization: ADMIN, 'X-Requested-With': 'pwa-container' };
  const send = (body: unknown) =>
    fetch(`${base}/api/apps/demo-app/records`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('refuses records until collecting is switched on', async () => {
    expect((await send({ data: { a: 1 } })).status).toBe(403);
    await fetch(`${base}/admin/api/apps/demo-app`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ collectRecords: true }) });
    expect((await send({ collection: 'sessions', data: { score: 7, nested: { x: 'y' }, list: [1, 2] } })).status).toBe(201);
    expect((await send({ collection: 'sessions', data: { score: 3 } })).status).toBe(201);
    expect((await send({ collection: 'bad name!', data: {} })).status).toBe(400);
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect((await send({ collection: 'sessions', data: deep })).status).toBe(400);
  });

  it('offers overview and downloads in the administration', async () => {
    const info = (await (await fetch(`${base}/admin/api/records/demo-app`, { headers: { Authorization: ADMIN } })).json()) as {
      total: number;
      collections: { collection: string; records: number }[];
    };
    expect(info.total).toBe(2);
    expect(info.collections).toEqual([{ collection: 'sessions', records: 2 }]);
    const csv = await (await fetch(`${base}/admin/api/records/demo-app/records.csv?collection=sessions`, { headers: { Authorization: ADMIN } })).text();
    expect(csv.split('\r\n')[0]).toBe('record,collection,received_on,score,nested.x,list');
    const json = (await (await fetch(`${base}/admin/api/records/demo-app/records.json`, { headers: { Authorization: ADMIN } })).json()) as { records: unknown[] };
    expect(json.records).toHaveLength(2);
    const del = await fetch(`${base}/admin/api/records/demo-app?confirm=demo-app`, { method: 'DELETE', headers: auth });
    expect(((await del.json()) as { removed: number }).removed).toBe(2);
  });
});
