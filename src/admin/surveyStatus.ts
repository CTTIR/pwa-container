import { adminFetch } from './http.ts';
import type { SurveyStatus } from './types.ts';

/** Smallest group whose results are shown; also the point from which closing is final. */
export const MIN_GROUP = 5;

/**
 * Closes or reopens a whole survey. Closing also closes all its courses, so every QR code expires;
 * reopening leaves the courses closed until they are reopened one by one. A survey without access
 * codes that is closed with at least MIN_GROUP responses cannot be reopened (409 released_cannot_reopen).
 */
export function setSurveyClosed(surveyId: string, closed: boolean): Promise<{ status: SurveyStatus; coursesClosed: number }> {
  return adminFetch(`/admin/api/results/${encodeURIComponent(surveyId)}/status`, { method: 'POST', body: JSON.stringify({ closed }) });
}

/**
 * True when a closed survey can no longer be reopened: without access codes, results are released
 * from MIN_GROUP responses on, and releasing is one-way. Surveys with codes can always be reopened.
 */
export function reopenBlocked(withCourses: boolean, responses: number, minGroup = MIN_GROUP): boolean {
  return !withCourses && responses >= minGroup;
}

/** Asks before closing or reopening; the text says what happens to answers, courses and QR codes. */
export function confirmSurveyStatus(title: string, close: boolean, withCourses: boolean, final: boolean, minGroup = MIN_GROUP, live = false): boolean {
  const text = close
    ? `Umfrage „${title}“ schließen?\n\n` +
      'Danach werden keine Antworten mehr angenommen – auch keine, die noch auf Handys ohne Netz warten. ' +
      'Am besten erst schließen, wenn alle die Danke-Seite gesehen haben, oder am nächsten Tag.' +
      (live
        ? (withCourses ? ' Alle Kurse werden abgeschlossen; sämtliche Einmal-Codes sind damit abgelaufen.' : '') +
          ' Live-Ansicht: Das Schließen ist nicht endgültig, die Umfrage kann wieder geöffnet werden.'
        : withCourses
        ? ' Alle Kurse werden abgeschlossen; sämtliche QR-Codes und Einmal-Codes sind damit abgelaufen. ' +
          `Für Kurse mit mindestens ${minGroup} Antworten ist das endgültig: Ihre Ergebnisse werden freigegeben, und sie können ` +
          'nicht wieder geöffnet werden.'
        : final
          ? ` Die Umfrage hat mindestens ${minGroup} Antworten: Das Schließen ist ENDGÜLTIG, sie kann danach nicht wieder geöffnet werden.`
          : '')
    : `Umfrage „${title}“ wieder öffnen?\n\n` +
      'Die Umfrage nimmt dann wieder Antworten an.' +
      (withCourses
        ? ' Die Kurse bleiben aber abgeschlossen und ihre QR-Codes abgelaufen, bis ein Kurs einzeln ' +
          (live
            ? '(„Für diesen Kurs wieder öffnen“ unter „Kurse und Einmal-Codes“) wieder geöffnet wird.'
            : `(„Für diesen Kurs wieder öffnen“ unter „Kurse und Einmal-Codes“; nur bei weniger als ${minGroup} Antworten möglich) wieder öffnen.`)
        : '');
  return window.confirm(text);
}
