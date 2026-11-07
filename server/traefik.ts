import fs from 'node:fs';
import type { Config } from './config.ts';
import type { AppEntry } from './registry.ts';

/**
 * Writes a Traefik file-provider configuration with one router per app host name, so every
 * app gets its own subdomain and Traefik requests a certificate for it automatically.
 * Requires a wildcard DNS record (`*.<APP_DOMAIN>`) pointing at the server.
 */
export function traefikConfig(config: Config, apps: AppEntry[]): string {
  const t = config.traefik!;
  const lines = ['# Written by pwa-container. Do not edit; changes are overwritten.', 'http:', '  routers:'];
  const sorted = [...apps].sort((a, b) => a.id.localeCompare(b.id));
  if (sorted.length === 0) lines[2] = '  routers: {}';
  for (const app of sorted) {
    lines.push(
      `    pwa-app-${app.id}:`,
      `      rule: "Host(\`${app.hostLabel}.${config.appDomain}\`)"`,
      `      entryPoints: [${t.entrypoint}]`,
      `      service: pwa-container-apps`,
      `      tls:`,
      `        certResolver: ${t.certResolver}`,
    );
  }
  lines.push('  services:', '    pwa-container-apps:', '      loadBalancer:', '        servers:', `          - url: "${t.serviceUrl}"`);
  return lines.join('\n') + '\n';
}

export function createTraefikWriter(config: Config, log: (msg: string) => void): (apps: AppEntry[]) => void {
  let last = '';
  return (apps) => {
    if (!config.traefik || !config.appDomain) return;
    const content = traefikConfig(config, apps);
    if (content === last) return;
    try {
      // Written in place: the file is usually a single-file bind mount, where renames fail.
      fs.writeFileSync(config.traefik.dynamicFile, content);
      last = content;
      log(`traefik routes updated (${apps.length} app host name(s))`);
    } catch (err) {
      log(`could not write traefik routes to ${config.traefik.dynamicFile}: ${(err as Error).message}`);
    }
  };
}
