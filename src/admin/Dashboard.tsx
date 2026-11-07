import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { validateDefinition } from '../../shared/schema.ts';
import { Shell } from '../components/Shell.tsx';
import { adminFetch } from './http.ts';
import { ChangePassword } from './Password.tsx';
import { confirmSurveyStatus, reopenBlocked, setSurveyClosed } from './surveyStatus.ts';

interface AppInfo {
  id: string;
  type: 'survey' | 'static';
  source: 'provisioned' | 'uploaded';
  title: string;
  enabled: boolean;
  installedOn: string;
  url: string;
  hostLabel: string;
  version?: number;
  status?: 'open' | 'closed' | 'not_yet_open';
  statusOverride?: 'open' | 'closed' | null;
  opensAt?: string | null;
  closesAt?: string | null;
  /** Exact count of closed groups; null while open (then only responsesBand). */
  responses?: number | null;
  responsesBand?: 'belowMin' | 'atLeastMin' | null;
  subtitle?: string | null;
  collectRecords: boolean;
  records: number;
  accessCodes?: 'required' | 'optional' | null;
  courses?: number;
}

interface AppsResponse {
  apps: AppInfo[];
  problems: string[];
  themes: string[];
  limits: { maxFileBytes: number; maxTotalBytes: number; maxFiles: number };
  appDomain: string | null;
}

const STATUS: Record<string, string> = { open: 'offen', closed: 'geschlossen', not_yet_open: 'noch nicht geöffnet' };
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

function absolute(url: string): string {
  return new URL(url, window.location.origin).toString();
}

function formatDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–';
}

export function Dashboard() {
  const [data, setData] = useState<AppsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    try {
      setData(await adminFetch<AppsResponse>('/admin/api/apps'));
      setError(null);
    } catch (err) {
      setError(`Übersicht konnte nicht geladen werden: ${(err as Error).message}`);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async <T,>(fn: () => Promise<T>, done: string | ((result: T) => string)) => {
    setMessage(null);
    let failure: string | null = null;
    try {
      const result = await fn();
      setMessage(typeof done === 'function' ? done(result) : done);
    } catch (err) {
      failure = `Aktion fehlgeschlagen: ${(err as Error).message}`;
    }
    await load();
    // Set after reloading, so a failed action stays visible.
    if (failure) setError(failure);
  };

  return (
    <Shell brand="pwa-container" title="Verwaltung" subtitle="Apps und Umfragen auf diesem Server">
      {error && <div className="panel panel-error" role="alert">{error}</div>}
      {message && <div className="panel panel-done" role="status">{message}</div>}
      {data?.problems.length ? (
        <div className="panel panel-warn">
          <strong>Hinweise beim Laden</strong>
          <ul className="admin-problems">
            {data.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {!data && !error && <p className="status-text">Wird geladen …</p>}
      {data && (
        <>
          <h1 className="page-title">Apps ({data.apps.length})</h1>
          {data.apps.length === 0 && <p className="status-text">Noch keine Apps installiert.</p>}
          <div className="items">
            {data.apps.map((app) => (
              <AppCard key={app.id} app={app} act={act} appDomain={data.appDomain} />
            ))}
          </div>
          <Databases />
          <InstallSurvey act={act} />
          <UploadStatic act={act} limits={data.limits} existing={data.apps} appDomain={data.appDomain} />
          <ChangePassword endpoint="/admin/api/password" />
          {data.themes.length > 0 && (
            <p className="admin-note">Verfügbare Designs (Themes): {data.themes.join(', ')}</p>
          )}
        </>
      )}
    </Shell>
  );
}

type Act = <T>(fn: () => Promise<T>, done: string | ((result: T) => string)) => Promise<void>;

interface DatabaseInfo {
  app: AppInfo;
  appId: string;
  path: string;
  files: { name: string; bytes: number }[];
  tables: { file: string; table: string; rows: number }[];
  responses: number;
  responsesByVersion: { version: number; responses: number }[];
  uncodedResponses: number;
  courses: number;
  openCourses: number;
  codes: number;
  usedCodes: number;
  revokedCodes: number;
  records: number;
  collections: { collection: string; records: number }[];
  versions: number[];
}

function bytes(n: number): string {
  return n < 1024 * 1024 ? `${(n / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} KB` : `${(n / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
}

/** Metadata of every app's own database (global administration only). */
function Databases() {
  const [list, setList] = useState<DatabaseInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    adminFetch<{ databases: DatabaseInfo[] }>('/admin/api/databases')
      .then((r) => {
        setList(r.databases);
        setError(null);
      })
      .catch((err: Error) => setError(`Datenbanken konnten nicht geladen werden: ${err.message}`));
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="admin-section">
      <h2 className="section-title">
        <span>Datenbanken ({list?.length ?? '…'})</span>
      </h2>
      <p className="admin-note">
        Jede App hat ihre eigene Datenbank im Datenvolume unter <code>db/&lt;app&gt;/</code>: <code>answers.sqlite</code> (Antworten, Datensätze) und{' '}
        <code>codes.sqlite</code> (Kurse, Zugangscodes), getrennt gespeichert. Die Admins einer App sehen nur deren Datenbank.
      </p>
      {error && <div className="panel panel-error">{error}</div>}
      {list && list.length === 0 && <p className="status-text">Keine Datenbanken.</p>}
      <div className="items">
        {list?.map((d) => (
          <div key={d.appId} className="item-card">
            <h3 className="item-text">
              <span className="admin-key">{d.appId}</span> {d.app.title}
            </h3>
            <div className="admin-stats">
              <span>{d.responses} Antworten</span>
              {d.uncodedResponses > 0 && <span>{d.uncodedResponses} ohne Kurs</span>}
              <span>
                {d.courses} Kurse ({d.openCourses} offen)
              </span>
              <span>
                {d.codes} Codes, {d.usedCodes} benutzt, {d.revokedCodes} gesperrt
              </span>
              {d.records > 0 && <span>{d.records} Datensätze</span>}
              <span>{bytes(d.files.reduce((a, f) => a + f.bytes, 0))}</span>
            </div>
            <table className="data-table data-compare">
              <tbody>
                <tr>
                  <th>Pfad</th>
                  <td>
                    <code>{d.path}</code>
                  </td>
                </tr>
                <tr>
                  <th>Dateien</th>
                  <td>{d.files.map((f) => `${f.name} (${bytes(f.bytes)})`).join(', ')}</td>
                </tr>
                <tr>
                  <th>Tabellen</th>
                  <td>{d.tables.map((t) => `${t.file.replace('.sqlite', '')}.${t.table}: ${t.rows}`).join(', ')}</td>
                </tr>
                <tr>
                  <th>Versionen</th>
                  <td>
                    {d.versions.length
                      ? d.versions.map((v) => `v${v}: ${d.responsesByVersion.find((x) => x.version === v)?.responses ?? 0}`).join(', ')
                      : '–'}
                  </td>
                </tr>
                {d.collections.length > 0 && (
                  <tr>
                    <th>Sammlungen</th>
                    <td>{d.collections.map((c) => `${c.collection}: ${c.records}`).join(', ')}</td>
                  </tr>
                )}
              </tbody>
            </table>
            {d.app.type === 'survey' && (
              <div className="admin-actions">
                <a className="btn btn-secondary admin-link" href={`/admin/results/${encodeURIComponent(d.appId)}`}>
                  Datenbank öffnen
                </a>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function AppCard({ app, act, appDomain }: { app: AppInfo; act: Act; appDomain: string | null }) {
  const [qr, setQr] = useState<string | null>(null);
  const [label, setLabel] = useState(app.hostLabel);
  useEffect(() => setLabel(app.hostLabel), [app.hostLabel]);
  const [confirmPurge, setConfirmPurge] = useState('');
  const [showDanger, setShowDanger] = useState(false);
  const link = absolute(app.url);
  const patch = (body: object, done: string) =>
    act(() => adminFetch(`/admin/api/apps/${app.id}`, { method: 'PATCH', body: JSON.stringify(body) }), done);

  const toggleQr = async () => {
    if (qr) return setQr(null);
    setQr(await QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 2, width: 640 }));
  };

  const isSurvey = app.type === 'survey';
  /** Without access codes, closing is final once the survey has 5 or more responses. */
  const final = isSurvey && reopenBlocked(!!app.accessCodes, app.responses ?? 0);
  const setStatus = (close: boolean) => {
    if (!confirmSurveyStatus(app.title, close, !!app.accessCodes, final)) return;
    void act(
      () => setSurveyClosed(app.id, close),
      (r) =>
        close
          ? `${app.title}: geschlossen${r.coursesClosed ? `, ${r.coursesClosed} ${r.coursesClosed === 1 ? 'Kurs' : 'Kurse'} abgeschlossen` : ''}.`
          : `${app.title}: wieder geöffnet${app.accessCodes ? ' (Kurse bleiben abgeschlossen, bis sie einzeln wieder geöffnet werden)' : ''}.`,
    );
  };
  return (
    <section className={`item-card app-card${app.enabled ? '' : ' is-disabled'}`}>
      <div className="app-head">
        <div>
          <div className="app-title">{app.title}</div>
          <div className="app-meta">
            <code>{app.id}</code>
            <span className="badge">{isSurvey ? 'Umfrage' : 'Web-App'}</span>
            <span className="badge badge-quiet">{app.source === 'provisioned' ? 'aus Deployment' : 'hochgeladen'}</span>
            {!app.enabled && <span className="badge badge-off">gesperrt</span>}
          </div>
        </div>
        <div className="app-count" title={isSurvey ? 'Antworten' : 'Datensätze'}>
          <span className="fact-num">{isSurvey ? (app.responses ?? (app.responsesBand === 'atLeastMin' ? '≥ 5' : '< 5')) : app.records}</span>
          <span>{isSurvey ? 'Antworten' : 'Datensätze'}</span>
        </div>
      </div>

      {isSurvey && (
        <div className="app-status">
          Status: <strong>{STATUS[app.status ?? 'open']}</strong>
          {app.statusOverride ? ' (von Hand gesetzt)' : ''}
          {app.status === 'closed' && final ? ' (endgültig, Ergebnisse freigegeben)' : ''} · Schluss: {formatDate(app.closesAt)} · Version{' '}
          {app.version}
          {app.accessCodes ? ` · Einmal-Codes (${app.courses ?? 0} Kurse)` : ''}
        </div>
      )}
      {!isSurvey && (
        <div className="app-status">
          Datenannahme: <strong>{app.collectRecords ? 'eingeschaltet' : 'ausgeschaltet'}</strong>
        </div>
      )}

      <div className="app-link">
        <a href={app.url} target="_blank" rel="noreferrer">{link}</a>
        <button className="btn btn-link" onClick={() => void navigator.clipboard?.writeText(link)}>Link kopieren</button>
        <button className="btn btn-link" onClick={() => void toggleQr()}>{qr ? 'QR-Code ausblenden' : 'QR-Code'}</button>
      </div>
      {appDomain && (
        <div className="host-row">
          <label>
            Subdomain
            <span className="host-input">
              <input className="text-input" value={label} onChange={(e) => setLabel(e.target.value.trim().toLowerCase())} aria-label="Subdomain" />
              <span className="host-suffix">.{appDomain}</span>
            </span>
          </label>
          <button
            className="btn btn-secondary"
            disabled={label === app.hostLabel}
            onClick={() => {
              const ok = window.confirm(
                `Adresse von „${app.title}“ ändern?\n\nNeu: ${label}.${appDomain}\nBisher: ${app.hostLabel}.${appDomain}\n\n` +
                  'Der bisherige Link und alle bereits gedruckten QR-Codes' +
                  (isSurvey && app.accessCodes ? ' (auch alle Einmal-Code-Zettel)' : '') +
                  ' funktionieren danach nicht mehr.',
              );
              if (!ok) return;
              setQr(null);
              void patch({ hostLabel: label }, `${app.title}: neue Adresse ${label}.${appDomain}.`);
            }}
          >
            Übernehmen
          </button>
          <button
            className="btn btn-link"
            onClick={() => {
              if (
                window.confirm(
                  'Zufällige neue Subdomain vergeben?\n\nDer bisherige Link und alle bereits gedruckten QR-Codes' +
                    (isSurvey && app.accessCodes ? ' (auch alle Einmal-Code-Zettel)' : '') +
                    ' funktionieren danach nicht mehr.',
                )
              ) {
                setQr(null);
                void patch({ randomHost: true }, `${app.title}: neue zufällige Adresse vergeben.`);
              }
            }}
          >
            Zufällig neu
          </button>
        </div>
      )}
      {qr && (
        <div className="qr-box">
          <img src={qr} alt={`QR-Code für ${link}`} width={240} height={240} />
          <a className="btn btn-secondary admin-link" href={qr} download={`${app.id}-qr.png`}>QR als PNG speichern</a>
        </div>
      )}

      <div className="admin-actions">
        {isSurvey ? (
          <>
            <a className="btn btn-primary admin-link" href={`/admin/results/${app.id}`}>
              {app.accessCodes ? 'Auswertung, Kurse & Codes' : 'Auswertung'}
            </a>
            <a className="btn btn-secondary admin-link" href={`/admin/api/results/${app.id}/export.csv`} download>CSV</a>
          </>
        ) : (
          <>
            <a className="btn btn-primary admin-link" href={`/admin/records/${app.id}`}>Daten</a>
            <a className="btn btn-secondary admin-link" href={`/admin/api/records/${app.id}/records.csv`} download>CSV</a>
            <a className="btn btn-secondary admin-link" href={`/admin/api/records/${app.id}/records.json`} download>JSON</a>
            <button
              className="btn btn-secondary"
              onClick={() => void patch({ collectRecords: !app.collectRecords }, `${app.title}: Datenannahme ${app.collectRecords ? 'ausgeschaltet' : 'eingeschaltet'}.`)}
            >
              Datenannahme {app.collectRecords ? 'aus' : 'ein'}
            </button>
          </>
        )}
        {isSurvey && app.status !== 'closed' && (
          <button className="btn btn-secondary" onClick={() => setStatus(true)}>
            Umfrage schließen
          </button>
        )}
        {isSurvey && app.status === 'closed' && !final && (
          <button className="btn btn-secondary" onClick={() => setStatus(false)}>
            Umfrage öffnen
          </button>
        )}
        {isSurvey && app.statusOverride && !(app.status === 'closed' && final) && (
          <button className="btn btn-link" onClick={() => void patch({ statusOverride: null }, `${app.title}: Zeitplan aus der Definition gilt wieder.`)}>
            Zeitplan der Definition
          </button>
        )}
        <button
          className="btn btn-secondary"
          onClick={() => void patch({ enabled: !app.enabled }, `${app.title}: ${app.enabled ? 'gesperrt' : 'freigeschaltet'}.`)}
        >
          {app.enabled ? 'Sperren' : 'Freischalten'}
        </button>
        <button className="btn btn-link" onClick={() => setShowDanger((v) => !v)}>Weitere Aktionen</button>
      </div>

      {showDanger && (
        <div className="danger-zone">
          {isSurvey && (
            <div className="danger-row">
              <label>
                Alle Antworten löschen (z. B. nach einem Test). Zur Bestätigung <code>{app.id}</code> eingeben:
                <input className="text-input" value={confirmPurge} onChange={(e) => setConfirmPurge(e.target.value)} />
              </label>
              <button
                className="btn btn-danger"
                disabled={confirmPurge !== app.id}
                onClick={() =>
                  void act(
                    () => adminFetch(`/admin/api/apps/${app.id}/purge`, { method: 'POST', body: JSON.stringify({ confirm: confirmPurge }) }),
                    `${app.title}: Antworten gelöscht.`,
                  ).then(() => setConfirmPurge(''))
                }
              >
                Antworten löschen
              </button>
            </div>
          )}
          {app.source === 'uploaded' ? (
            <div className="danger-row">
              <span>App vom Server entfernen{isSurvey ? ' (nur möglich, wenn keine Antworten mehr vorhanden sind)' : ''}.</span>
              <button
                className="btn btn-danger"
                onClick={() => {
                  if (window.confirm(`${app.title} wirklich entfernen?`)) {
                    void act(() => adminFetch(`/admin/api/apps/${app.id}`, { method: 'DELETE' }), `${app.title} entfernt.`);
                  }
                }}
              >
                Entfernen
              </button>
            </div>
          ) : (
            <p className="admin-note">Diese App kommt aus dem Deployment und wird dort geändert oder entfernt.</p>
          )}
        </div>
      )}
    </section>
  );
}

function InstallSurvey({ act }: { act: Act }) {
  const [problems, setProblems] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File | undefined) => {
    setProblems([]);
    if (!file) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      setProblems(['Die Datei ist kein gültiges JSON.']);
      return;
    }
    const errors = validateDefinition(raw);
    if (errors.length) {
      setProblems(errors);
      return;
    }
    await act(
      () => adminFetch('/admin/api/apps/surveys', { method: 'POST', body: JSON.stringify(raw) }),
      `Umfrage ${(raw as { id: string }).id} installiert.`,
    );
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <section className="admin-block">
      <h2 className="section-title">Umfrage hinzufügen oder ersetzen</h2>
      <p className="admin-note">
        Eine Umfrage-Definition (<code>survey.json</code>) auswählen. Sie wird vor dem Hochladen geprüft. Hat die Umfrage schon
        Antworten, muss für inhaltliche Änderungen die <code>version</code> erhöht werden.
      </p>
      <input ref={inputRef} type="file" accept="application/json,.json" onChange={(e) => void onFile(e.target.files?.[0])} />
      {problems.length > 0 && (
        <div className="panel panel-error">
          <ul className="admin-problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function UploadStatic({
  act,
  limits,
  existing,
  appDomain,
}: {
  act: Act;
  limits: AppsResponse['limits'];
  existing: AppInfo[];
  appDomain: string | null;
}) {
  const [id, setId] = useState('');
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const conflict = existing.find((a) => a.id === id && a.type !== 'static');
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const relPath = (f: File) => {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const parts = rel.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : rel;
  };
  const hasIndex = files.some((f) => relPath(f) === 'index.html');

  const upload = async () => {
    setProblem(null);
    if (!ID_PATTERN.test(id)) return setProblem('Kennung: 3–64 Zeichen, nur Kleinbuchstaben, Ziffern und Bindestriche.');
    if (conflict) return setProblem('Diese Kennung gehört bereits zu einer Umfrage.');
    if (!hasIndex) return setProblem('Der gewählte Ordner enthält keine index.html auf oberster Ebene.');
    if (files.length > limits.maxFiles || totalBytes > limits.maxTotalBytes) return setProblem('Der Ordner ist zu groß.');
    await act(async () => {
      await adminFetch(`/admin/api/apps/${id}/static/begin`, { method: 'POST', body: JSON.stringify({ title: title || id }) });
      let i = 0;
      for (const f of files) {
        i += 1;
        setProgress(`Lade Datei ${i} von ${files.length} hoch …`);
        const path = relPath(f).split('/').map(encodeURIComponent).join('/');
        await adminFetch(`/admin/api/apps/${id}/static/files/${path}`, {
          method: 'PUT',
          body: f,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }
      setProgress('Veröffentliche …');
      await adminFetch(`/admin/api/apps/${id}/static/publish`, { method: 'POST' });
    }, `Web-App ${id} veröffentlicht.`);
    setProgress(null);
  };

  return (
    <section className="admin-block">
      <h2 className="section-title">Web-App hochladen</h2>
      <p className="admin-note">
        Den fertig gebauten Ordner einer Web-App bzw. PWA wählen (z. B. <code>dist/</code>). Er muss auf oberster Ebene eine{' '}
        <code>index.html</code> enthalten. Eine bestehende Web-App gleicher Kennung wird ersetzt.{' '}
        {appDomain ? (
          <>
            Die App bekommt eine eigene, zufällige Subdomain unter <code>{appDomain}</code> (änderbar) und läuft dort ab <code>/</code>;
            normal mit <code>base: '/'</code> gebaute Apps funktionieren also unverändert.
          </>
        ) : (
          <>
            Ohne eigene Domain läuft die App unter <code>/a/&lt;Kennung&gt;/</code>; Vite-Apps dann mit{' '}
            <code>base: '/a/&lt;Kennung&gt;/'</code> bauen (bei pwa-quest: <code>BASE_PATH=/a/&lt;Kennung&gt;/</code>). Nur
            vertrauenswürdige Apps hochladen: Sie laufen unter derselben Adresse wie die Verwaltung.
          </>
        )}
      </p>
      <div className="form-grid">
        <label>
          Kennung
          <input className="text-input" value={id} onChange={(e) => setId(e.target.value.trim().toLowerCase())} placeholder="z. B. mein-tool" />
        </label>
        <label>
          Titel
          <input className="text-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Anzeigename" />
        </label>
        <label>
          Ordner
          <input
            type="file"
            multiple
            // @ts-expect-error non-standard but widely supported folder picker
            webkitdirectory=""
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
        </label>
      </div>
      {files.length > 0 && (
        <p className="admin-note">
          {files.length} Dateien, {(totalBytes / 1024 / 1024).toFixed(1)} MB{hasIndex ? '' : ' – keine index.html gefunden'}
        </p>
      )}
      {problem && <div className="panel panel-error">{problem}</div>}
      {progress && <p className="status-text" role="status">{progress}</p>}
      <button className="btn btn-primary" disabled={!files.length || !id || !!progress} onClick={() => void upload()}>
        Hochladen und veröffentlichen
      </button>
    </section>
  );
}
