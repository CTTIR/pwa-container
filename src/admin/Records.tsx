import { useEffect, useState } from 'react';
import { recordsTable } from '../../shared/records.ts';
import { Shell } from '../components/Shell.tsx';
import { downloadRecordsXlsx } from './exportXlsx.ts';
import { adminFetch } from './http.ts';

interface RecordsInfo {
  app: { id: string; title: string; url: string; type: string };
  collecting: boolean;
  total: number;
  collections: { collection: string; records: number }[];
  limits: { maxRecordBytes: number; maxRecords: number };
}

const api = (appId: string, rest = '') => `/admin/api/records/${encodeURIComponent(appId)}${rest}`;

/** Data records an app has sent: overview, downloads, collection switch and deletion. */
export function Records({ appId }: { appId: string }) {
  const [info, setInfo] = useState<RecordsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setInfo(await adminFetch<RecordsInfo>(api(appId)));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <Shell title="Daten">{error ? <div className="panel panel-error">{error}</div> : <p className="status-text">Wird geladen …</p>}</Shell>;
  const xlsx = () =>
    act(async () => {
      const r = await adminFetch<{ records: { collection: string; receivedOn: string; data: unknown }[] }>(api(appId, '/records'));
      await downloadRecordsXlsx(appId, r.records, recordsTable);
    });

  return (
    <Shell brand="Daten" title={info.app.title} subtitle={info.app.id}>
      {error && <div className="panel panel-error">{error}</div>}
      <div className="admin-facts">
        <div>
          <span className="fact-num">{info.total}</span> Datensätze
        </div>
        <div>
          Annahme: <strong>{info.collecting ? 'eingeschaltet' : 'ausgeschaltet'}</strong>
        </div>
      </div>
      <div className="admin-actions">
        <button className="btn btn-primary" disabled={busy || !info.total} onClick={() => void xlsx()}>Excel (XLSX)</button>
        <a className="btn btn-secondary admin-link" href={api(appId, '/records.csv')} download>CSV</a>
        <a className="btn btn-secondary admin-link" href={api(appId, '/records.json')} download>JSON</a>
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void act(() => adminFetch(api(appId), { method: 'PATCH', body: JSON.stringify({ collecting: !info.collecting }) }))}
        >
          Annahme {info.collecting ? 'ausschalten' : 'einschalten'}
        </button>
        <button className="btn btn-link" onClick={() => void load()}>Aktualisieren</button>
      </div>
      <p className="admin-note">
        Gespeichert werden nur der Datensatz, seine Sammlung und der Empfangstag – keine Uhrzeit, keine IP-Adressen; Reihenfolge zufällig.
        Höchstens {info.limits.maxRecords.toLocaleString('de-DE')} Datensätze je App, je Datensatz {Math.round(info.limits.maxRecordBytes / 1024)} KB.
      </p>

      <h2 className="section-title">Sammlungen</h2>
      {info.collections.length === 0 ? (
        <p className="status-text">Noch keine Datensätze.</p>
      ) : (
        <table className="course-table">
          <thead>
            <tr>
              <th>Sammlung</th>
              <th>Datensätze</th>
              <th>Download</th>
            </tr>
          </thead>
          <tbody>
            {info.collections.map((c) => (
              <tr key={c.collection}>
                <td><code>{c.collection}</code></td>
                <td>{c.records}</td>
                <td className="course-actions">
                  <a className="btn btn-link" href={api(appId, `/records.csv?collection=${encodeURIComponent(c.collection)}`)} download>CSV</a>
                  <a className="btn btn-link" href={api(appId, `/records.json?collection=${encodeURIComponent(c.collection)}`)} download>JSON</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="admin-block">
        <h2 className="section-title">Einbindung in die App</h2>
        <p className="admin-note">
          Die App sendet Datensätze an ihre eigene Adresse. Das Hilfsskript speichert bei fehlender Verbindung zwischen und sendet später nach:
        </p>
        <pre className="code-block">{`<script src="/_pwa/records.js"></script>
<script>
  pwaRecords.submit({ score: 7, answers: ['a', 'b'] }, { collection: 'sessions' });
</script>`}</pre>
        <p className="admin-note">
          Ohne Hilfsskript: <code>POST /api/records</code> mit JSON <code>{'{"collection": "sessions", "data": {…}}'}</code> (Antwort 201).
        </p>
      </section>

      <section className="admin-block">
        <h2 className="section-title">Datensätze löschen</h2>
        <div className="danger-row">
          <label>
            Zur Bestätigung <code>{appId}</code> eingeben:
            <input className="text-input" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
          <button
            className="btn btn-danger"
            disabled={busy || confirm !== appId}
            onClick={() => void act(() => adminFetch(api(appId, `?confirm=${encodeURIComponent(confirm)}`), { method: 'DELETE' })).then(() => setConfirm(''))}
          >
            Alle Datensätze löschen
          </button>
        </div>
      </section>
    </Shell>
  );
}
