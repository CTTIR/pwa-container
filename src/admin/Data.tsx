import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { AnswerValue, Answers } from '../../shared/schema.ts';
import { fitCell, sheetNamer } from './exportXlsx.ts';
import { adminFetch } from './http.ts';

/** One entry of the codebook the server sends with the data. */
export interface CodebookEntry {
  key: string;
  type: 'scale' | 'matrix' | 'choice' | 'text' | 'photo' | 'unknown';
  section: string | null;
  text: string | null;
  column: string | null;
  values?: { value: number; label: string }[];
  notApplicable?: { value: string; label: string } | null;
  options?: string[];
  multiple?: boolean;
}

interface DataRow {
  response: number;
  surveyVersion: number;
  course: string | null;
  answers: Answers;
}

interface DataResponse {
  survey: { id: string; title: string; version: number };
  codebook: CodebookEntry[];
  columns: string[];
  rows: DataRow[];
  courses: { id: string; label: string; eventDate: string; eventDateEnd: string | null; closed: boolean }[];
  versions: number[];
  role: 'global' | 'survey';
}

/** Value used in filters and URLs for responses without a course (survey without codes). */
const NO_COURSE = 'none';
const PAGE = 25;

/** `params` with value undefined are left out; an empty string is an explicitly empty selection. */
const photoUrl = (surveyId: string, id: string) => `/admin/api/results/${encodeURIComponent(surveyId)}/photos/${id}.jpg`;

/** Small previews of the photos of one answer; each opens the full photo. */
function PhotoLinks({ surveyId, value }: { surveyId: string; value: AnswerValue | undefined }) {
  if (!Array.isArray(value) || value.length === 0) return null;
  return (
    <span className="data-photos">
      {value.map((id) => (
        <a key={id} href={photoUrl(surveyId, id)} target="_blank" rel="noopener" title={`${id}.jpg`}>
          <img src={photoUrl(surveyId, id)} alt={`Foto ${id.slice(0, 6)}`} loading="lazy" />
        </a>
      ))}
    </span>
  );
}

const dataUrl = (surveyId: string, params: Record<string, string | undefined>) => {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined));
  return `/admin/api/results/${encodeURIComponent(surveyId)}/data?${q.toString()}`;
};

/** Same separator for multiple choices as the server's CSV and RDS exports. */
function cellText(v: AnswerValue | undefined): string {
  if (v === undefined) return '';
  return Array.isArray(v) ? v.join('|') : String(v);
}

function fmt(n: number | null): string {
  return n === null ? '–' : n.toLocaleString('de-DE', { maximumFractionDigits: 2 });
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The survey's own database: every single response with free texts, filtered by course, version
 * and field; shown as a table or as charts and downloadable as CSV, Excel, R (RDS) or JSON.
 * Only data of this survey are requested (the server checks the sign-in for this survey).
 */
export function DataExplorer({ surveyId }: { surveyId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="admin-section data-explorer">
      <h2 className="section-title">
        <span>Datenbank</span>
      </h2>
      {open ? (
        <DataView surveyId={surveyId} />
      ) : (
        <>
          <p className="admin-note">Alle Einzelantworten dieser Umfrage ansehen, auswerten und herunterladen.</p>
          <div className="admin-actions">
            <button className="btn btn-primary" onClick={() => setOpen(true)}>
              Datenbank öffnen
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function DataView({ surveyId }: { surveyId: string }) {
  const [data, setData] = useState<DataResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [courses, setCourses] = useState<Set<string> | null>(null);
  const [versions, setVersions] = useState<Set<number> | null>(null);
  const [fields, setFields] = useState<Set<string> | null>(null);
  const [view, setView] = useState<'table' | 'charts'>('charts');
  const [byCourse, setByCourse] = useState(false);
  const [page, setPage] = useState(0);
  const [sep, setSep] = useState<'semicolon' | 'comma'>('semicolon');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const d = await adminFetch<DataResponse>(dataUrl(surveyId, { format: 'json' }));
      setData(d);
      setError(null);
    } catch (err) {
      setError(`Daten konnten nicht geladen werden (${(err as Error).message}).`);
    }
  };

  useEffect(() => {
    void load();
  }, [surveyId]);

  const courseOptions = useMemo(() => {
    if (!data) return [];
    const list = data.courses.map((c) => ({ id: c.id, label: c.label, date: c.eventDate }));
    if (data.rows.some((r) => r.course === null)) list.push({ id: NO_COURSE, label: 'ohne Kurs', date: '' });
    return list;
  }, [data]);
  const courseIdByLabel = useMemo(() => new Map(data?.courses.map((c) => [c.label, c.id]) ?? []), [data]);

  if (error && !data) return <div className="panel panel-error">{error}</div>;
  if (!data) return <p className="status-text">Daten werden geladen …</p>;

  const allCourses = courses === null;
  const allVersions = versions === null;
  const allFields = fields === null;
  const chosenFields = data.codebook.filter((e) => allFields || fields.has(e.key));
  const rows = data.rows.filter((r) => {
    const cid = r.course === null ? NO_COURSE : (courseIdByLabel.get(r.course) ?? '');
    return (allCourses || courses.has(cid)) && (allVersions || versions.has(r.surveyVersion));
  });
  const subset = !allCourses || !allVersions || !allFields;
  const params = {
    courses: allCourses ? undefined : [...courses].join(','),
    versions: allVersions ? undefined : [...versions].join(','),
    fields: allFields ? undefined : chosenFields.map((e) => e.key).join(','),
  };
  const nothing = rows.length === 0 || chosenFields.length === 0;

  const toggle = <T,>(set: Set<T> | null, all: T[], value: T): Set<T> | null => {
    const next = new Set(set ?? all);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next.size === all.length ? null : next;
  };

  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages - 1);
  const sections = [...new Set(data.codebook.map((e) => e.section ?? 'Frühere Versionen'))];

  const downloadXlsx = async () => {
    setBusy(true);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      const name = sheetNamer();
      const header = ['response', 'survey_version', 'course', ...chosenFields.map((e) => e.key)];
      const body = rows.map((r, i) => [
        i + 1,
        r.surveyVersion,
        r.course ?? '',
        ...chosenFields.map((e) => {
          const v = r.answers[e.key];
          return typeof v === 'number' ? v : v === undefined ? null : fitCell(cellText(v));
        }),
      ]);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...body]), name('Daten'));
      const book = [
        ['key', 'type', 'section', 'question', 'column', 'values', 'not_applicable', 'options'],
        ...chosenFields.map((e) => [
          e.key,
          e.type,
          e.section ?? '',
          fitCell(e.text ?? ''),
          e.column ?? '',
          e.values ? e.values.map((v) => `${v.value}=${v.label}`).join(' | ') : '',
          e.notApplicable ? `${e.notApplicable.value}=${e.notApplicable.label}` : '',
          e.options ? e.options.join(' | ') : '',
        ]),
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(book), name('Codebuch'));
      XLSX.writeFile(wb, `${data.survey.id}_daten${subset ? '_teilmenge' : ''}.xlsx`, { compression: true });
    } catch (err) {
      setError(`Excel-Export fehlgeschlagen (${(err as Error).message}).`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="admin-note">
        Alle Einzelantworten dieser Umfrage einschließlich Freitexten, Version und Kurs. Die Reihenfolge der Zeilen ist zufällig und sagt
        nichts über den Zeitpunkt der Abgabe. Datum und Uhrzeit werden nicht gespeichert.
      </p>
      {error && <div className="panel panel-error">{error}</div>}

      <div className="data-filters">
        <fieldset>
          <legend>Kurse</legend>
          {courseOptions.length === 0 && <span className="status-text">keine</span>}
          {courseOptions.map((c) => (
            <label key={c.id} className="data-check">
              <input
                type="checkbox"
                checked={allCourses || courses.has(c.id)}
                onChange={() => setCourses(toggle(courses, courseOptions.map((o) => o.id), c.id))}
              />
              {c.label}
              {c.date && <span className="item-optional"> · {new Date(c.date).toLocaleDateString('de-DE')}</span>}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Versionen</legend>
          {data.versions.map((v) => (
            <label key={v} className="data-check">
              <input type="checkbox" checked={allVersions || versions.has(v)} onChange={() => setVersions(toggle(versions, data.versions, v))} />
              Version {v}
              {v === data.survey.version && <span className="item-optional"> (aktuell)</span>}
            </label>
          ))}
        </fieldset>
        <details className="data-fields">
          <summary>
            Felder: {chosenFields.length} von {data.codebook.length}
          </summary>
          <div className="admin-actions">
            <button className="btn btn-link" onClick={() => setFields(null)}>
              alle
            </button>
            <button className="btn btn-link" onClick={() => setFields(new Set())}>
              keine
            </button>
          </div>
          {sections.map((section) => (
            <fieldset key={section}>
              <legend>{section}</legend>
              {data.codebook
                .filter((e) => (e.section ?? 'Frühere Versionen') === section)
                .map((e) => (
                  <label key={e.key} className="data-check">
                    <input
                      type="checkbox"
                      checked={allFields || fields.has(e.key)}
                      onChange={() => setFields(toggle(fields, data.codebook.map((x) => x.key), e.key))}
                    />
                    <span className="admin-key">{e.key}</span> {e.text ?? ''}
                    {e.column && <span className="item-optional"> – {e.column}</span>}
                  </label>
                ))}
            </fieldset>
          ))}
        </details>
      </div>

      <div className="admin-facts">
        <div>
          <span className="fact-num">{rows.length}</span> von {data.rows.length} Antworten ausgewählt
        </div>
        <div>{chosenFields.length} Felder</div>
      </div>

      <div className="admin-actions">
        <DownloadLink disabled={nothing} primary href={dataUrl(surveyId, { ...params, format: 'csv', sep })}>
          CSV
        </DownloadLink>
        <button className="btn btn-primary" disabled={busy || nothing} onClick={() => void downloadXlsx()}>
          Excel (XLSX)
        </button>
        <DownloadLink disabled={nothing} primary href={dataUrl(surveyId, { ...params, format: 'rds' })}>
          R (RDS)
        </DownloadLink>
        <DownloadLink disabled={nothing} href={dataUrl(surveyId, { ...params, format: 'json-file' })}>
          JSON
        </DownloadLink>
        {data.codebook.some((e) => e.type === 'photo') && (
          <a className="btn btn-secondary admin-link" href={`/admin/api/results/${encodeURIComponent(surveyId)}/photos`} download>
            Fotos (ZIP)
          </a>
        )}
        <a className="btn btn-secondary admin-link" href={dataUrl(surveyId, { ...params, format: 'codebook.csv', sep })} download>
          Codebuch (CSV)
        </a>
        <label className="data-check">
          CSV-Trennzeichen
          <select className="text-input data-select" value={sep} onChange={(e) => setSep(e.target.value as 'semicolon' | 'comma')}>
            <option value="semicolon">Semikolon (Excel DE)</option>
            <option value="comma">Komma (R, international)</option>
          </select>
        </label>
        <button className="btn btn-link" onClick={() => void load()}>
          Aktualisieren
        </button>
      </div>
      <p className="admin-note">
        Downloads enthalten {subset ? 'nur die gewählte Teilmenge' : 'alle Daten'}. In R: <code>d &lt;- readRDS("datei.rds")</code>; Fragetexte stehen
        in <code>attr(d$SPALTE, "label")</code>, Skalenwerte in <code>attr(d$SPALTE, "labels")</code>, „nicht beurteilbar“ ist NA.
      </p>

      <div className="admin-actions data-tabs" role="tablist">
        <button role="tab" aria-selected={view === 'charts'} className={`btn ${view === 'charts' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('charts')}>
          Diagramme
        </button>
        <button role="tab" aria-selected={view === 'table'} className={`btn ${view === 'table' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('table')}>
          Tabelle
        </button>
        {view === 'charts' && courseOptions.length > 1 && (
          <label className="data-check">
            <input type="checkbox" checked={byCourse} onChange={(e) => setByCourse(e.target.checked)} />
            Mittelwerte je Kurs vergleichen
          </label>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="status-text">Keine Antworten in dieser Auswahl.</p>
      ) : view === 'table' ? (
        <>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Version</th>
                  <th>Kurs</th>
                  {chosenFields.map((e) => (
                    <th key={e.key} title={[e.text, e.column].filter(Boolean).join(' – ')}>
                      {e.key}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(current * PAGE, current * PAGE + PAGE).map((r, i) => (
                  <tr key={current * PAGE + i}>
                    <td>{current * PAGE + i + 1}</td>
                    <td>{r.surveyVersion}</td>
                    <td>{r.course ?? '–'}</td>
                    {chosenFields.map((e) => (
                      <td key={e.key} className={e.type === 'text' ? 'data-text' : undefined}>
                        {e.type === 'photo' ? <PhotoLinks surveyId={surveyId} value={r.answers[e.key]} /> : cellText(r.answers[e.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="admin-actions">
              <button className="btn btn-secondary" disabled={current === 0} onClick={() => setPage(current - 1)}>
                zurück
              </button>
              <span className="status-text">
                Seite {current + 1} von {pages}
              </span>
              <button className="btn btn-secondary" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                weiter
              </button>
            </div>
          )}
        </>
      ) : (
        chosenFields.map((e) => <FieldChart key={e.key} entry={e} rows={rows} byCourse={byCourse} surveyId={surveyId} />)
      )}
    </>
  );
}

function FieldChart({ entry, rows, byCourse, surveyId }: { entry: CodebookEntry; rows: DataRow[]; byCourse: boolean; surveyId: string }) {
  const values = rows.map((r) => r.answers[entry.key]);
  const given = values.filter((v): v is AnswerValue => v !== undefined && v !== '');
  const title = (
    <h3 className="item-text">
      <span className="admin-key">{entry.key}</span> {entry.text ?? ''}
      {entry.column && <span className="item-optional"> – {entry.column}</span>}
    </h3>
  );
  if (entry.type === 'scale' || entry.type === 'matrix') {
    const nums = given.filter((v): v is number => typeof v === 'number');
    const na = given.length - nums.length;
    const opts = entry.values ?? [...new Set(nums)].sort((a, b) => a - b).map((v) => ({ value: v, label: String(v) }));
    // Values of a continuous slider count towards the nearest marked option.
    const counts = opts.map((o) => ({ ...o, n: nums.filter((x) => (Number.isInteger(x) ? x : Math.round(x)) === o.value).length }));
    const max = Math.max(1, ...counts.map((c) => c.n), na);
    const groups = byCourse ? [...new Set(rows.map((r) => r.course ?? 'ohne Kurs'))].sort() : [];
    return (
      <div className="item-card">
        {title}
        <div className="admin-stats">
          <span>n = {nums.length}</span>
          <span>MW {fmt(mean(nums))}</span>
          <span>Median {fmt(median(nums))}</span>
          {entry.notApplicable && <span>{entry.notApplicable.value} {na}</span>}
          <span>fehlend {rows.length - given.length}</span>
        </div>
        <div className="bars">
          {counts.map((c) => (
            <Bar key={c.value} label={String(c.value)} title={c.label} count={c.n} max={max} />
          ))}
          {entry.notApplicable && <Bar label={entry.notApplicable.value} title={entry.notApplicable.label} count={na} max={max} muted />}
        </div>
        {byCourse && (
          <table className="data-table data-compare">
            <thead>
              <tr>
                <th>Kurs</th>
                <th>n</th>
                <th>MW</th>
                <th>Median</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const xs = rows
                  .filter((r) => (r.course ?? 'ohne Kurs') === g)
                  .map((r) => r.answers[entry.key])
                  .filter((v): v is number => typeof v === 'number');
                return (
                  <tr key={g}>
                    <td>{g}</td>
                    <td>{xs.length}</td>
                    <td>{fmt(mean(xs))}</td>
                    <td>{fmt(median(xs))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    );
  }
  if (entry.type === 'photo') {
    const ids = given.flatMap((v) => (Array.isArray(v) ? v : []));
    return (
      <div className="item-card">
        {title}
        {ids.length === 0 ? <p className="status-text">Keine Fotos.</p> : <PhotoLinks surveyId={surveyId} value={ids} />}
      </div>
    );
  }
  if (entry.type === 'text') {
    const texts = given.map(String).filter((t) => t.trim());
    return (
      <div className="item-card">
        {title}
        {texts.length === 0 ? (
          <p className="status-text">Keine Freitexte.</p>
        ) : (
          <ul className="admin-texts">
            {texts.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  // Choices and keys of older versions: frequency of each value.
  const flat = given.flatMap((v) => (Array.isArray(v) ? v : [v])).map(String);
  const labels = [...(entry.options ?? []), ...[...new Set(flat)].filter((v) => !(entry.options ?? []).includes(v)).sort()];
  const counts = labels.map((l) => ({ l, n: flat.filter((x) => x === l).length }));
  const max = Math.max(1, ...counts.map((c) => c.n));
  return (
    <div className="item-card">
      {title}
      <div className="admin-stats">
        <span>n = {given.length}</span>
        <span>fehlend {rows.length - given.length}</span>
      </div>
      <div className="bars">
        {counts.map((c) => (
          <Bar key={c.l} label={c.l} title={c.l} count={c.n} max={max} wide />
        ))}
      </div>
    </div>
  );
}

/** A download link, or a disabled button when the selection is empty. */
function DownloadLink({ href, disabled, primary, children }: { href: string; disabled: boolean; primary?: boolean; children: React.ReactNode }) {
  const cls = `btn ${primary ? 'btn-primary' : 'btn-secondary'}`;
  if (disabled) {
    return (
      <button className={cls} disabled title="Keine Antworten oder keine Felder ausgewählt">
        {children}
      </button>
    );
  }
  return (
    <a className={`${cls} admin-link`} href={href} download>
      {children}
    </a>
  );
}

function Bar({ label, title, count, max, muted, wide }: { label: string; title: string; count: number; max: number; muted?: boolean; wide?: boolean }) {
  return (
    <div className={`bar-row${wide ? ' bar-wide' : ''}`} title={title}>
      <span className="bar-label">{label}</span>
      <span className="bar-track">
        <span className={`bar-fill${muted ? ' bar-muted' : ''}`} style={{ width: `${(count / max) * 100}%` }} />
      </span>
      <span className="bar-count">{count}</span>
    </div>
  );
}
