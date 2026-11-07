import type { Locale } from '../shared/schema.ts';

export interface Strings {
  start: string;
  next: string;
  back: string;
  toReview: string;
  submit: string;
  sectionOf: (i: number, n: number) => string;
  requiredMissing: string;
  required: string;
  optional: string;
  reviewTitle: string;
  reviewAnswered: (answered: number, total: number) => string;
  reviewRequiredOk: string;
  reviewFinal: string;
  sending: string;
  pendingTitle: string;
  pendingText: string;
  retry: string;
  closed: string;
  notYetOpen: string;
  full: string;
  notFound: string;
  loadError: string;
  reload: string;
  changed: string;
  sendError: string;
  another: string;
  home: string;
  chars: (n: number, max: number) => string;
  loading: string;
  edit: string;
  sentOk: string;
  codeLabel: string;
  codeHint: string;
  codeOptionalHint: string;
  codeStart: string;
  codeChecking: string;
  codeUnknown: string;
  codeUsed: string;
  codeRequired: string;
  codeOffline: string;
  course: (label: string) => string;
  codeResubmit: string;
  codeBusy: string;
  courseClosed: string;
  keptOnDevice: string;
  sendErrorHint: string;
  tryAgain: string;
  discard: string;
  discardConfirm: string;
  fieldRequired: string;
  privacyHeading: string;
  organiser: string;
}

const de: Strings = {
  start: 'Umfrage starten',
  next: 'Weiter',
  back: 'Zurück',
  toReview: 'Zur Übersicht',
  submit: 'Antworten absenden',
  sectionOf: (i, n) => `Abschnitt ${i} von ${n}`,
  requiredMissing: 'Bitte alle Pflichtfragen dieses Abschnitts beantworten.',
  required: 'Pflichtfrage',
  optional: 'optional',
  reviewTitle: 'Übersicht',
  reviewAnswered: (a, t) => `${a} von ${t} Antworten gegeben`,
  reviewRequiredOk: 'Alle Pflichtfragen sind beantwortet.',
  reviewFinal: 'Nach dem Absenden lassen sich die Antworten nicht mehr ändern.',
  sending: 'Antworten werden gesendet …',
  pendingTitle: 'Gespeichert, aber noch nicht gesendet',
  pendingText:
    'Gerade besteht keine Verbindung zum Server. Die Antworten sind auf diesem Gerät gespeichert und werden automatisch gesendet, sobald wieder eine Verbindung besteht. Bitte diese Seite geöffnet lassen oder später erneut aufrufen.',
  retry: 'Jetzt erneut senden',
  closed: 'Diese Umfrage ist geschlossen; es werden keine Antworten mehr angenommen.',
  notYetOpen: 'Diese Umfrage ist noch nicht geöffnet.',
  full: 'Diese Umfrage nimmt keine weiteren Antworten an.',
  notFound: 'Diese Umfrage wurde nicht gefunden. Bitte Link oder QR-Code prüfen.',
  loadError: 'Die Umfrage konnte nicht geladen werden. Bitte Internetverbindung prüfen und die Seite neu laden.',
  reload: 'Neu laden',
  changed: 'Die Umfrage wurde inzwischen geändert. Bitte die Antworten prüfen und erneut absenden.',
  sendError: 'Die Antworten wurden vom Server nicht angenommen.',
  another: 'Weitere Person auf diesem Gerät',
  home: 'Keine Umfrage ausgewählt. Bitte den Link oder QR-Code der Umfrage verwenden.',
  chars: (n, max) => `${n} / ${max} Zeichen`,
  loading: 'Wird geladen …',
  edit: 'Bearbeiten',
  sentOk: 'Vielen Dank! Die Antworten wurden gesendet.',
  codeLabel: 'Zugangscode',
  codeHint: 'Den Code vom ausgeteilten Zettel eingeben (z. B. K7M2-Q9XW). Er gilt nur einmal und ordnet die Antworten dem Kurs zu, nicht einer Person.',
  codeOptionalHint: 'Falls vorhanden, den Code vom ausgeteilten Zettel eingeben.',
  codeStart: 'Code prüfen und starten',
  codeChecking: 'Code wird geprüft …',
  codeUnknown: 'Dieser Code ist unbekannt oder wurde bereits verwendet. Bitte Eingabe prüfen.',
  codeUsed: 'Dieser Code wurde bereits verwendet.',
  codeRequired: 'Bitte den Zugangscode eingeben.',
  codeOffline: 'Keine Verbindung: Der Code wird beim Absenden geprüft.',
  course: (label) => `Kurs: ${label}`,
  codeResubmit: 'Bitte einen gültigen, unbenutzten Code eingeben und erneut absenden.',
  codeBusy: 'Gerade zu viele Versuche. Bitte gleich noch einmal versuchen.',
  courseClosed: 'Die Umfrage für diesen Kurs ist abgeschlossen.',
  keptOnDevice: 'Die bisherigen Antworten bleiben höchstens 7 Tage auf diesem Gerät gespeichert und werden danach automatisch gelöscht.',
  sendErrorHint: 'Die Antworten sind weiterhin auf diesem Gerät gespeichert.',
  tryAgain: 'Erneut versuchen',
  discard: 'Antworten verwerfen',
  discardConfirm: 'Die Antworten werden von diesem Gerät gelöscht und nicht gesendet. Fortfahren?',
  fieldRequired: 'Bitte diese Frage beantworten.',
  privacyHeading: 'Datenschutz',
  organiser: 'Zugang Kursleitung / Admin',
};

const en: Strings = {
  start: 'Start survey',
  next: 'Next',
  back: 'Back',
  toReview: 'Review',
  submit: 'Submit answers',
  sectionOf: (i, n) => `Section ${i} of ${n}`,
  requiredMissing: 'Please answer all required questions in this section.',
  required: 'Required',
  optional: 'optional',
  reviewTitle: 'Review',
  reviewAnswered: (a, t) => `${a} of ${t} answers given`,
  reviewRequiredOk: 'All required questions are answered.',
  reviewFinal: 'Answers cannot be changed after submitting.',
  sending: 'Sending answers …',
  pendingTitle: 'Saved but not sent yet',
  pendingText:
    'There is no connection to the server right now. Your answers are stored on this device and will be sent automatically once a connection is available. Please keep this page open or open it again later.',
  retry: 'Try again now',
  closed: 'This survey is closed; answers are no longer accepted.',
  notYetOpen: 'This survey is not open yet.',
  full: 'This survey does not accept further answers.',
  notFound: 'Survey not found. Please check the link or QR code.',
  loadError: 'The survey could not be loaded. Please check your connection and reload the page.',
  reload: 'Reload',
  changed: 'The survey has changed in the meantime. Please check your answers and submit again.',
  sendError: 'The server did not accept the answers.',
  another: 'Another person on this device',
  home: 'No survey selected. Please use the survey link or QR code.',
  chars: (n, max) => `${n} / ${max} characters`,
  loading: 'Loading …',
  edit: 'Edit',
  sentOk: 'Thank you! Your answers have been sent.',
  codeLabel: 'Access code',
  codeHint: 'Enter the code from the slip you received (e.g. K7M2-Q9XW). It works once and links the answers to the course, not to a person.',
  codeOptionalHint: 'If you have one, enter the code from the slip you received.',
  codeStart: 'Check code and start',
  codeChecking: 'Checking code …',
  codeUnknown: 'This code is unknown or has already been used. Please check your entry.',
  codeUsed: 'This code has already been used.',
  codeRequired: 'Please enter the access code.',
  codeOffline: 'No connection: the code will be checked when you submit.',
  course: (label) => `Course: ${label}`,
  codeResubmit: 'Please enter a valid, unused code and submit again.',
  codeBusy: 'Too many attempts right now. Please try again in a moment.',
  courseClosed: 'The survey for this course has ended.',
  keptOnDevice: 'The answers given so far stay on this device for at most 7 days and are then deleted automatically.',
  sendErrorHint: 'The answers are still stored on this device.',
  tryAgain: 'Try again',
  discard: 'Discard answers',
  discardConfirm: 'The answers will be deleted from this device and not sent. Continue?',
  fieldRequired: 'Please answer this question.',
  privacyHeading: 'Privacy',
  organiser: 'Organiser access',
};

export function stringsFor(locale: Locale | undefined): Strings {
  return locale === 'en' ? en : de;
}

export function browserStrings(): Strings {
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('de') ? de : en;
}
