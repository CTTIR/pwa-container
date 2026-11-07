import { useEffect, useRef, useState } from 'react';
import { Inline } from '../components/RichText.tsx';
import { Shell } from '../components/Shell.tsx';
import { Courses, PrintSheet, type CodeSheet } from './Courses.tsx';
import { downloadJson, downloadSummaryXlsx, downloadXlsx } from './exportXlsx.ts';
import { eventLine } from './format.ts';
import { adminFetch } from './http.ts';
import { confirmSurveyStatus, MIN_GROUP, setSurveyClosed } from './surveyStatus.ts';
import type { CourseInfo, FieldInfo, FieldSummary, ResponsesResponse, SummaryResponse } from './types.ts';

const api = (surveyId: string, resource: string, course?: string) =>
  `/admin/api/results/${encodeURIComponent(surveyId)}/${resource}${course ? `?course=${encodeURIComponent(course)}` : ''}`;

const STATUS: Record<SummaryResponse['survey']['status'], string> = {
  open: 'offen',
  closed: 'geschlossen',
  not_yet_open: 'noch nicht geöffnet',
};

function formatDate(iso: string | null | undefined): string | null {
  return iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : null;
}

function fmt(n: number | null): string {
  return n === null ? '–' : n.toLocaleString('de-DE', { maximumFractionDigits: 2 });
}

export function Results({ surveyId }: { surveyId: string }) {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [courses, setCourses] = useState<CourseInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [course, setCourse] = useState('');
  const [sheet, setSheet] = useState<CodeSheet | null>(null);
  const courseRef = useRef('');
  const loadSeq = useRef(0);

  /** Summary of the chosen view plus the full course list; an unreleased course falls back to all released ones. */
  const load = async (courseId = courseRef.current): Promise<void> => {
    const seq = ++loadSeq.current;
    try {
      const [summary, list] = await Promise.all([
        adminFetch<SummaryResponse>(api(surveyId, 'summary', courseId)),
        adminFetch<{ courses: CourseInfo[] }>(api(surveyId, 'courses')).catch(() => null),
      ]);
      if (seq !== loadSeq.current) return;
      const all = list?.courses ?? summary.courses;
      if (courseId && !all.some((c) => c.id === courseId && c.released)) {
        courseRef.current = '';
        setCourse('');
        return load('');
      }
      setData(summary);
      setCourses(all);
      setError(null);
    } catch (err) {
      if (seq === loadSeq.current) setError(`Auswertung konnte nicht geladen werden (${(err as Error).message}).`);
    }
  };

  useEffect(() => {
    void load();
  }, [surveyId]);

  const chooseCourse = (id: string) => {
    courseRef.current = id;
    setCourse(id);
    void load(id);
  };

  const withResponses = async (fn: (r: ResponsesResponse) => Promise<void> | void) => {
    setBusy(true);
    try {
      await fn(await adminFetch<ResponsesResponse>(api(surveyId, 'responses', course)));
    } catch (err) {
      setError(`Export fehlgeschlagen (${(err as Error).message}).`);
    } finally {
      setBusy(false);
    }
  };

  const toggleSurvey = async () => {
    if (!data) return;
    const close = data.survey.status !== 'closed';
    const withCodes = !!data.definition.accessCodes;
    // Without codes the survey is released (and closing final) from minGroup responses on.
    const final = !withCodes && data.released;
    if (!confirmSurveyStatus(data.survey.title, close, withCodes, final, data.minGroup ?? MIN_GROUP)) return;
    setBusy(true);
    setMessage(null);
    let failure: string | null = null;
    try {
      const r = await setSurveyClosed(surveyId, close);
      const n = r.coursesClosed ?? 0;
      setMessage(
        close
          ? `Umfrage geschlossen: Es werden keine Antworten mehr angenommen${n ? `; ${n} ${n === 1 ? 'Kurs' : 'Kurse'} abgeschlossen, alle QR-Codes abgelaufen` : ''}.`
          : `Umfrage wieder geöffnet.${data.definition.accessCodes ? ' Abgeschlossene Kurse bleiben abgeschlossen, bis sie einzeln wieder geöffnet werden.' : ''}`,
      );
    } catch (err) {
      failure = `Status konnte nicht geändert werden: ${(err as Error).message}`;
    }
    await load();
    // Set after reloading, so a failed action stays visible.
    if (failure) setError(failure);
    setBusy(false);
  };

  if (error && !data) {
    return (
      <Shell title="Auswertung">
        <div className="panel panel-error">{error}</div>
      </Shell>
    );
  }
  if (!data) {
    return (
      <Shell title="Auswertung">
        <p className="status-text">Wird geladen …</p>
      </Shell>
    );
  }

  const { survey, definition, summary, fields } = data;
  if (sheet) {
    return <PrintSheet sheet={sheet} surveyTitle={definition.title} surveyUrl={survey.url} onClose={() => setSheet(null)} />;
  }
  const k = data.minGroup ?? MIN_GROUP;
  const withCodes = !!definition.accessCodes;
  const released = courses.filter((c) => c.released);
  const openCourses = courses.filter((c) => !c.closed).length;
  const smallCourses = courses.filter((c) => c.closed && !c.released && (c.responses ?? 0) < k).length;
  // Single rows per response are only for the global administration; organisers get summaries.
  const isGlobal = data.role === 'global';
  const shown = data.released && data.responses > 0;
  const canExport = shown && !busy;
  const suffix = course ? `_${course}` : '';
  const current = courses.find((c) => c.id === course);
  const byKey = new Map(summary.map((s) => [s.key, s]));
  const ratingFields = new Map<string, FieldInfo[]>();
  const textFields: FieldInfo[] = [];
  for (const f of fields) {
    if (f.type === 'text') {
      textFields.push(f);
      continue;
    }
    const list = ratingFields.get(f.sectionId) ?? [];
    list.push(f);
    ratingFields.set(f.sectionId, list);
  }
  const closed = survey.status === 'closed';
  const final = closed && !withCodes && data.released;
  const closesAt = formatDate(survey.closesAt);

  return (
    <Shell brand={definition.brand ? `${definition.brand} · Auswertung` : 'Auswertung'} title={survey.title} subtitle={survey.subtitle ?? undefined}>
      <div className="admin-facts">
        <div>
          <span className="fact-num">{shown ? data.responses : '–'}</span> {course ? 'Antworten in diesem Kurs' : 'freigegebene Antworten'}
        </div>
        <div>
          Umfrage: <strong>{STATUS[survey.status]}</strong>
        </div>
        {withCodes && (
          <div>
            Kurse freigegeben: {released.length} von {courses.length}
          </div>
        )}
        {closesAt && !closed && <div>Schluss laut Zeitplan: {closesAt}</div>}
        <div>Version {survey.version}</div>
      </div>

      <div className="survey-status-row">
        {!final && (
          <button className={closed ? 'btn btn-secondary' : 'btn btn-danger'} disabled={busy} onClick={() => void toggleSurvey()}>
            {closed ? 'Umfrage wieder öffnen' : 'Umfrage schließen'}
          </button>
        )}
        <span className="survey-status-hint">
          {final
            ? `Die Umfrage ist endgültig geschlossen: Sie hat mindestens ${k} Antworten, die Ergebnisse sind freigegeben.`
            : closed
              ? 'Die Umfrage nimmt keine Antworten an.'
              : withCodes
                ? 'Schließen beendet die Umfrage: keine weiteren Antworten, alle Kurse abgeschlossen, alle QR-Codes abgelaufen.'
                : `Schließen beendet die Umfrage: keine weiteren Antworten${data.released ? ' – endgültig, da schon mindestens ' + k + ' Antworten vorliegen' : ''}.`}
        </span>
      </div>

      {message && (
        <div className="panel panel-done" role="status">
          {message}
        </div>
      )}
      {error && (
        <div className="panel panel-error" role="alert">
          {error}
        </div>
      )}

      <div className={`panel ${shown ? 'privacy-panel' : 'panel-warn'}`}>
        <strong className="panel-title">
          {shown ? 'Schutz der Anonymität' : course ? 'Für diesen Kurs sind keine Ergebnisse freigegeben' : 'Noch keine Ergebnisse freigegeben'}
        </strong>
        <p>
          Ergebnisse werden nur für abgeschlossene Gruppen mit mindestens {k} Antworten gezeigt.
          {withCodes
            ? ` Ein Kurs wird erst freigegeben, wenn er abgeschlossen ist („Kurs abschließen“ oder „Umfrage schließen“) und mindestens ${k} Antworten hat. Die Freigabe ist endgültig: Ein freigegebener Kurs kann nicht wieder geöffnet werden.`
            : ` So lässt sich keine Antwort einer einzelnen Person zuordnen. Ab ${k} Antworten ist das Schließen der Umfrage endgültig.`}{' '}
          Antworten tragen weder Datum noch Uhrzeit; Freitexte stehen getrennt von den Bewertungen und in zufälliger Reihenfolge.
          {!isGlobal && ' Die Kursleitung erhält Zusammenfassungen und Freitexte; einzelne Antwortzeilen kann nur die Gesamtverwaltung herunterladen.'}
        </p>
        {!shown && withCodes && courses.length > 0 && (
          <p>
            {openCourses > 0 && `${openCourses} ${openCourses === 1 ? 'Kurs ist' : 'Kurse sind'} noch offen. `}
            {smallCourses > 0 && `${smallCourses} abgeschlossene${smallCourses === 1 ? 'r Kurs hat' : ' Kurse haben'} weniger als ${k} Antworten.`}
          </p>
        )}
        {!shown && withCodes && courses.length === 0 && <p>Es sind noch keine Kurse angelegt.</p>}
      </div>

      {withCodes && released.length > 0 && (
        <label className="course-filter">
          Kurs
          <select className="text-input" value={course} onChange={(e) => chooseCourse(e.target.value)}>
            <option value="">Alle freigegebenen Kurse ({released.length})</option>
            {released.map((c) => (
              <option key={c.id} value={c.id}>
                {eventLine(c)} ({c.responses})
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="admin-actions">
        {isGlobal ? (
          <button className="btn btn-primary" disabled={!canExport} onClick={() => void withResponses((r) => downloadXlsx(r, summary, suffix))}>
            Excel (Bewertungen + Freitexte)
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={!canExport}
            onClick={() => void downloadSummaryXlsx(definition.id + suffix, fields, summary).catch((err: Error) => setError(err.message))}
          >
            Excel (Zusammenfassung + Freitexte)
          </button>
        )}
        {isGlobal &&
          (canExport ? (
            <a className="btn btn-secondary admin-link" href={api(surveyId, 'export.csv', course)} download>
              CSV Bewertungen
            </a>
          ) : (
            <button className="btn btn-secondary" disabled>
              CSV Bewertungen
            </button>
          ))}
        {textFields.length > 0 &&
          (canExport ? (
            <a className="btn btn-secondary admin-link" href={api(surveyId, 'texts.csv', course)} download>
              CSV Freitexte
            </a>
          ) : (
            <button className="btn btn-secondary" disabled>
              CSV Freitexte
            </button>
          ))}
        {isGlobal && (
          <button className="btn btn-secondary" disabled={!canExport} onClick={() => void withResponses((r) => downloadJson(r, suffix))}>
            JSON
          </button>
        )}
        <button className="btn btn-link" disabled={busy} onClick={() => void load()}>
          Aktualisieren
        </button>
      </div>
      {shown && <p className="course-line">Auswertung für: {current ? eventLine(current) : withCodes ? 'alle freigegebenen Kurse' : 'alle Antworten'}</p>}

      {withCodes && <Courses
          surveyId={surveyId}
          courses={courses}
          minGroup={k}
          canDeleteAnswers={data.role === 'global'}
          onChanged={() => load()}
          onSheet={setSheet}
        />}

      {shown && (
        <>
          {definition.sections.map((section, i) => {
            const list = ratingFields.get(section.id) ?? [];
            if (list.length === 0) return null;
            return (
              <section key={section.id} className="admin-section">
                <h2 className="section-title">
                  <span className="section-num">{i + 1}</span>
                  <span>{section.title}</span>
                </h2>
                {list.map((f) => (
                  <FieldBlock key={f.key} field={f} summary={byKey.get(f.key)} />
                ))}
              </section>
            );
          })}
          {textFields.length > 0 && (
            <section className="admin-section admin-free-texts">
              <h2 className="section-title">
                <span>Freitexte</span>
              </h2>
              <p className="admin-note">
                Getrennt von den Bewertungen und je Frage zufällig gemischt, damit sich kein Freitext einer Bewertung oder Person zuordnen
                lässt.
              </p>
              {textFields.map((f) => (
                <TextBlock key={f.key} field={f} summary={byKey.get(f.key)} />
              ))}
            </section>
          )}
        </>
      )}
    </Shell>
  );
}

function FieldTitle({ field }: { field: FieldInfo }) {
  return (
    <h3 className="item-text">
      <span className="admin-key">{field.key}</span> <Inline text={field.text} />
      {field.column && <span className="item-optional"> – {field.column}</span>}
    </h3>
  );
}

function FieldBlock({ field, summary }: { field: FieldInfo; summary: FieldSummary | undefined }) {
  if (!summary) return null;
  if (summary.kind === 'scale') {
    const max = Math.max(1, ...summary.counts.map((c) => c.count), summary.notApplicable);
    return (
      <div className="item-card">
        <FieldTitle field={field} />
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
        <FieldTitle field={field} />
        <div className="bars">
          {summary.counts.map((c) => (
            <Bar key={c.option} label={c.option} title={c.option} count={c.count} max={max} wide />
          ))}
        </div>
      </div>
    );
  }
  return null;
}

/** Free texts of one question, in the (shuffled) order the server sent them. */
function TextBlock({ field, summary }: { field: FieldInfo; summary: FieldSummary | undefined }) {
  const values = summary?.kind === 'text' ? summary.values : [];
  return (
    <div className="item-card">
      <h3 className="item-text">
        <span className="admin-key">{field.key}</span> <span className="item-optional">{field.sectionTitle} · </span>
        <Inline text={field.text} />
        {field.column && <span className="item-optional"> – {field.column}</span>}
      </h3>
      {values.length === 0 ? (
        <p className="status-text">Keine Freitexte.</p>
      ) : (
        <ul className="admin-texts">
          {values.map((v, i) => (
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
