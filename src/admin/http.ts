/** Server error codes the admin pages explain in plain German. */
const MESSAGES: Record<string, string> = {
  released_cannot_reopen:
    'Die Ergebnisse sind bereits freigegeben (mindestens 5 Antworten). Das Abschließen ist damit endgültig; ' +
    'wieder öffnen ist nicht möglich.',
};

/** Error of an admin request: `message` is readable text, `code` the server's error code (if any). */
export class AdminError extends Error {
  readonly code: string | null;
  readonly status: number;
  constructor(message: string, code: string | null, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Fetch helper for the admin pages: JSON in/out plus the header the server requires for changes. */
export async function adminFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('X-Requested-With', 'pwa-container');
  if (init.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  const res = await fetch(url, { ...init, headers, cache: 'no-store' });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const code = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : null;
    throw new AdminError(code ? (MESSAGES[code] ?? code) : `HTTP ${res.status}`, code, res.status);
  }
  return body as T;
}
