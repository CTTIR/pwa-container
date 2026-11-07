import { useState } from 'react';
import QRCode from 'qrcode';
import { adminFetch } from './http.ts';
import { saveBlob } from './exportXlsx.ts';
import type { CodeInfo, CourseInfo } from './types.ts';

export interface CodeSheet {
  course: { id: string; label: string };
  codes: string[];
}

interface Props {
  surveyId: string;
  surveyTitle: string;
  surveyUrl: string;
  courses: CourseInfo[];
  onChanged: () => Promise<void> | void;
  onSheet: (sheet: CodeSheet) => void;
}

const api = (surveyId: string, rest = '') => `/admin/api/results/${encodeURIComponent(surveyId)}/courses${rest}`;

/** Courses and their single-use access codes. Codes are shown once, right after they are created. */
export function Courses({ surveyId, courses, onChanged, onSheet }: Props) {
  const [label, setLabel] = useState('');
  const [count, setCount] = useState(30);
  const [more, setMore] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [codes, setCodes] = useState<CodeInfo[]>([]);

  const loadCodes = async (courseId: string) => {
    const r = await adminFetch<{ codes: CodeInfo[] }>(api(surveyId, `/${courseId}/codes`));
    setCodes(r.codes);
  };

  const run = async (fn: () => Promise<CodeSheet | void>) => {
    setBusy(true);
    setError(null);
    try {
      const sheet = await fn();
      if (sheet) onSheet(sheet);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-block courses">
      <h2 className="section-title">Kurse und Einmal-Codes</h2>
      <p className="admin-note">
        Für jeden Kurs vorab Einmal-Codes erzeugen und als QR-Zettel ausdrucken. Jeder Zettel enthält den Code im QR-Code; nach dem
        Absenden ist er verbraucht. Antworten werden nur dem Kurs zugeordnet, nie dem Code. Kurse, Codes und ihr Status liegen in der
        Datenbank: Codes lassen sich hier jederzeit anzeigen, nachdrucken, sperren oder freigeben. Zettel zufällig austeilen und nicht
        notieren, wer welchen Zettel bekommt.
      </p>
      {error && <div className="panel panel-error">{error}</div>}
      {courses.length > 0 && (
        <table className="course-table">
          <thead>
            <tr>
              <th>Kurs</th>
              <th>angelegt</th>
              <th>Codes</th>
              <th>benutzt</th>
              <th>gesperrt</th>
              <th>Antworten</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {courses.map((c) => (
              <tr key={c.id}>
                <td>{c.label}</td>
                <td>{new Date(c.createdOn).toLocaleDateString('de-DE')}</td>
                <td>{c.codes}</td>
                <td>{c.used}</td>
                <td>{c.revoked}</td>
                <td>{c.responses}</td>
                <td className="course-actions">
                  <button
                    className="btn btn-link"
                    onClick={() => {
                      if (open === c.id) return setOpen(null);
                      setOpen(c.id);
                      void loadCodes(c.id).catch((err: Error) => setError(err.message));
                    }}
                  >
                    {open === c.id ? 'Codes ausblenden' : 'Codes'}
                  </button>
                  <button
                    className="btn btn-link"
                    disabled={busy}
                    onClick={() => {
                      const next = window.prompt('Neuer Name des Kurses', c.label);
                      if (next && next.trim() && next.trim() !== c.label) {
                        void run(async () => {
                          await adminFetch(api(surveyId, `/${c.id}`), { method: 'PATCH', body: JSON.stringify({ label: next.trim() }) });
                        });
                      }
                    }}
                  >
                    Umbenennen
                  </button>
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
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        adminFetch<CodeSheet>(api(surveyId, `/${c.id}/codes`), { method: 'POST', body: JSON.stringify({ count: more[c.id] ?? 5 }) }),
                      )
                    }
                  >
                    + Codes
                  </button>
                  {c.responses === 0 && (
                    <button
                      className="btn btn-link"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Kurs „${c.label}“ mit allen ${c.codes} Codes löschen?`)) {
                          void run(async () => {
                            await adminFetch(api(surveyId, `/${c.id}`), { method: 'DELETE' });
                          });
                        }
                      }}
                    >
                      Löschen
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && (
        <CodeList
          course={courses.find((c) => c.id === open)!}
          codes={codes}
          busy={busy}
          onPrint={(list) => onSheet({ course: { id: open, label: courses.find((c) => c.id === open)?.label ?? '' }, codes: list })}
          onRevoke={(list, revoked) =>
            void run(async () => {
              await adminFetch(api(surveyId, `/${open}/revoke`), { method: 'POST', body: JSON.stringify({ codes: list, revoked }) });
              await loadCodes(open);
            })
          }
        />
      )}
      <div className="course-form">
        <label>
          Neuer Kurs
          <input className="text-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="z. B. Neuwied, November 2026" maxLength={200} />
        </label>
        <label>
          Anzahl Codes
          <input className="text-input count-input" type="number" min={1} max={1000} value={count} onChange={(e) => setCount(Number(e.target.value))} />
        </label>
        <button
          className="btn btn-primary"
          disabled={busy || !label.trim() || count < 1}
          onClick={() =>
            void run(async () => {
              const sheet = await adminFetch<CodeSheet>(api(surveyId), { method: 'POST', body: JSON.stringify({ label: label.trim(), count }) });
              setLabel('');
              return sheet;
            })
          }
        >
          Kurs anlegen und Codes erzeugen
        </button>
      </div>
    </section>
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
  codes: CodeInfo[];
  busy: boolean;
  onPrint: (codes: string[]) => void;
  onRevoke: (codes: string[], revoked: boolean) => void;
}) {
  const free = codes.filter((c) => !c.used && !c.revoked).map((c) => c.code);
  return (
    <div className="code-list">
      <div className="admin-actions">
        <strong>{course.label}</strong>
        <button className="btn btn-primary" disabled={!free.length} onClick={() => onPrint(free)}>
          Freie Codes drucken ({free.length})
        </button>
        <button
          className="btn btn-link"
          disabled={busy || !free.length}
          onClick={() => {
            if (window.confirm(`Alle ${free.length} freien Codes sperren?`)) onRevoke(free, true);
          }}
        >
          Alle freien sperren
        </button>
      </div>
      <ul className="code-grid">
        {codes.map((c) => (
          <li key={c.code} className={c.used ? 'is-used' : c.revoked ? 'is-revoked' : ''}>
            <code>{c.code}</code>
            <span className="code-state">{c.used ? 'benutzt' : c.revoked ? 'gesperrt' : 'frei'}</span>
            {!c.used && (
              <button className="btn btn-link" disabled={busy} onClick={() => onRevoke([c.code], !c.revoked)}>
                {c.revoked ? 'freigeben' : 'sperren'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Printable A4 sheet: one cut-out slip per code with its own QR link. */
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
  const base = new URL(surveyUrl, window.location.origin);
  const linkFor = (code: string) => `${base.origin}${base.pathname}#code=${code}`;

  if (!qrs) {
    void Promise.all(sheet.codes.map(async (c) => [c, await QRCode.toDataURL(linkFor(c), { errorCorrectionLevel: 'M', margin: 1, width: 360 })] as const)).then(
      (pairs) => setQrs(Object.fromEntries(pairs)),
    );
  }

  const csv = () => {
    const lines = ['course,code,link', ...sheet.codes.map((c) => [sheet.course.label, c, linkFor(c)].map((v) => `"${v.replace(/"/g, '""')}"`).join(','))];
    saveBlob('﻿' + lines.join('\r\n') + '\r\n', 'text/csv', `codes_${sheet.course.label.replace(/[^A-Za-z0-9-]+/g, '_')}.csv`);
  };

  return (
    <div className="print-sheet">
      <div className="print-toolbar no-print">
        <div>
          <strong>{sheet.codes.length} Codes</strong> für „{sheet.course.label}“: drucken oder als PDF speichern, dann zuschneiden und
          zufällig austeilen. Die Codes bleiben im Admin-Bereich abrufbar.
        </div>
        <div className="admin-actions">
          <button className="btn btn-primary" disabled={!qrs} onClick={() => window.print()}>Drucken / PDF</button>
          <button className="btn btn-secondary" onClick={csv}>Codes als CSV</button>
          <button
            className="btn btn-link"
            onClick={onClose}
          >
            Schließen
          </button>
        </div>
      </div>
      {!qrs && <p className="status-text no-print">QR-Codes werden erzeugt …</p>}
      {qrs && (
        <div className="slips">
          {sheet.codes.map((c) => (
            <div key={c} className="slip">
              <div className="slip-title">{surveyTitle}</div>
              <div className="slip-course">{sheet.course.label}</div>
              <img src={qrs[c]} alt={`QR-Code für Code ${c}`} className="slip-qr" />
              <div className="slip-help">QR-Code scannen – oder {base.host}{base.pathname === '/' ? '' : base.pathname} öffnen und Code eingeben:</div>
              <div className="slip-code">{c}</div>
              <div className="slip-note">Einmal gültig · anonym</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
