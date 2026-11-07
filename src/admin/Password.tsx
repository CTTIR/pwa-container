import type React from 'react';
import { useState } from 'react';
import { AdminError, adminFetch } from './http.ts';

const MESSAGES: Record<string, string> = {
  wrong_current: 'Das bisherige Passwort stimmt nicht.',
  mismatch: 'Die beiden neuen Passwörter stimmen nicht überein.',
  too_short: 'Das neue Passwort braucht mindestens 16 Zeichen.',
  too_long: 'Das neue Passwort darf höchstens 256 Zeichen haben.',
  same: 'Das neue Passwort muss sich vom bisherigen unterscheiden.',
  busy: 'Gerade viele Anmeldeprüfungen – bitte gleich noch einmal versuchen.',
  not_found: 'Für diese Anmeldung kann das Passwort hier nicht geändert werden.',
  unavailable: 'Passwortänderung ist auf diesem Server nicht eingerichtet.',
};

/**
 * Lets the signed-in administrator change their own password. `endpoint` is the global
 * /admin/api/password or the survey's /admin/api/results/<id>/password.
 */
export function ChangePassword({ endpoint }: { endpoint: string }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== repeat) return setError(MESSAGES.mismatch);
    if (next.length < 16) return setError(MESSAGES.too_short);
    setBusy(true);
    try {
      await adminFetch(endpoint, { method: 'POST', body: JSON.stringify({ current, next, repeat }) });
      setCurrent('');
      setNext('');
      setRepeat('');
      setDone(true);
    } catch (err) {
      const code = err instanceof AdminError ? err.code : null;
      setError((code && MESSAGES[code]) || `Passwort konnte nicht geändert werden (${(err as Error).message}).`);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <section className="admin-section">
        <div className="panel panel-done" role="status">
          <strong className="panel-title">Passwort geändert</strong>
          <p>
            Ab sofort gilt das neue Passwort. Bitte im Passwort-Manager aktualisieren, dann diese Seite neu laden und mit dem neuen Passwort
            anmelden.
          </p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Neu laden und anmelden
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="admin-section">
      <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="section-title password-summary">
          <span>Eigenes Passwort ändern</span>
        </summary>
        <form className="password-form" onSubmit={(e) => void submit(e)}>
          <label>
            Bisheriges Passwort
            <input className="text-input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </label>
          <label>
            Neues Passwort (mindestens 16 Zeichen)
            <input
              className="text-input"
              type="password"
              autoComplete="new-password"
              minLength={16}
              maxLength={256}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </label>
          <label>
            Neues Passwort wiederholen
            <input
              className="text-input"
              type="password"
              autoComplete="new-password"
              minLength={16}
              maxLength={256}
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              required
            />
          </label>
          {error && (
            <div className="panel panel-error" role="alert">
              {error}
            </div>
          )}
          <div className="admin-actions">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              Passwort ändern
            </button>
          </div>
          <p className="admin-note">Gilt nur für Ihre eigene Anmeldung. Danach müssen Sie sich mit dem neuen Passwort neu anmelden.</p>
        </form>
      </details>
    </section>
  );
}
