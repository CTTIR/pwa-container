import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { adminFetch } from './http.ts';
import { saveBlob } from './exportXlsx.ts';
import { eventLine, formatEventDate, isIsoDate } from './format.ts';
import type { CodeInfo, CourseInfo, CreatedCodes } from './types.ts';

/** The codes for one print run, with the event they belong to. */
export type CodeSheet = CreatedCodes;

interface Props {
  surveyId: string;
  courses: CourseInfo[];
  /** Smallest group whose results are shown (k = 5). */
  minGroup: number;
  onChanged: () => Promise<void> | void;
  onSheet: (sheet: CodeSheet) => void;
}

const api = (surveyId: string, rest = '') => `/admin/api/results/${encodeURIComponent(surveyId)}/courses${rest}`;
const courseApi = (surveyId: string, courseId: string, rest = '') => api(surveyId, `/${encodeURIComponent(courseId)}${rest}`);

interface EventDraft {
  label: string;
  eventDate: string;
  eventDateEnd: string;
}

const EMPTY_DRAFT: EventDraft = { label: '', eventDate: '', eventDateEnd: '' };

function draftProblem(d: EventDraft): string | null {
  if (!d.label.trim()) return 'Bitte den Namen der Veranstaltung eingeben.';
  if (!isIsoDate(d.eventDate)) return 'Bitte das Datum der Veranstaltung eingeben.';
  if (d.eventDateEnd && !isIsoDate(d.eventDateEnd)) return 'Das Enddatum ist ungültig.';
  if (d.eventDateEnd && d.eventDateEnd < d.eventDate) return 'Das Enddatum liegt vor dem ersten Tag.';
  return null;
}

/** End date only for real multi-day events. */
const endOf = (d: EventDraft): string | null => (d.eventDateEnd && d.eventDateEnd !== d.eventDate ? d.eventDateEnd : null);

const validCount = (n: number) => Number.isInteger(n) && n >= 1 && n <= 1000;

function releaseText(c: CourseInfo, minGroup: number): string {
  if (c.released) return 'ja';
  if (!c.closed) return 'nein – noch offen';
  if (c.responses < minGroup) return `nein – erst ab ${minGroup} Antworten`;
  return 'nein';
}

type CodesState = CodeInfo[] | 'loading' | 'error';

/** Courses (events) and their single-use access codes. */
export function Courses({ surveyId, courses, minGroup, onChanged, onSheet }: Props) {
  const [draft, setDraft] = useState<EventDraft>(EMPTY_DRAFT);
  const [count, setCount] = useState(30);
  const [more, setMore] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [codes, setCodes] = useState<CodesState>('loading');
  const [editing, setEditing] = useState<(EventDraft & { id: string }) | null>(null);
  const [purge, setPurge] = useState<{ id: string; text: string } | null>(null);
  const codeRequest = useRef(0);

  /** Loads the codes of one course; answers for a course that is no longer shown are dropped. */
  const loadCodes = useCallback(
    async (courseId: string) => {
      const seq = ++codeRequest.current;
      setCodes('loading');
      try {
        const r = await adminFetch<{ codes: CodeInfo[] }>(courseApi(surveyId, courseId, '/codes'));
        if (seq === codeRequest.current) setCodes(r.codes);
      } catch (err) {
        if (seq !== codeRequest.current) return;
        setCodes('error');
        setError(`Codes konnten nicht geladen werden: ${(err as Error).message}`);
      }
    },
    [surveyId],
  );

  const showCodes = (courseId: string | null) => {
    codeRequest.current += 1;
    setCodes('loading');
    setOpen(courseId);
    if (courseId) void loadCodes(courseId);
  };

  // A course that disappeared (deleted here or elsewhere) closes its open panels.
  useEffect(() => {
    const ids = new Set(courses.map((c) => c.id));
    if (open && !ids.has(open)) {
      codeRequest.current += 1;
      setOpen(null);
      setCodes('loading');
    }
    if (editing && !ids.has(editing.id)) setEditing(null);
    if (purge && !ids.has(purge.id)) setPurge(null);
  }, [courses]);

  const run = async (fn: () => Promise<CodeSheet | void>, failure: string) => {
    setBusy(true);
    setError(null);
    let sheet: CodeSheet | void = undefined;
    try {
      sheet = await fn();
    } catch (err) {
      setError(`${failure}: ${(err as Error).message}`);
    }
    try {
      await onChanged();
    } catch (err) {
      setError(`Liste konnte nicht aktualisiert werden: ${(err as Error).message}`);
    }
    setBusy(false);
    if (sheet) onSheet(sheet);
  };

  const create = () =>
    run(async () => {
      const end = endOf(draft);
      const body = { label: draft.label.trim(), eventDate: draft.eventDate, ...(end ? { eventDateEnd: end } : {}), count };
      const sheet = await adminFetch<CreatedCodes>(api(surveyId), { method: 'POST', body: JSON.stringify(body) });
      setDraft(EMPTY_DRAFT);
      return sheet;
    }, 'Kurs konnte nicht angelegt werden');

  const saveEdit = () => {
    if (!editing) return;
    const { id } = editing;
    void run(async () => {
      await adminFetch(courseApi(surveyId, id), {
        method: 'PATCH',
        body: JSON.stringify({ label: editing.label.trim(), eventDate: editing.eventDate, eventDateEnd: endOf(editing) }),
      });
      setEditing(null);
    }, 'Änderung nicht gespeichert');
  };

  const setClosed = (c: CourseInfo, closed: boolean) => {
    const text = closed
      ? `Kurs „${eventLine(c)}“ abschließen?\n\n` +
        'Ein abgeschlossener Kurs nimmt keine Antworten mehr an; alle seine QR-Codes sind damit abgelaufen.\n\n' +
        (c.responses >= minGroup
          ? `Der Kurs hat ${c.responses} Antworten (mindestens ${minGroup}): Das Abschließen ist ENDGÜLTIG. ` +
            'Die Ergebnisse werden sofort freigegeben, und der Kurs kann nicht wieder geöffnet werden.'
          : `Der Kurs hat ${c.responses} Antworten (weniger als ${minGroup}): Er kann noch wieder geöffnet werden, ` +
            `Ergebnisse werden nicht gezeigt. Hat ein abgeschlossener Kurs ${minGroup} oder mehr Antworten, ist das Abschließen endgültig ` +
            '(Ergebnisse freigegeben, kein Wiederöffnen).')
      : `Kurs „${eventLine(c)}“ wieder öffnen?\n\n` +
        'Nicht gesperrte, noch unbenutzte Codes gelten dann wieder (Antworten nur, solange auch die Umfrage offen ist). ' +
        `Sobald der Kurs erneut abgeschlossen wird und dann mindestens ${minGroup} Antworten hat, ist das endgültig.`;
    if (!window.confirm(text)) return;
    void run(async () => {
      await adminFetch(courseApi(surveyId, c.id), { method: 'PATCH', body: JSON.stringify({ closed }) });
      if (open === c.id) void loadCodes(c.id);
    }, closed ? 'Kurs konnte nicht abgeschlossen werden' : 'Kurs konnte nicht wieder geöffnet werden');
  };

  const remove = (c: CourseInfo) => {
    if (!window.confirm(`Kurs „${eventLine(c)}“ mit allen ${c.codes} Codes löschen?\n\nGedruckte Zettel dieses Kurses funktionieren danach nicht mehr.`)) return;
    void run(async () => {
      await adminFetch(courseApi(surveyId, c.id), { method: 'DELETE' });
    }, 'Kurs konnte nicht gelöscht werden');
  };

  const removeWithResponses = (c: CourseInfo) =>
    void run(async () => {
      await adminFetch(courseApi(surveyId, c.id, `?withResponses=1&confirm=${encodeURIComponent(c.label)}`), { method: 'DELETE' });
      setPurge(null);
    }, 'Kurs konnte nicht gelöscht werden');

  const problem = draftProblem(draft);
  const touched = draft.label !== '' || draft.eventDate !== '' || draft.eventDateEnd !== '';

  return (
    <section className="admin-block courses">
      <h2 className="section-title">Kurse und Einmal-Codes</h2>
      <p className="admin-note">
        Für jede Veranstaltung einen Kurs mit Namen und Datum anlegen, Einmal-Codes erzeugen und als QR-Zettel ausdrucken; Name und
        Datum stehen auf jedem Zettel. Nach dem Absenden ist ein Code verbraucht. Antworten werden nur dem Kurs zugeordnet, nie dem
        Code; ob ein bestimmter Code benutzt wurde, zeigt die Verwaltung bewusst nicht an. Zettel zufällig austeilen und nicht
        notieren, wer welchen Zettel bekommt. Nach der Veranstaltung „Kurs abschließen“: Danach nimmt der Kurs keine Antworten mehr
        an und alle seine Codes sind abgelaufen. Hat er mindestens {minGroup} Antworten, werden seine Ergebnisse freigegeben – dann ist
        das Abschließen endgültig, der Kurs kann nicht wieder geöffnet werden.
      </p>
      {error && (
        <div className="panel panel-error" role="alert">
          {error}
        </div>
      )}
      {courses.length === 0 && <p className="status-text">Noch keine Kurse angelegt.</p>}
      {courses.length > 0 && (
        <ul className="course-list">
          {courses.map((c) => (
            <li key={c.id} className={`course-card${c.closed ? ' is-closed' : ''}`}>
              <div className="course-head">
                <div>
                  <div className="course-name">{c.label}</div>
                  <div className="course-date">{formatEventDate(c.eventDate, c.eventDateEnd)}</div>
                </div>
                <span className={`badge${c.closed ? ' badge-quiet' : ''}`}>{c.closed ? 'abgeschlossen' : 'offen'}</span>
              </div>
              <dl className="course-facts">
                <div>
                  <dt>Codes</dt>
                  <dd>{c.codes}</dd>
                </div>
                <div>
                  <dt>benutzt</dt>
                  <dd>{c.used}</dd>
                </div>
                <div>
                  <dt>gesperrt</dt>
                  <dd>{c.revoked}</dd>
                </div>
                <div>
                  <dt>Antworten</dt>
                  <dd>{c.responses}</dd>
                </div>
                <div>
                  <dt>Ergebnisse freigegeben</dt>
                  <dd className={c.released ? 'is-released' : ''}>{releaseText(c, minGroup)}</dd>
                </div>
              </dl>
              <div className="course-actions">
                <button className="btn btn-link" onClick={() => showCodes(open === c.id ? null : c.id)}>
                  {open === c.id ? 'Codes ausblenden' : 'Codes anzeigen'}
                </button>
                <button
                  className="btn btn-link"
                  disabled={busy}
                  onClick={() =>
                    setEditing(editing?.id === c.id ? null : { id: c.id, label: c.label, eventDate: c.eventDate, eventDateEnd: c.eventDateEnd ?? '' })
                  }
                >
                  Bearbeiten
                </button>
                {!c.closed && (
                  <span className="more-codes">
                    <input
                      className="text-input count-input"
                      type="number"
                      min={1}
                      max={1000}
                      value={more[c.id] ?? 5}
                      aria-label={`Anzahl weiterer Codes für ${c.label}`}
                      onChange={(e) => setMore({ ...more, [c.id]: Number(e.target.value) })}
                    />
                    <button
                      className="btn btn-secondary"
                      disabled={busy || !validCount(more[c.id] ?? 5)}
                      onClick={() =>
                        void run(
                          () =>
                            adminFetch<CreatedCodes>(courseApi(surveyId, c.id, '/codes'), {
                              method: 'POST',
                              body: JSON.stringify({ count: more[c.id] ?? 5 }),
                            }),
                          'Codes konnten nicht erzeugt werden',
                        )
                      }
                    >
                      + Codes
                    </button>
                  </span>
                )}
                {c.closed ? (
                  c.released ? (
                    <span className="course-final" title="Ergebnisse freigegeben – der Kurs kann nicht wieder geöffnet werden.">
                      endgültig abgeschlossen
                    </span>
                  ) : (
                    <button className="btn btn-secondary" disabled={busy} onClick={() => setClosed(c, false)}>
                      Wieder öffnen
                    </button>
                  )
                ) : (
                  <button className="btn btn-primary" disabled={busy} onClick={() => setClosed(c, true)}>
                    Kurs abschließen
                  </button>
                )}
                {c.responses === 0 ? (
                  <button className="btn btn-link" disabled={busy} onClick={() => remove(c)}>
                    Löschen
                  </button>
                ) : (
                  <button
                    className="btn btn-link link-danger"
                    disabled={busy}
                    onClick={() => setPurge(purge?.id === c.id ? null : { id: c.id, text: '' })}
                  >
                    Kurs mit allen Antworten löschen …
                  </button>
                )}
              </div>

              {editing?.id === c.id && (
                <div className="course-panel">
                  <EventFields draft={editing} onChange={(d) => setEditing({ ...editing, ...d })} />
                  {draftProblem(editing) && <p className="status-text">{draftProblem(editing)}</p>}
                  <p className="admin-note">Bereits gedruckte Zettel behalten den alten Text; die Codes darauf bleiben gültig.</p>
                  <div className="admin-actions">
                    <button className="btn btn-primary" disabled={busy || !!draftProblem(editing)} onClick={saveEdit}>
                      Speichern
                    </button>
                    <button className="btn btn-link" onClick={() => setEditing(null)}>
                      Abbrechen
                    </button>
                  </div>
                </div>
              )}

              {purge?.id === c.id && (
                <div className="course-panel danger-zone">
                  <div className="danger-row">
                    <label>
                      Löscht den Kurs, alle seine Codes und alle {c.responses} Antworten dieses Kurses endgültig. Zur Bestätigung den
                      Namen der Veranstaltung genau so eingeben: <code>{c.label}</code>
                      <input
                        className="text-input"
                        value={purge.text}
                        onChange={(e) => setPurge({ id: c.id, text: e.target.value })}
                        aria-label="Name der Veranstaltung zur Bestätigung"
                      />
                    </label>
                    <button className="btn btn-danger" disabled={busy || purge.text !== c.label} onClick={() => removeWithResponses(c)}>
                      Kurs mit allen Antworten löschen
                    </button>
                    <button className="btn btn-link" onClick={() => setPurge(null)}>
                      Abbrechen
                    </button>
                  </div>
                </div>
              )}

              {open === c.id && (
                <CodeList
                  course={c}
                  codes={codes}
                  busy={busy}
                  onPrint={(list) =>
                    onSheet({ course: { id: c.id, label: c.label, eventDate: c.eventDate, eventDateEnd: c.eventDateEnd }, codes: list })
                  }
                  onRevoke={(list, revoked) =>
                    void run(async () => {
                      await adminFetch(courseApi(surveyId, c.id, '/revoke'), { method: 'POST', body: JSON.stringify({ codes: list, revoked }) });
                      await loadCodes(c.id);
                    }, revoked ? 'Codes konnten nicht gesperrt werden' : 'Codes konnten nicht freigegeben werden')
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="course-form-title">Neuer Kurs</h3>
      <div className="course-form">
        <EventFields draft={draft} onChange={(d) => setDraft({ ...draft, ...d })} />
        <label>
          Anzahl Codes
          <input
            className="text-input count-input"
            type="number"
            min={1}
            max={1000}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          />
        </label>
        <button className="btn btn-primary" disabled={busy || !!problem || !validCount(count)} onClick={() => void create()}>
          Kurs anlegen und Codes erzeugen
        </button>
      </div>
      {touched && problem && <p className="status-text">{problem}</p>}
      {!problem && <p className="admin-note">Auf jedem Zettel: {eventLine({ label: draft.label.trim(), eventDate: draft.eventDate, eventDateEnd: endOf(draft) })}</p>}
    </section>
  );
}

/** Name of the event, its (first) day and an optional last day. */
function EventFields({ draft, onChange }: { draft: EventDraft; onChange: (d: Partial<EventDraft>) => void }) {
  return (
    <>
      <label className="course-form-name">
        Veranstaltung
        <input
          className="text-input"
          value={draft.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="z. B. TDSC®-Instruktorenkurs Neuwied"
          maxLength={200}
          required
        />
      </label>
      <label>
        Datum
        <input className="text-input" type="date" value={draft.eventDate} onChange={(e) => onChange({ eventDate: e.target.value })} required />
      </label>
      <label>
        bis (optional)
        <input
          className="text-input"
          type="date"
          value={draft.eventDateEnd}
          min={draft.eventDate || undefined}
          onChange={(e) => onChange({ eventDateEnd: e.target.value })}
        />
      </label>
    </>
  );
}

function CodeList({
  course,
  codes,
  busy,
  onPrint,
  onRevoke,
}: {
  course: CourseInfo;
  codes: CodesState;
  busy: boolean;
  onPrint: (codes: string[]) => void;
  onRevoke: (codes: string[], revoked: boolean) => void;
}) {
  if (codes === 'loading') return <p className="status-text code-list">Codes werden geladen …</p>;
  if (codes === 'error') return <p className="status-text code-list">Codes konnten nicht geladen werden.</p>;
  const active = codes.filter((c) => !c.revoked).map((c) => c.code);
  return (
    <div className="code-list">
      <p className="admin-note">
        Ob ein Code schon benutzt wurde, wird bewusst nicht angezeigt – sonst ließe sich eine Antwort ihrem Zettel zuordnen. Ein schon
        benutzter Code wird beim erneuten Scannen abgewiesen.
        {course.closed ? ' Der Kurs ist abgeschlossen: Alle seine Codes sind abgelaufen.' : ''}
      </p>
      <div className="admin-actions">
        <button className="btn btn-primary" disabled={!active.length || course.closed} onClick={() => onPrint(active)}>
          Codes drucken ({active.length})
        </button>
        <button
          className="btn btn-link"
          disabled={busy || !active.length}
          onClick={() => {
            if (window.confirm(`Alle ${active.length} nicht gesperrten Codes von „${eventLine(course)}“ sperren?`)) onRevoke(active, true);
          }}
        >
          Alle sperren
        </button>
      </div>
      {codes.length === 0 ? (
        <p className="status-text">Keine Codes.</p>
      ) : (
        <ul className="code-grid">
          {codes.map((c) => (
            <li key={c.code} className={c.revoked ? 'is-revoked' : ''}>
              <code>{c.code}</code>
              {c.revoked && <span className="code-state">gesperrt</span>}
              <button className="btn btn-link" disabled={busy} onClick={() => onRevoke([c.code], !c.revoked)}>
                {c.revoked ? 'freigeben' : 'sperren'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Printable A4 sheet: one cut-out slip per code with its own QR link, the survey and the event. */
export function PrintSheet({
  sheet,
  surveyTitle,
  surveyUrl,
  onClose,
}: {
  sheet: CodeSheet;
  surveyTitle: string;
  surveyUrl: string;
  onClose: () => void;
}) {
  const [qrs, setQrs] = useState<Record<string, string> | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const base = useMemo(() => {
    try {
      return new URL(surveyUrl, window.location.origin);
    } catch {
      return new URL(window.location.origin);
    }
  }, [surveyUrl]);
  const linkFor = useCallback((code: string) => `${base.origin}${base.pathname}#code=${code}`, [base]);
  const event = eventLine(sheet.course);

  useEffect(() => {
    let cancelled = false;
    setQrs(null);
    setQrError(null);
    Promise.all(
      sheet.codes.map(async (c) => [c, await QRCode.toDataURL(linkFor(c), { errorCorrectionLevel: 'M', margin: 1, width: 360 })] as const),
    ).then(
      (pairs) => {
        if (!cancelled) setQrs(Object.fromEntries(pairs));
      },
      (err: unknown) => {
        if (!cancelled) setQrError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sheet, linkFor]);

  const csv = () => {
    const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const { label, eventDate, eventDateEnd } = sheet.course;
    const lines = [
      'event,event_date,event_date_end,code,link',
      ...sheet.codes.map((c) => [label, eventDate, eventDateEnd ?? '', c, linkFor(c)].map(q).join(',')),
    ];
    const name = `${label}_${eventDate}`.replace(/[^A-Za-z0-9-]+/g, '_');
    saveBlob('﻿' + lines.join('\r\n') + '\r\n', 'text/csv', `codes_${name}.csv`);
  };

  return (
    <div className="print-sheet">
      <div className="print-toolbar no-print">
        <div>
          <strong>{sheet.codes.length} Codes</strong> für „{event}“: drucken oder als PDF speichern, dann zuschneiden und zufällig
          austeilen; nicht notieren, wer welchen Zettel bekommt. Die Codes bleiben im Admin-Bereich abrufbar.
        </div>
        <div className="admin-actions">
          <button className="btn btn-primary" disabled={!qrs} onClick={() => window.print()}>
            Drucken / PDF
          </button>
          <button className="btn btn-secondary" onClick={csv}>
            Codes als CSV
          </button>
          <button className="btn btn-link" onClick={onClose}>
            Schließen
          </button>
        </div>
      </div>
      {qrError && (
        <div className="panel panel-error no-print" role="alert">
          QR-Codes konnten nicht erzeugt werden ({qrError}). Die Codes lassen sich als CSV speichern.
        </div>
      )}
      {!qrs && !qrError && <p className="status-text no-print">QR-Codes werden erzeugt …</p>}
      {qrs && (
        <div className="slips">
          {sheet.codes.map((c) => (
            <div key={c} className="slip">
              <div className="slip-title">{surveyTitle}</div>
              <div className="slip-course">{event}</div>
              <img src={qrs[c]} alt={`QR-Code für Code ${c}`} className="slip-qr" />
              <div className="slip-help">
                QR-Code scannen – oder {base.host}
                {base.pathname === '/' ? '' : base.pathname} öffnen und Code eingeben:
              </div>
              <div className="slip-code">{c}</div>
              <div className="slip-note">Einmal gültig · anonym</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
