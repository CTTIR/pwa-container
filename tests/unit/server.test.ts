import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.ts';
import { AdminAuth, SOURCE_MAX_FAILURES, generatePassword, hashPassword, sourceGroup } from '../../server/auth.ts';
import { DatabaseSync } from 'node:sqlite';
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
const CODED_LEAD = 'Basic ' + Buffer.from('codedlead:coded survey lead password').toString('base64');
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
      surveys: {
        'example-course-feedback': [{ user: 'lead', hash: hashPassword('course lead password') }],
        'coded-survey': [{ user: 'codedlead', hash: hashPassword('coded survey lead password') }],
      },
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

  it('stores no date or time and no client details', () => {
    const [row] = store.list('example-course-feedback');
    expect(Object.keys(row)).toEqual(['surveyVersion', 'course', 'answers']);
  });

  it('survives a client that hangs up in the middle of a request body', async () => {
    const { request } = await import('node:http');
    const url = new URL(base);
    await new Promise<void>((resolve) => {
      const req = request({ host: url.hostname, port: url.port, method: 'POST', path: '/api/surveys/example-course-feedback/responses', headers: { 'Content-Type': 'application/json', 'Content-Length': '100' } });
      req.on('error', () => resolve());
      req.write('{"su');
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    await new Promise((r) => setTimeout(r, 100));
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('refuses answers given to another version of the questions', async () => {
    const res = await fetch(`${base}/api/surveys/example-course-feedback/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissionId: '99999999-9999-4999-8999-999999999999', surveyVersion: 7, answers }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'version_changed', version: 1 });
  });

  it('serves the SPA for survey links and never the admin page without sign-in', async () => {
    expect((await fetch(`${base}/s/example-course-feedback`)).status).toBe(200);
    expect((await fetch(`${base}/admin.html`)).status).toBe(404);
    expect((await fetch(`${base}/admin.html/`)).status).toBe(404);
    expect((await fetch(`${base}/%61dmin.html`)).status).toBe(404);
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

  it('releases results only for a closed survey with at least five responses, free texts separately', async () => {
    const summary = async () =>
      (await (await fetch(`${base}/admin/api/results/example-course-feedback/summary`, { headers: { Authorization: LEAD } })).json()) as {
        released: boolean;
        responses: number;
      };
    for (let i = 2; i <= 5; i++) expect((await submit(`a${i}aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`)).status).toBe(201);
    expect(await summary()).toMatchObject({ released: false, responses: 0 }); // open survey: nothing to watch
    const close = (closed: boolean) =>
      fetch(`${base}/admin/api/results/example-course-feedback/status`, { method: 'POST', headers: { Authorization: LEAD, ...WRITE }, body: JSON.stringify({ closed }) });
    expect((await close(true)).status).toBe(200);
    expect(await summary()).toMatchObject({ released: true, responses: 5 });
    const ratings = await (await fetch(`${base}/admin/api/results/example-course-feedback/export.csv`, { headers: { Authorization: ADMIN } })).text();
    expect(ratings.split('\r\n')[0]).toBe('response,C01,C02,C03_PRE,C03_POST,C04');
    const asLead = await fetch(`${base}/admin/api/results/example-course-feedback/export.csv`, { headers: { Authorization: LEAD } });
    expect(asLead.status).toBe(200); // the survey's own administration has full access to its data
    expect(ratings).not.toContain('cmd()');
    const texts = await (await fetch(`${base}/admin/api/results/example-course-feedback/texts.csv`, { headers: { Authorization: ADMIN } })).text();
    expect(texts).toContain("'=cmd() and more");
    expect((await close(false)).status).toBe(409); // released results: reopening is refused for good
  });

  it('refuses changes without the admin page header', async () => {
    const res = await fetch(`${base}/admin/api/apps/example-course-feedback`, {
      method: 'PATCH',
      headers: { Authorization: ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ statusOverride: 'closed' }),
    });
    expect(res.status).toBe(403);
  });

  it('keeps a released survey closed, also for the global administration', async () => {
    expect((await submit('33333333-3333-4333-8333-333333333333')).status).toBe(409);
    const reopen = await fetch(`${base}/admin/api/apps/example-course-feedback`, {
      method: 'PATCH',
      headers: { Authorization: ADMIN, ...WRITE },
      body: JSON.stringify({ statusOverride: 'open' }),
    });
    expect(reopen.status).toBe(409);
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

  it('spaces checks in a narrow lane to one per two seconds', async () => {
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
    expect(waits.some((w) => w > 0 && w <= 2000)).toBe(true);
  });

  it('during a broad attack slows down unknown sources but not known administrators', async () => {
    const pauses: number[] = [];
    const auth = new AdminAuth(credFile, { sleep: async (ms) => void pauses.push(ms) });
    expect(await auth.authenticate(ADMIN, undefined, '198.51.100.77')).toBe('global'); // known-good source
    for (let n = 0; n < 230; n++) await auth.authenticate(wrong, undefined, `10.${Math.floor(n / 250)}.${n % 250}.1`);
    pauses.length = 0;
    expect(await auth.authenticate(ADMIN, undefined, '198.51.100.77')).toBe('global');
    expect(pauses).toEqual([]); // normal path, no lane spacing
    await auth.authenticate(wrong, undefined, '192.0.2.10'); // fresh sources share the narrow lane
    await auth.authenticate(wrong, undefined, '192.0.2.11');
    expect(pauses.some((ms) => ms > 0 && ms <= 2000)).toBe(true);
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
  const results = (rest: string) => `${base}/admin/api/results/coded-survey/${rest}`;
  let codes: string[] = [];
  let courseId = '';

  it('creates a course with event name, manual date and codes', async () => {
    expect((await fetch(`${base}/admin/api/apps/surveys`, { method: 'POST', headers: adminWrite, body: JSON.stringify(def()) })).status).toBe(201);
    expect((await fetch(results('courses'), { method: 'POST', headers: adminWrite, body: JSON.stringify({ label: 'Neuwied', count: 3 }) })).status).toBe(400);
    const res = await fetch(results('courses'), {
      method: 'POST',
      headers: adminWrite,
      body: JSON.stringify({ label: 'Instruktorenkurs Neuwied', eventDate: '2026-11-07', eventDateEnd: '2026-11-08', count: 7 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { course: { id: string; eventDate: string; eventDateEnd: string }; codes: string[] };
    courseId = body.course.id;
    codes = body.codes;
    expect(body.course).toMatchObject({ eventDate: '2026-11-07', eventDateEnd: '2026-11-08' });
    expect(codes).toHaveLength(7);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  const post = (submissionId: string, code?: string) =>
    fetch(`${base}/api/surveys/coded-survey/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissionId, surveyVersion: 1, answers, code }),
    });
  const sid = (n: number) => `${String(n).padStart(8, '0')}-5555-4555-8555-555555555555`;

  it('accepts each code once and stores neither the code nor any time with the response', async () => {
    const check = await fetch(`${base}/api/surveys/coded-survey/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: codes[0].toLowerCase() }),
    });
    expect(await check.json()).toEqual({ status: 'ok', course: 'Instruktorenkurs Neuwied' });
    expect((await post(sid(1))).status).toBe(422);
    expect((await post(sid(1), 'ZZZZ-ZZZZ')).status).toBe(422);
    expect((await post(sid(1), codes[0])).status).toBe(201);
    expect((await post(sid(1), codes[0])).status).toBe(200); // retry of the same submission
    expect((await post(sid(2), codes[0])).status).toBe(422); // code already used: answered like an unknown code
    // The public check never tells whether a known code was used.
    const again = await fetch(`${base}/api/surveys/coded-survey/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: codes[0] }),
    });
    expect(again.status).toBe(200);
    const [row] = store.list('coded-survey');
    expect(row).toEqual({ surveyVersion: 1, course: 'Instruktorenkurs Neuwied', answers: expect.any(Object) });
    const all = JSON.stringify(store.list('coded-survey'));
    for (const c of codes) expect(all).not.toContain(c.replace('-', ''));
  });

  it('never reveals which single code was used', async () => {
    const list = (await (await fetch(results(`courses/${courseId}/codes`), { headers: { Authorization: ADMIN } })).json()) as {
      codes: Record<string, unknown>[];
    };
    expect(list.codes).toHaveLength(7);
    for (const c of list.codes) expect(Object.keys(c).sort()).toEqual(['code', 'revoked']);
  });

  it('blocks and unblocks codes', async () => {
    const revoke = (revoked: boolean) =>
      fetch(results(`courses/${courseId}/revoke`), { method: 'POST', headers: adminWrite, body: JSON.stringify({ codes: [codes[1]], revoked }) });
    await revoke(true);
    expect((await post(sid(3), codes[1])).status).toBe(422);
    await revoke(false);
    expect((await post(sid(3), codes[1])).status).toBe(201);
  });

  it('releases a course only when it is closed and has at least five responses', async () => {
    const summary = async () =>
      (await (await fetch(results(`summary?course=${courseId}`), { headers: { Authorization: ADMIN } })).json()) as { released: boolean; responses: number };
    for (let i = 2; i <= 4; i++) expect((await post(sid(10 + i), codes[i])).status).toBe(201);
    expect(await summary()).toMatchObject({ released: false, responses: 0 }); // 5 answers, but still open
    const open = (await (await fetch(results('courses'), { headers: { Authorization: ADMIN } })).json()) as {
      courses: { responses: number | null; used: number | null; responsesBand: string | null }[];
    };
    expect(open.courses[0]).toMatchObject({ responses: null, used: null, responsesBand: 'atLeastMin' }); // no live counts
    await fetch(results(`courses/${courseId}`), { method: 'PATCH', headers: adminWrite, body: JSON.stringify({ closed: true }) });
    expect((await post(sid(20), codes[5])).status).toBe(409); // closed course: codes expired
    expect(await summary()).toMatchObject({ released: true, responses: 5 });
    const csv = await (await fetch(results(`export.csv?course=${courseId}`), { headers: { Authorization: ADMIN } })).text();
    expect(csv.split('\r\n')[0]).toBe('response,course,C01,C02,C03_PRE,C03_POST,C04');
    expect(csv.trim().split('\r\n')).toHaveLength(6);
  });

  it('shows no exact counts for a closed course below the minimum group size', async () => {
    const small = await fetch(results('courses'), {
      method: 'POST',
      headers: adminWrite,
      body: JSON.stringify({ label: 'Kleiner Kurs', eventDate: '2026-12-02', count: 3 }),
    });
    const body = (await small.json()) as { course: { id: string }; codes: string[] };
    expect((await post(sid(40), body.codes[0])).status).toBe(201);
    await fetch(results(`courses/${body.course.id}`), { method: 'PATCH', headers: adminWrite, body: JSON.stringify({ closed: true }) });
    const list = (await (await fetch(results('courses'), { headers: { Authorization: ADMIN } })).json()) as {
      courses: { id: string; responses: number | null; used: number | null; responsesBand: string | null; released: boolean }[];
    };
    expect(list.courses.find((c) => c.id === body.course.id)).toMatchObject({ released: false, responses: null, used: null, responsesBand: 'belowMin' });
    await fetch(results(`courses/${body.course.id}?withResponses=1&confirm=${encodeURIComponent('Kleiner Kurs')}`), { method: 'DELETE', headers: adminWrite });
  });

  it('refuses a second course with the same name', async () => {
    const dup = await fetch(results('courses'), {
      method: 'POST',
      headers: adminWrite,
      body: JSON.stringify({ label: 'instruktorenkurs neuwied', eventDate: '2026-12-01', count: 1 }),
    });
    expect(dup.status).toBe(409);
  });

  it('refuses a new version that turns a free-text item into a rating', async () => {
    const d = def();
    d.version = 2;
    const open = d.sections.find((x: { id: string }) => x.id === 'OPEN');
    open.items[0] = { id: 'O01', type: 'choice', text: 'Now a choice', options: ['a', 'b'] };
    const res = await fetch(`${base}/admin/api/apps/surveys`, { method: 'POST', headers: adminWrite, body: JSON.stringify(d) });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain('O01');
  });

  it('refuses to reopen a released course', async () => {
    const r = await fetch(results(`courses/${courseId}`), { method: 'PATCH', headers: adminWrite, body: JSON.stringify({ closed: false }) });
    expect(r.status).toBe(409);
  });

  it('closing the survey expires every code', async () => {
    const second = await fetch(results('courses'), {
      method: 'POST',
      headers: adminWrite,
      body: JSON.stringify({ label: 'Zweiter Kurs', eventDate: '2027-03-01', count: 1 }),
    });
    const extra = ((await second.json()) as { codes: string[] }).codes[0];
    const res = await fetch(results('status'), { method: 'POST', headers: adminWrite, body: JSON.stringify({ closed: true }) });
    expect(((await res.json()) as { coursesClosed: number }).coursesClosed).toBe(1);
    const check = await fetch(`${base}/api/surveys/coded-survey/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: extra }),
    });
    expect(check.status).toBe(409);
    expect((await post(sid(30), extra)).status).toBe(409);
  });

  it('deletes a course with its responses only for the global administration and after typing its name', async () => {
    expect((await fetch(results(`courses/${courseId}`), { method: 'DELETE', headers: adminWrite })).status).toBe(409);
    const asLead = await fetch(results(`courses/${courseId}?withResponses=1&confirm=${encodeURIComponent('Instruktorenkurs Neuwied')}`), {
      method: 'DELETE',
      headers: { Authorization: CODED_LEAD, ...WRITE },
    });
    expect(asLead.status).toBe(403);
    expect((await fetch(results(`courses/${courseId}?withResponses=1&confirm=wrong`), { method: 'DELETE', headers: adminWrite })).status).toBe(400);
    const ok = await fetch(results(`courses/${courseId}?withResponses=1&confirm=${encodeURIComponent('Instruktorenkurs Neuwied')}`), {
      method: 'DELETE',
      headers: adminWrite,
    });
    expect(ok.status).toBe(200);
    expect(store.count('coded-survey')).toBe(0);
  });

  it('limits answers about unknown codes, so codes cannot be found by guessing', async () => {
    await fetch(results('status'), { method: 'POST', headers: adminWrite, body: JSON.stringify({ closed: false }) });
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await fetch(`${base}/api/surveys/coded-survey/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: `ZZZZ-ZZ${String.fromCharCode(65 + (i % 26))}${i % 10 === 0 ? 'Z' : 'Y'}` }),
      });
      if (r.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});

describe('optional codes', () => {
  it('accepts no further code-less answers once those are released, also with disguised empty codes', async () => {
    const d = JSON.parse(fs.readFileSync(path.join(surveysDir, 'example-course-feedback', 'survey.json'), 'utf8'));
    d.id = 'optional-survey';
    d.accessCodes = 'optional';
    const w = { Authorization: ADMIN, ...WRITE };
    expect((await fetch(`${base}/admin/api/apps/surveys`, { method: 'POST', headers: w, body: JSON.stringify(d) })).status).toBe(201);
    const send = (n: number, code?: unknown) =>
      fetch(`${base}/api/surveys/optional-survey/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submissionId: `${String(n).padStart(8, '0')}-6666-4666-8666-666666666666`, surveyVersion: 1, answers, code }),
      });
    for (let i = 1; i <= 5; i++) expect((await send(i)).status).toBe(201);
    await fetch(`${base}/admin/api/results/optional-survey/status`, { method: 'POST', headers: w, body: JSON.stringify({ closed: true }) });
    const summary = (await (await fetch(`${base}/admin/api/results/optional-survey/summary`, { headers: { Authorization: ADMIN } })).json()) as { released: boolean };
    expect(summary.released).toBe(true);
    await fetch(`${base}/admin/api/results/optional-survey/status`, { method: 'POST', headers: w, body: JSON.stringify({ closed: false }) });
    expect((await send(6)).status).toBe(422);
    expect((await send(7, '----')).status).toBe(422);
    expect((await send(8, 1)).status).toBe(422);
    expect(store.count('optional-survey')).toBe(5);
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
    expect(csv.split('\r\n')[0]).toBe('record,collection,score,nested.x,list');
    const json = (await (await fetch(`${base}/admin/api/records/demo-app/records.json`, { headers: { Authorization: ADMIN } })).json()) as { records: unknown[] };
    expect(json.records).toHaveLength(2);
    const del = await fetch(`${base}/admin/api/records/demo-app?confirm=demo-app`, { method: 'DELETE', headers: auth });
    expect(((await del.json()) as { removed: number }).removed).toBe(2);
  });
});

describe('per-app databases and data access', () => {
  const data = (id: string, auth: string, query = 'format=json') => fetch(`${base}/admin/api/results/${id}/data?${query}`, { headers: { Authorization: auth } });

  beforeAll(() => {
    // An earlier test purged the survey: give it responses of its own.
    // It is closed for good by now, so the responses are written to the store directly.
    for (let i = 1; i <= 5; i++) {
      expect(store.insert('example-course-feedback', 1, `d${i}dddddd-dddd-4ddd-8ddd-dddddddddddd`, answers, { maxResponses: 1000, maxBytes: 1e7 })).toBe('stored');
    }
  });

  it('keeps every app in its own database files', () => {
    for (const name of ['answers.sqlite', 'codes.sqlite']) {
      expect(fs.existsSync(path.join(dataDir, 'db', 'example-course-feedback', name))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, name))).toBe(false);
    }
  });

  it('gives the survey administration all single responses with free texts', async () => {
    const res = await data('example-course-feedback', LEAD);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: { answers: Record<string, unknown> }[]; codebook: { key: string }[] };
    expect(body.rows.length).toBeGreaterThanOrEqual(5);
    expect(body.rows.some((r) => r.answers.O01 === '=cmd() and more')).toBe(true);
    expect(body.codebook.map((e) => e.key)).toContain('O01');
  });

  it('never shows one survey\'s data to the administration of another survey', async () => {
    const foreign = await data('example-course-feedback', CODED_LEAD);
    expect(foreign.status).not.toBe(200);
    expect(await foreign.text()).not.toContain('cmd()');
    for (const q of ['format=csv', 'format=rds', 'format=json-file']) expect((await data('example-course-feedback', CODED_LEAD, q)).status).not.toBe(200);
    expect((await data('coded-survey', LEAD)).status).not.toBe(200);
    expect((await fetch(`${base}/admin/api/databases`, { headers: { Authorization: LEAD } })).status).toBe(403);
    expect((await fetch(`${base}/admin/api/databases`)).status).toBe(401);
  });

  it('lists metadata of every database for the global administration', async () => {
    const res = await fetch(`${base}/admin/api/databases`, { headers: { Authorization: ADMIN } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { databases: { appId: string; responses: number; path: string; tables: { table: string }[] }[] };
    const own = body.databases.find((d) => d.appId === 'example-course-feedback');
    expect(own?.path).toBe('db/example-course-feedback');
    expect(own?.responses).toBeGreaterThanOrEqual(5);
    expect(own?.tables.map((t) => t.table)).toEqual(expect.arrayContaining(['responses', 'courses', 'access_codes', 'records']));
  });

  it('exports subsets as CSV, RDS and JSON and refuses malformed filters', async () => {
    const raw = Buffer.from(await (await data('example-course-feedback', LEAD, 'format=csv&fields=C01,O01')).arrayBuffer());
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // byte order mark for Excel
    const csv = raw.subarray(3).toString('utf8');
    expect(csv.split('\r\n')[0]).toBe('response;survey_version;course;C01;O01');
    expect(csv).toContain("'=cmd() and more");
    const comma = await (await data('example-course-feedback', LEAD, 'format=csv&sep=comma&fields=C01')).text();
    expect(comma.split('\r\n')[0]).toBe('response,survey_version,course,C01');
    const rds = Buffer.from(await (await data('example-course-feedback', LEAD, 'format=rds')).arrayBuffer());
    expect([rds[0], rds[1]]).toEqual([0x1f, 0x8b]);
    const none = (await (await data('example-course-feedback', LEAD, 'format=json&versions=99')).json()) as { rows: unknown[] };
    expect(none.rows).toHaveLength(0);
    expect((await data('example-course-feedback', LEAD, 'format=json&courses=../x')).status).toBe(400);
    expect((await data('example-course-feedback', LEAD, 'format=json&courses=k0000000000')).status).toBe(404);
    expect((await data('example-course-feedback', LEAD, 'format=json&fields=a;b')).status).toBe(400);
    expect((await data('example-course-feedback', LEAD, 'format=exe')).status).toBe(400);
  });

  it('treats an explicitly empty selection as nothing selected, not as everything', async () => {
    const noCourses = (await (await data('example-course-feedback', LEAD, 'format=json&courses=')).json()) as { rows: unknown[] };
    expect(noCourses.rows).toHaveLength(0);
    const noFields = (await (await data('example-course-feedback', LEAD, 'format=json&fields=')).json()) as { codebook: unknown[]; columns: string[] };
    expect(noFields.codebook).toHaveLength(0);
    expect(noFields.columns).toEqual(['response', 'survey_version', 'course']);
  });

  it('neutralises spreadsheet formulas and leading control characters in CSV cells', async () => {
    const { csvCell } = await import('../../server/data.ts');
    expect(csvCell('\tcmd', ';')).toBe("'\tcmd");
    expect(csvCell('=1+1', ';')).toBe("'=1+1");
    expect(csvCell('-3', ';')).toBe('-3');
    expect(csvCell('a;b', ';')).toBe('"a;b"');
  });

  it('moves data of the former shared files into per-app databases', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-container-migrate-'));
    const answers = new DatabaseSync(path.join(dir, 'answers.sqlite'));
    answers.exec(`CREATE TABLE responses (id TEXT PRIMARY KEY, survey_id TEXT NOT NULL, survey_version INTEGER NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE, course_id TEXT, size INTEGER NOT NULL, answers TEXT NOT NULL) WITHOUT ROWID`);
    answers.prepare('INSERT INTO responses VALUES (?, ?, ?, ?, ?, ?, ?)').run('r1', 'alpha', 1, 'd1', 'kaaaaaaaaaa', 9, '{"A":1}');
    answers.prepare('INSERT INTO responses VALUES (?, ?, ?, ?, ?, ?, ?)').run('r2', 'beta', 1, 'd2', null, 9, '{"B":2}');
    answers.close();
    const codes = new DatabaseSync(path.join(dir, 'codes.sqlite'));
    codes.exec(`CREATE TABLE courses (id TEXT PRIMARY KEY, survey_id TEXT NOT NULL, label TEXT NOT NULL, event_date TEXT NOT NULL,
      event_date_end TEXT, closed INTEGER NOT NULL DEFAULT 0, released INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
      CREATE TABLE access_codes (survey_id TEXT NOT NULL, code TEXT NOT NULL, course_id TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (survey_id, code)) WITHOUT ROWID`);
    codes.prepare('INSERT INTO courses (id, survey_id, label, event_date) VALUES (?, ?, ?, ?)').run('kaaaaaaaaaa', 'alpha', 'Kurs A', '2026-11-01');
    codes.prepare('INSERT INTO access_codes (survey_id, code, course_id, used) VALUES (?, ?, ?, 1)').run('alpha', 'ABCD2345', 'kaaaaaaaaaa');
    codes.close();
    const migrated = new Store(dir);
    expect(fs.existsSync(path.join(dir, 'answers.sqlite'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'codes.sqlite'))).toBe(false);
    expect(migrated.rawResponses('alpha')).toEqual([{ surveyVersion: 1, courseId: 'kaaaaaaaaaa', course: 'Kurs A', answers: { A: 1 } }]);
    expect(migrated.rawResponses('beta')).toEqual([{ surveyVersion: 1, courseId: null, course: null, answers: { B: 2 } }]);
    expect(migrated.databaseInfo('alpha')).toMatchObject({ responses: 1, courses: 1, codes: 1, usedCodes: 1 });
    expect(migrated.databaseInfo('beta')).toMatchObject({ responses: 1, courses: 0 });
    migrated.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
