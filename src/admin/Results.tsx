import { useEffect, useState } from 'react';
import { Inline } from '../components/RichText.tsx';
import { Shell } from '../components/Shell.tsx';
import { Courses, PrintSheet, type CodeSheet } from './Courses.tsx';
import { downloadJson, downloadXlsx } from './exportXlsx.ts';
import type { FieldInfo, FieldSummary, ResponsesResponse, SummaryResponse } from './types.ts';

const api = (surveyId: string, resource: string, course?: string) =>
  `/admin/api/results/${encodeURIComponent(surveyId)}/${resource}${course ? `?course=${encodeURIComponent(course)}` : ''}`;

const STATUS: Record<SummaryResponse['survey']['status'], string> = {
  open: 'offen',
  closed: 'beendet',
  not_yet_open: 'noch nicht geöffnet',
};

function formatDate(iso: string | null): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

function fmt(n: number | null): string {
  return n === null ? '–' : n.toLocaleString('de-DE', { maximumFractionDigits: 2 });
}

export function Results({ surveyId }: { surveyId: string }) {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [course, setCourse] = useState('');
  const [sheet, setSheet] = useState<CodeSheet | null>(null);

  const load = async (courseId = course) => {
    try {
      const res = await fetch(api(surveyId, 'summary', courseId), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as SummaryResponse);
      setError(null);
    } catch (err) {
      setError(`Auswertung konnte nicht geladen werden (${(err as Error).message}).`);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const withResponses = async (fn: (r: ResponsesResponse) => Promise<void> | void) => {
    setBusy(true);
    try {
      const res = await fetch(api(surveyId, 'responses', course), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fn((await res.json()) as ResponsesResponse);
    } catch (err) {
      setError(`Export fehlgeschlagen (${(err as Error).message}).`);
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) return <Shell title="Auswertung"><div className="panel panel-error">{error}</div></Shell>;
  if (!data) return <Shell title="Auswertung"><p className="status-text">Wird geladen …</p></Shell>;

  const { survey, definition, summary, fields } = data;
  if (sheet) {
    return <PrintSheet sheet={sheet} surveyTitle={definition.title} surveyUrl={survey.url} onClose={() => setSheet(null)} />;
  }
  const suffix = course ? `_${course}` : '';
  const courseLabel = data.courses.find((c) => c.id === course)?.label;
  const byKey = new Map(summary.map((s) => [s.key, s]));
  const fieldsBySection = new Map<string, FieldInfo[]>();
  for (const f of fields) {
    const list = fieldsBySection.get(f.sectionId) ?? [];
    list.push(f);
    fieldsBySection.set(f.sectionId, list);
  }

  return (
    <Shell brand={definition.brand ? `${definition.brand} · Auswertung` : 'Auswertung'} title={survey.title} subtitle={survey.subtitle ?? undefined}>
      <div className="admin-facts">
        <div><span className="fact-num">{data.responses}</span> Antworten</div>
        <div>Status: <strong>{STATUS[survey.status]}</strong></div>
        <div>Schluss: {formatDate(survey.closesAt)}</div>
        <div>Version {survey.version}</div>
      </div>
      {error && <div className="panel panel-error">{error}</div>}
      {data.courses.length > 0 && (
        <label className="course-filter">
          Kurs
          <select
            className="text-input"
            value={course}
            onChange={(e) => {
              setCourse(e.target.value);
              void load(e.target.value);
            }}
          >
            <option value="">Alle Kurse</option>
            {data.courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} ({c.responses})
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="admin-actions">
        <button className="btn btn-primary" disabled={busy || data.responses === 0} onClick={() => withResponses((r) => downloadXlsx(r, summary, suffix))}>
          Excel (XLSX)
        </button>
        <a className="btn btn-secondary admin-link" href={api(surveyId, 'export.csv', course)} download>
          CSV
        </a>
        <button className="btn btn-secondary" disabled={busy || data.responses === 0} onClick={() => withResponses((r) => downloadJson(r, suffix))}>
          JSON
        </button>
        <button className="btn btn-link" onClick={() => void load()}>Aktualisieren</button>
      </div>
      {courseLabel && <p className="course-line">Auswertung für: {courseLabel}</p>}
      <p className="admin-note">
        Antworten werden in zufälliger Reihenfolge gespeichert und exportiert; gespeichert ist nur der Abgabetag, keine Uhrzeit.
      </p>
      {definition.accessCodes && (
        <Courses
          surveyId={surveyId}
          surveyTitle={definition.title}
          surveyUrl={survey.url}
          courses={data.courses}
          onChanged={() => load()}
          onSheet={setSheet}
        />
      )}
      {definition.sections.map((section, i) => (
        <section key={section.id} className="admin-section">
          <h2 className="section-title">
            <span className="section-num">{i + 1}</span>
            <span>{section.title}</span>
          </h2>
          {(fieldsBySection.get(section.id) ?? []).map((f) => (
            <FieldBlock key={f.key} field={f} summary={byKey.get(f.key)} />
          ))}
        </section>
      ))}
    </Shell>
  );
}

function FieldBlock({ field, summary }: { field: FieldInfo; summary: FieldSummary | undefined }) {
  if (!summary) return null;
  const title = (
    <h3 className="item-text">
      <span className="admin-key">{field.key}</span> <Inline text={field.text} />
      {field.column && <span className="item-optional"> – {field.column}</span>}
    </h3>
  );
  if (summary.kind === 'scale') {
    const max = Math.max(1, ...summary.counts.map((c) => c.count), summary.notApplicable);
    return (
      <div className="item-card">
        {title}
        <div className="admin-stats">
          <span>n = {summary.answered - summary.notApplicable}</span>
          <span>MW {fmt(summary.mean)}</span>
          <span>Median {fmt(summary.median)}</span>
          <span>NB {summary.notApplicable}</span>
          {summary.missing > 0 && <span>fehlend {summary.missing}</span>}
        </div>
        <div className="bars">
          {summary.counts.map((c) => (
            <Bar key={c.value} label={String(c.value)} title={c.label} count={c.count} max={max} />
          ))}
          <Bar label="NB" title="nicht beurteilbar" count={summary.notApplicable} max={max} muted />
        </div>
      </div>
    );
  }
  if (summary.kind === 'choice') {
    const max = Math.max(1, ...summary.counts.map((c) => c.count));
    return (
      <div className="item-card">
        {title}
        <div className="bars">
          {summary.counts.map((c) => (
            <Bar key={c.option} label={c.option} title={c.option} count={c.count} max={max} wide />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="item-card">
      {title}
      {summary.values.length === 0 ? (
        <p className="status-text">Keine Antworten.</p>
      ) : (
        <ul className="admin-texts">
          {summary.values.map((v, i) => (
            <li key={i}>{v}</li>
          ))}
        </ul>
      )}
    </div>
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
