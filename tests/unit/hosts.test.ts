import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.ts';
import { AdminAuth, hashPassword } from '../../server/auth.ts';
import { loadConfig } from '../../server/config.ts';
import { Store } from '../../server/db.ts';
import { AppRegistry, randomLabel } from '../../server/registry.ts';
import { traefikConfig } from '../../server/traefik.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-container-hosts-'));
const surveysDir = path.join(root, 'surveys');
const dataDir = path.join(root, 'data');
const distDir = path.join(root, 'dist');
let server: http.Server;
let port = 0;
let store: Store;
let registry: AppRegistry;
let written = '';
const ADMIN = 'Basic ' + Buffer.from('admin:correct horse battery').toString('base64');

function get(host: string, p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { Host: host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const def = JSON.parse(fs.readFileSync(new URL('../../examples/surveys/example-course-feedback/survey.json', import.meta.url), 'utf8'));
  def.subdomain = 'feedback';
  fs.mkdirSync(path.join(surveysDir, def.id), { recursive: true });
  fs.writeFileSync(path.join(surveysDir, def.id, 'survey.json'), JSON.stringify(def));
  fs.mkdirSync(path.join(dataDir, 'apps', 'tool', 'live'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'apps', 'tool', 'live', 'index.html'), '<p>tool app</p>');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<p>participant shell</p>');
  fs.writeFileSync(path.join(distDir, 'admin.html'), '<p>admin shell</p>');
  const creds = path.join(root, 'admins.json');
  fs.writeFileSync(creds, JSON.stringify({ global: [{ user: 'admin', hash: hashPassword('correct horse battery') }] }));
  const config = loadConfig({
    APP_DOMAIN: 'example.org',
    ADMIN_HOST: 'pwa.example.org',
    TRAEFIK_DYNAMIC_FILE: path.join(root, 'traefik.yml'),
    DATA_DIR: dataDir,
  });
  store = new Store(dataDir);
  registry = new AppRegistry(store, surveysDir, dataDir, () => {}, {
    reservedLabels: ['pwa', 'cloud'],
    onChange: (apps) => (written = traefikConfig(config, apps)),
  });
  const handler = createApp({
    store,
    registry,
    auth: new AdminAuth(creds),
    distDir,
    themesDir: path.join(root, 'themes'),
    log: () => {},
    appDomain: 'example.org',
    adminHost: 'pwa.example.org',
  });
  server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('subdomains', () => {
  it('uses the preferred label of a survey and a random label otherwise', () => {
    expect(registry.get('example-course-feedback')?.hostLabel).toBe('feedback');
    expect(registry.get('tool')?.hostLabel).toMatch(/^[a-z][a-z0-9]{7}$/);
    expect(randomLabel()).toMatch(/^[a-z][a-z0-9]{7}$/);
  });

  it('serves each app on its own host', async () => {
    const ctx = await get('feedback.example.org', '/api/context');
    expect(JSON.parse(ctx.body)).toEqual({ app: { id: 'example-course-feedback', type: 'survey' } });
    expect((await get('feedback.example.org', '/')).body).toContain('participant shell');
    const tool = registry.get('tool')!.hostLabel;
    expect((await get(`${tool}.example.org`, '/')).body).toContain('tool app');
    expect((await get(`${tool}.example.org`, '/deep/link')).body).toContain('tool app');
  });

  it('offers the organiser entry on a survey host, but not the dashboard or other apps', async () => {
    expect((await get('feedback.example.org', '/admin')).status).toBe(401);
    expect((await get('feedback.example.org', '/admin', { Authorization: ADMIN })).body).toContain('admin shell');
    expect((await get('feedback.example.org', '/admin/api/results/example-course-feedback/summary', { Authorization: ADMIN })).status).toBe(200);
    expect((await get('feedback.example.org', '/admin/api/apps', { Authorization: ADMIN })).status).toBe(404);
    expect((await get('feedback.example.org', '/admin/results/other', { Authorization: ADMIN })).status).toBe(404);
  });

  it('keeps the administration off app hosts and unknown hosts', async () => {
    const tool = registry.get('tool')!.hostLabel;
    expect((await get(`${tool}.example.org`, '/admin', { Authorization: ADMIN })).body).toContain('tool app');
    expect((await get('feedback.example.org', '/api/surveys/other')).status).toBe(404);
    expect((await get('nothing-here.example.org', '/')).status).toBe(404);
    expect((await get('pwa.example.org', '/admin', { Authorization: ADMIN })).status).toBe(200);
  });

  it('changes labels, refuses reserved or taken ones, and rewrites the Traefik routes', () => {
    expect(registry.setHostLabel('tool', 'cloud')).toMatch(/reserved/);
    expect(registry.setHostLabel('tool', 'feedback')).toMatch(/already used/);
    expect(registry.setHostLabel('tool', 'Bad Label')).toMatch(/subdomain/);
    expect(registry.setHostLabel('tool', 'tools')).toBeNull();
    expect(written).toContain('Host(`tools.example.org`)');
    expect(written).toContain('Host(`feedback.example.org`)');
    expect(written).toContain('certResolver: letsencrypt');
  });
});
