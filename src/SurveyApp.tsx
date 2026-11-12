import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  fieldProblem,
  fieldsOf,
  formatCode,
  isAnswered,
  normalizeCode,
  type AnswerValue,
  type Answers,
  type SurveyDefinition,
} from '../shared/schema.ts';
import { checkCode, loadSurvey, type SubmitResult, type SurveyResponse } from './api.ts';
import { photoDb, photoIdsIn } from './photos.ts';
import { sendSubmission } from './send.ts';
import { ItemCard } from './components/ItemCard.tsx';
import { Legend } from './components/Legend.tsx';
import { Inline, Paragraphs } from './components/RichText.tsx';
import { Shell } from './components/Shell.tsx';
import { browserStrings, stringsFor, type Strings } from './i18n.ts';
import { newSubmissionId, storage, type Outbox } from './storage.ts';
import { applyTheme } from './theme.ts';

type Phase =
  | { kind: 'loading' }
  | { kind: 'not_found' }
  | { kind: 'load_error' }
  | { kind: 'unavailable'; reason: 'closed' | 'not_yet_open' | 'full' }
  | { kind: 'form' }
  | { kind: 'sending' }
  | { kind: 'pending' }
  | { kind: 'rejected' }
  | { kind: 'thanks' };

const INTRO = -1;
/** Any step past the last section shows the review page. */
const REVIEW = 9999;
/** Id of the heading that receives focus after Weiter / Zurück and other page changes. */
const HEADING_ID = 'page-heading';

/** A code handed over in the link (#code=XXXX-XXXX) is taken once and removed from the address bar. */
function codeFromLink(): string | null {
  const match = window.location.hash.match(/(?:^#|&)code=([A-Za-z0-9-]{4,20})/);
  if (!match) return null;
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {
    /* ignore */
  }
  return formatCode(normalizeCode(match[1]));
}
const linkCode = codeFromLink();

type CodeState = 'idle' | 'checking' | 'ok' | 'unknown' | 'used' | 'offline' | 'required' | 'course_closed' | 'busy';
type Notice = 'changed' | 'code' | null;

/** Keeps the answers whose key still exists and whose value still fits the definition. */
function migrateAnswers(def: SurveyDefinition, answers: Answers): Answers {
  const out: Answers = {};
  for (const field of fieldsOf(def)) {
    const value = answers[field.key];
    if (isAnswered(value) && fieldProblem(def, field, value) === null) out[field.key] = value;
  }
  return out;
}

function sectionProblems(def: SurveyDefinition, index: number, answers: Answers): string[] {
  return fieldsOf(def)
    .filter((f) => f.sectionId === def.sections[index].id)
    .filter((f) => fieldProblem(def, f, answers[f.key]) !== null)
    .map((f) => f.key);
}

export function SurveyApp({ surveyId }: { surveyId: string }) {
  const [survey, setSurvey] = useState<SurveyResponse | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [answers, setAnswersState] = useState<Answers>({});
  const [step, setStepState] = useState(INTRO);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<Notice>(null);
  const [code, setCodeValue] = useState(linkCode ?? '');
  const [course, setCourseValue] = useState<string | null>(null);
  const [codeState, setCodeState] = useState<CodeState>('idle');
  const [noticeConfirmed, setNoticeConfirmedState] = useState(false);
  const setNoticeConfirmed = (v: boolean) => {
    live.current.noticeConfirmed = v;
    setNoticeConfirmedState(v);
  };
  /** Unsent answers are kept on the device although the survey cannot take them now. */
  const [keptAnswers, setKeptAnswers] = useState(false);

  // Latest values, updated together with the state, so async handlers (code check, submit,
  // retries) never write a draft from a stale render.
  const live = useRef({
    def: null as SurveyDefinition | null,
    answers: {} as Answers,
    step: INTRO,
    code: linkCode ?? '',
    course: null as string | null,
    noticeConfirmed: false,
  });
  /** The pending submission, also kept here so retries work when localStorage is blocked. */
  const outboxRef = useRef<Outbox | null>(null);
  const sendingRef = useRef(false);
  /** A code from a scanned link that has not been used for a participation yet. */
  // A scanned code survives a reload of this tab until the participation starts.
  const pendingLinkCode = useRef<string | null>(linkCode ?? storage.loadScanned(surveyId));
  if (linkCode) storage.saveScanned(surveyId, linkCode);
  const focusHeading = useRef(false);

  const def = survey?.definition;
  const t: Strings = def ? stringsFor(def.locale) : browserStrings();

  const setAnswers = (a: Answers) => {
    live.current.answers = a;
    setAnswersState(a);
  };
  const setStep = (s: number) => {
    live.current.step = s;
    setStepState(s);
  };
  const setCode = (c: string) => {
    live.current.code = c;
    setCodeValue(c);
  };
  const setCourse = (c: string | null) => {
    live.current.course = c;
    setCourseValue(c);
  };
  const adoptDefinition = (data: SurveyResponse) => {
    // Surveys with codes keep drafts only for this tab (shared devices).
    storage.useSessionDrafts(!!data.definition.accessCodes);
    live.current.def = data.definition;
    document.title = data.definition.title;
    document.documentElement.lang = data.definition.locale;
    setSurvey(data);
  };

  /** Writes the current answers to the draft of `version` (default: the loaded definition). */
  const saveDraft = (version = live.current.def?.version, expiresAt?: number) => {
    if (version === undefined) return;
    const { answers: a, step: s, code: c, course: k, noticeConfirmed: n } = live.current;
    const normalized = normalizeCode(c);
    storage.saveDraft(
      surveyId,
      version,
      { answers: a, step: s, code: normalized ? formatCode(normalized) : undefined, course: k, noticeConfirmed: n || undefined },
      expiresAt,
    );
  };

  /** Forgets this tab's pending submission (other people's on this device stay). */
  const dropOutbox = () => {
    const sid = outboxRef.current?.submissionId;
    outboxRef.current = null;
    storage.clearOutbox(surveyId, sid);
  };

  /** Sends pending submissions of other people on this device in the background. */
  const flushOthers = async (exceptId?: string) => {
    for (const other of storage.listOutboxes(surveyId)) {
      if (other.submissionId === exceptId) continue;
      const r = await sendSubmission(surveyId, other, (o) => storage.saveOutbox(surveyId, o));
      if (r.kind === 'stored') storage.clearOutbox(surveyId, other.submissionId);
    }
  };

  const anyKeptAnswers = (): boolean => {
    if (Object.keys(live.current.answers).length > 0) return true;
    const version = live.current.def?.version ?? -1;
    const drafts = [storage.loadDraft(surveyId, version), ...storage.otherDrafts(surveyId, version).map((d) => d.draft)];
    return drafts.some((d) => d !== null && Object.keys(d.answers ?? {}).length > 0);
  };

  const showUnavailable = (reason: 'closed' | 'not_yet_open' | 'full') => {
    setKeptAnswers(anyKeptAnswers());
    setPhase({ kind: 'unavailable', reason });
  };

  /** Fresh participation (another person on this device, or a newly scanned code). */
  const startFresh = (scanned: string | null) => {
    storage.clearDone(surveyId);
    pendingLinkCode.current = null;
    storage.saveScanned(surveyId, scanned);
    setAnswers({});
    setCode(scanned ?? '');
    setCourse(null);
    setCodeState('idle');
    // The next person on this device confirms the notice for themselves.
    setNoticeConfirmed(false);
    setStep(INTRO);
    setNotice(null);
    setMissing(new Set());
    focusHeading.current = true;
    setPhase({ kind: 'form' });
    window.scrollTo({ top: 0 });
  };

  /**
   * Puts answers the server did not take back into the form (review page) and into the draft
   * right away, so a reload of the tab (iOS) does not lose them.
   */
  const keepInDraft = (outbox: Outbox, keepCourse: string | null) => {
    const d = live.current.def;
    const version = d?.version ?? outbox.surveyVersion;
    const expiresAt = storage.loadDraft(surveyId, outbox.surveyVersion)?.expiresAt ?? outbox.expiresAt;
    if (version !== outbox.surveyVersion) storage.clearDraft(surveyId, outbox.surveyVersion);
    setAnswers(d && version !== outbox.surveyVersion ? migrateAnswers(d, outbox.answers) : outbox.answers);
    setCode(outbox.code ? formatCode(outbox.code) : live.current.code);
    setCourse(keepCourse);
    setCodeState(keepCourse ? 'ok' : 'idle');
    setStep(REVIEW);
    saveDraft(version, expiresAt);
  };

  /**
   * Loads the current definition and carries the answers over to its version: keys that no
   * longer exist, or whose value no longer fits, are dropped; the draft moves to the new key.
   * `draftVersion`: version the draft is saved under when no definition is loaded yet.
   */
  const reloadDefinition = async (draftVersion?: number): Promise<SurveyResponse | null> => {
    const result = await loadSurvey(surveyId);
    if (result.kind !== 'ok') return null;
    const data = result.data;
    storage.saveDefinitionCopy(surveyId, data);
    await applyTheme(data.definition.theme);
    const before = live.current.def?.version ?? draftVersion;
    adoptDefinition(data);
    setAnswers(migrateAnswers(data.definition, live.current.answers));
    if (before !== undefined && before !== data.definition.version) {
      const expiresAt = storage.loadDraft(surveyId, before)?.expiresAt;
      storage.clearDraft(surveyId, before);
      saveDraft(data.definition.version, expiresAt);
    } else {
      saveDraft(data.definition.version);
    }
    return data;
  };

  const trySendImpl = async (outbox: Outbox, quiet: boolean) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    if (!quiet) setPhase({ kind: 'sending' });
    let result: SubmitResult;
    try {
      result = await sendSubmission(surveyId, outbox, (o) => {
        outbox = o;
        if (outboxRef.current?.submissionId === o.submissionId) outboxRef.current = o;
        storage.saveOutbox(surveyId, o);
      });
    } finally {
      sendingRef.current = false;
    }
    switch (result.kind) {
      case 'stored': {
        // Only now does the device forget the answers. The submission id goes with the outbox,
        // so nothing on the device links it to the stored response.
        dropOutbox();
        void flushOthers(outbox.submissionId);
        storage.clearAllDrafts(surveyId);
        const d = live.current.def;
        storage.markDone(surveyId, d ? !!d.accessCodes : true);
        setAnswers({});
        setCourse(null);
        setCode('');
        setCodeState('idle');
        setStep(INTRO);
        setNotice(null);
        const scanned = pendingLinkCode.current;
        if (scanned && normalizeCode(scanned) !== (outbox.code ?? '')) {
          // A code scanned for somebody else while this submission was waiting.
          startFresh(scanned);
          return;
        }
        pendingLinkCode.current = null;
        storage.saveScanned(surveyId, null);
        focusHeading.current = true;
        setPhase({ kind: 'thanks' });
        return;
      }
      case 'offline':
        setPhase({ kind: 'pending' });
        return;
      case 'closed':
      case 'not_yet_open':
      case 'full':
        // The survey takes no answers now; they stay in the draft (until it expires).
        dropOutbox();
        keepInDraft(outbox, outbox.course ?? null);
        showUnavailable(result.kind);
        return;
      case 'code_unknown':
      case 'code_used':
      case 'code_required':
      case 'course_closed': {
        // Answers stay; the participant enters another code on the review page.
        dropOutbox();
        keepInDraft(outbox, null);
        if (!live.current.def) await reloadDefinition(outbox.surveyVersion);
        const states: Record<typeof result.kind, CodeState> = {
          code_unknown: 'unknown',
          code_used: 'used',
          code_required: 'required',
          course_closed: 'course_closed',
        };
        setCodeState(states[result.kind]);
        setNotice('code');
        focusHeading.current = true;
        setPhase({ kind: 'form' });
        return;
      }
      case 'notice_not_confirmed': {
        // Sent without the notice confirmed (e.g. from a page loaded before the notice existed):
        // keep the answers and show the start page, whose button needs the checkbox.
        dropOutbox();
        keepInDraft(outbox, outbox.course ?? null);
        const data = await reloadDefinition(outbox.surveyVersion);
        if (data && data.status !== 'open') {
          showUnavailable(data.status);
          return;
        }
        setNoticeConfirmed(false);
        setStep(INTRO);
        setMissing(new Set());
        focusHeading.current = true;
        setPhase({ kind: 'form' });
        return;
      }
      case 'version_changed':
      case 'invalid': {
        // The definition changed since the answers were given: carry them over and review.
        dropOutbox();
        keepInDraft(outbox, outbox.course ?? null);
        const data = await reloadDefinition(outbox.surveyVersion);
        if (data && data.status !== 'open') {
          showUnavailable(data.status);
          return;
        }
        // A new version may have added a notice: then it must be confirmed first.
        setStep(data?.definition.notice && !live.current.noticeConfirmed ? INTRO : REVIEW);
        setMissing(new Set());
        setNotice('changed');
        focusHeading.current = true;
        setPhase({ kind: 'form' });
        return;
      }
      default:
        // Outbox and draft stay; the participant can retry or discard.
        setPhase({ kind: 'rejected' });
    }
  };

  /** Restores a draft of this survey (also one saved under an older definition version). */
  const restoreDraft = (d: SurveyDefinition, scanned: string | null) => {
    let draft = storage.loadDraft(surveyId, d.version);
    let changed = false;
    if (!draft) {
      const older = storage.otherDrafts(surveyId, d.version)[0];
      if (older) {
        const { expiresAt, ...rest } = older.draft;
        draft = { ...rest, answers: migrateAnswers(d, older.draft.answers ?? {}) };
        changed = true;
        storage.clearAllDrafts(surveyId);
        storage.saveDraft(surveyId, d.version, draft, expiresAt);
      }
    }
    if (!draft) return;
    const draftCode = normalizeCode(draft.code ?? '');
    if (scanned) {
      const scannedCode = normalizeCode(scanned);
      if (draft.course && draftCode && draftCode !== scannedCode) {
        // The draft was started with another, confirmed code, i.e. by somebody else on this
        // device. The scanned code starts a fresh participation without their answers.
        storage.clearAllDrafts(surveyId);
        return;
      }
      setCourse(draftCode === scannedCode ? (draft.course ?? null) : null);
      setCodeState(draftCode === scannedCode && draft.course ? 'ok' : 'idle');
    } else if (draft.code) {
      setCode(draft.code);
      setCourse(draft.course ?? null);
      setCodeState(draft.course ? 'ok' : 'idle');
    }
    setAnswers(draft.answers ?? {});
    // A draft without a confirmed notice (e.g. started before the notice existed) starts over at
    // the start page; the answers stay.
    const confirmed = draft.noticeConfirmed === true;
    setNoticeConfirmed(confirmed);
    setStep(d.notice && !confirmed ? INTRO : Math.min(Math.max(INTRO, draft.step ?? INTRO), d.sections.length));
    if (changed) setNotice('changed');
  };

  // Load the definition, then restore the device state (pending submission, draft, done).
  const startImpl = async (cancelled: () => boolean) => {
    storage.sweepExpired();
    void photoDb.sweepExpired();
    const result = await loadSurvey(surveyId);
    if (cancelled()) return;
    if (result.kind === 'not_found') return setPhase({ kind: 'not_found' });
    // Offline (also on a first visit before the service worker caches anything): use the copy
    // of the definition kept from the last successful load.
    const data = result.kind === 'ok' ? result.data : storage.loadDefinitionCopy(surveyId);
    if (result.kind === 'ok') storage.saveDefinitionCopy(surveyId, result.data);
    const outbox = storage.loadOutbox(surveyId) ?? outboxRef.current;
    outboxRef.current = outbox;
    if (!data) return setPhase(outbox ? { kind: 'pending' } : { kind: 'load_error' });
    await applyTheme(data.definition.theme);
    if (cancelled()) return;
    adoptDefinition(data);
    if (outbox) {
      void trySend(outbox);
      return;
    }
    const d = data.definition;
    if (data.status !== 'open') return showUnavailable(data.status);
    const scanned = pendingLinkCode.current;
    if (storage.isDone(surveyId, !!d.accessCodes)) {
      // A code in the link starts a new participation instead of the thank-you page.
      if (!scanned) return setPhase({ kind: 'thanks' });
      storage.clearDone(surveyId);
    }
    if (scanned) setCode(scanned);
    restoreDraft(d, scanned);
    pendingLinkCode.current = null;
    setPhase({ kind: 'form' });
  };

  /** A code scanned while the page is open (#code= changed). */
  const onScanned = (scanned: string) => {
    if (phase.kind === 'thanks') return startFresh(scanned);
    if (phase.kind === 'form' && !live.current.course) {
      setCode(scanned);
      setCodeState('idle');
      saveDraft();
      return;
    }
    // Kept for "Weitere Person auf diesem Gerät".
    pendingLinkCode.current = scanned;
  };

  const impl = useRef({ send: trySendImpl, start: startImpl, scanned: onScanned });
  useLayoutEffect(() => {
    impl.current = { send: trySendImpl, start: startImpl, scanned: onScanned };
  });
  const trySend = useCallback((outbox: Outbox, quiet = false) => impl.current.send(outbox, quiet), []);

  useEffect(() => {
    let cancelled = false;
    void impl.current.start(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [surveyId]);

  // Retry a pending submission when the connection returns, the page becomes visible again,
  // or every 20 seconds while the page stays open.
  useEffect(() => {
    if (phase.kind !== 'pending') return;
    const retry = () => {
      const outbox = outboxRef.current ?? storage.loadOutbox(surveyId);
      if (outbox) void trySend(outbox, true);
    };
    const onVisible = () => document.visibilityState === 'visible' && retry();
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(retry, 20_000);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [phase.kind, surveyId, trySend]);

  useEffect(() => {
    const onHash = () => {
      const scanned = codeFromLink();
      if (scanned) impl.current.scanned(scanned);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // After a page change, move focus to the new heading so screen readers start there.
  useEffect(() => {
    if (!focusHeading.current) return;
    const heading = document.getElementById(HEADING_ID);
    if (!heading) return;
    focusHeading.current = false;
    heading.focus({ preventScroll: true });
  });

  /** Checks the access code before starting (or before resubmitting). Offline, it is checked on submit. */
  const verifyCode = async (): Promise<boolean> => {
    const d = live.current.def;
    if (!d?.accessCodes) return true;
    const normalized = normalizeCode(live.current.code);
    if (!normalized) {
      if (d.accessCodes === 'optional') return true;
      setCodeState('required');
      return false;
    }
    setCodeState('checking');
    const result = await checkCode(surveyId, normalized);
    switch (result.kind) {
      case 'ok':
        setCode(formatCode(normalized));
        setCourse(result.course);
        setCodeState('ok');
        // The draft holds the course right away (not only after the next answer).
        saveDraft();
        return true;
      case 'offline':
        setCourse(null);
        setCodeState('offline');
        return true;
      case 'busy':
        // Rate limit: temporary, the code is not marked as bad.
        setCodeState('busy');
        return false;
      case 'closed':
      case 'not_yet_open':
        // The whole survey is closed: every code is expired. Answers given so far stay.
        setCodeState('idle');
        if (Object.keys(live.current.answers).length > 0) saveDraft();
        showUnavailable(result.kind);
        return false;
      default:
        setCourse(null);
        setCodeState(result.kind);
        if (Object.keys(live.current.answers).length > 0) saveDraft();
        return false;
    }
  };

  const onCodeInput = (value: string) => {
    setCode(value);
    if (codeState !== 'idle' && codeState !== 'checking') {
      setCourse(null);
      setCodeState('idle');
    }
  };

  const onAnswer = (key: string, value: AnswerValue | undefined) => {
    const next = { ...live.current.answers };
    if (value === undefined) delete next[key];
    else next[key] = value;
    setAnswers(next);
    saveDraft();
    setMissing((prev) => {
      if (!prev.has(key)) return prev;
      const rest = new Set(prev);
      rest.delete(key);
      return rest;
    });
  };

  const goTo = (next: number) => {
    setStep(next);
    setMissing(new Set());
    saveDraft();
    focusHeading.current = true;
    window.scrollTo({ top: 0 });
  };

  const next = () => {
    const d = live.current.def;
    if (!d) return;
    const current = Math.min(live.current.step, d.sections.length);
    if (current >= 0 && current < d.sections.length) {
      const problems = sectionProblems(d, current, live.current.answers);
      if (problems.length > 0) {
        setMissing(new Set(problems));
        const bad = fieldsOf(d).find((f) => f.key === problems[0]);
        const firstItem = bad?.parent ?? bad?.item.id;
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        document.getElementById(`item-${firstItem}`)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
        return;
      }
    }
    setNotice(null);
    goTo(current + 1);
  };

  const submit = () => {
    const d = live.current.def;
    if (!d) return;
    const given = live.current.answers;
    const firstBad = d.sections.findIndex((_, i) => sectionProblems(d, i, given).length > 0);
    if (firstBad >= 0) {
      goTo(firstBad);
      setMissing(new Set(sectionProblems(d, firstBad, given)));
      return;
    }
    const normalized = normalizeCode(live.current.code);
    if (d.accessCodes === 'required' && !normalized) {
      setCodeState('required');
      setNotice('code');
      return;
    }
    if (d.notice && !live.current.noticeConfirmed) {
      focusHeading.current = true;
      setStep(INTRO);
      return;
    }
    const outbox: Outbox = {
      submissionId: newSubmissionId(),
      surveyVersion: d.version,
      answers: given,
      code: normalized || undefined,
      // The checkbox state itself; the server refuses answers to a notice that was not confirmed.
      noticeConfirmed: d.notice ? live.current.noticeConfirmed : undefined,
      course: live.current.course,
      // Answers never stay longer than the draft was allowed to (at most 7 days from its start).
      expiresAt: storage.loadDraft(surveyId, d.version)?.expiresAt,
    };
    outboxRef.current = outbox;
    storage.saveOutbox(surveyId, outbox);
    // The draft stays until the server confirms that the answers are stored.
    saveDraft();
    void trySend(outbox);
  };

  const startAnother = () => startFresh(pendingLinkCode.current ?? codeFromLink());

  const retryNow = () => {
    const outbox = outboxRef.current ?? storage.loadOutbox(surveyId);
    if (outbox) {
      void trySend(outbox);
      return;
    }
    // Nothing left to send: back to the review page with the draft.
    setStep(REVIEW);
    setPhase({ kind: 'form' });
  };

  const discard = () => {
    if (!window.confirm(t.discardConfirm)) return;
    dropOutbox();
    storage.clearAllDrafts(surveyId);
    // Photos of other people's pending submissions on this device stay.
    void photoDb.prune(surveyId, new Set(storage.listOutboxes(surveyId).flatMap((o) => photoIdsIn(o.answers))));
    setKeptAnswers(false);
    if (phase.kind === 'unavailable') {
      setAnswers({});
      setCode('');
      setCourse(null);
      setCodeState('idle');
      setStep(INTRO);
      return;
    }
    startFresh(null);
  };

  const fieldCount = useMemo(() => (def ? fieldsOf(def).length : 0), [def]);
  const answeredCount = useMemo(() => (def ? fieldsOf(def).filter((f) => isAnswered(answers[f.key])).length : 0), [def, answers]);

  const shellProps = def
    ? { brand: def.brand, title: def.title, subtitle: def.subtitle, footer: def.footer }
    : {};

  if (phase.kind === 'loading') {
    return <Shell><p className="status-text">{t.loading}</p></Shell>;
  }
  if (phase.kind === 'not_found') {
    return <Shell><Message text={t.notFound} /></Shell>;
  }
  if (phase.kind === 'load_error') {
    return (
      <Shell {...shellProps}>
        <Message text={t.loadError} />
        <div className="nav"><button className="btn btn-primary" onClick={() => window.location.reload()}>{t.reload}</button></div>
      </Shell>
    );
  }
  if (phase.kind === 'unavailable') {
    const text = phase.reason === 'closed' ? t.closed : phase.reason === 'full' ? t.full : t.notYetOpen;
    return (
      <Shell {...shellProps}>
        <Message text={text} />
        {keptAnswers && (
          <>
            <div className="panel panel-warn"><p>{t.keptOnDevice}</p></div>
            <div className="nav nav-quiet">
              <button className="btn btn-link" onClick={discard}>{t.discard}</button>
            </div>
          </>
        )}
      </Shell>
    );
  }
  if (phase.kind === 'sending') {
    return <Shell {...shellProps}><p className="status-text" role="status">{t.sending}</p></Shell>;
  }
  if (phase.kind === 'pending') {
    return (
      <Shell {...shellProps}>
        <div className="panel panel-warn" role="status">
          <h2 className="panel-title">{t.pendingTitle}</h2>
          <p>{t.pendingText}</p>
        </div>
        <div className="nav">
          <span />
          <button className="btn btn-primary" onClick={retryNow}>{t.retry}</button>
        </div>
      </Shell>
    );
  }
  if (phase.kind === 'rejected') {
    return (
      <Shell {...shellProps}>
        <div className="panel panel-error" role="alert">
          <p>{t.sendError}</p>
        </div>
        <p>{t.sendErrorHint}</p>
        <div className="nav">
          <button className="btn btn-secondary" onClick={discard}>{t.discard}</button>
          <button className="btn btn-primary" onClick={retryNow}>{t.tryAgain}</button>
        </div>
      </Shell>
    );
  }
  if (!def) {
    return <Shell><Message text={phase.kind === 'thanks' ? t.sentOk : t.loadError} /></Shell>;
  }

  if (phase.kind === 'thanks') {
    return (
      <Shell {...shellProps}>
        <div className="panel panel-done" id={HEADING_ID} tabIndex={-1}>
          {def.thanks.heading && <h1 className="panel-title">{def.thanks.heading}</h1>}
          <Paragraphs paragraphs={def.thanks.paragraphs} />
        </div>
        <div className="nav nav-quiet">
          <button className="btn btn-link" onClick={startAnother}>{t.another}</button>
        </div>
      </Shell>
    );
  }

  const sections = def.sections;
  const current = Math.min(step, sections.length);
  const codeField = (
    <CodeField
      t={t}
      code={code}
      setCode={onCodeInput}
      state={codeState}
      course={course}
      optional={def.accessCodes === 'optional'}
    />
  );
  if (current === INTRO) {
    return (
      <Shell {...shellProps}>
        <article className="intro" id={def.intro.heading ? undefined : HEADING_ID} tabIndex={def.intro.heading ? undefined : -1}>
          {def.intro.heading && <h1 className="page-title" id={HEADING_ID} tabIndex={-1}>{def.intro.heading}</h1>}
          {def.notice && (
            <section className="panel panel-warn confirm-notice" aria-labelledby="confirm-notice-title">
              {def.notice.heading && <h2 className="panel-title" id="confirm-notice-title">{def.notice.heading}</h2>}
              <Paragraphs paragraphs={def.notice.paragraphs} />
              <label className="confirm-check">
                <input type="checkbox" checked={noticeConfirmed} onChange={(e) => setNoticeConfirmed(e.target.checked)} />
                <span>{def.notice.confirm}</span>
              </label>
            </section>
          )}
          <Paragraphs paragraphs={def.intro.paragraphs} />
          {def.accessCodes && codeField}
          {def.privacy && (
            <details className="privacy">
              <summary>{def.privacy.heading ?? t.privacyHeading}</summary>
              <Paragraphs paragraphs={def.privacy.paragraphs} />
            </details>
          )}
        </article>
        <p className="organiser-link">
          <a href={window.location.pathname.startsWith('/s/') ? `/admin/results/${surveyId}` : '/admin'}>{t.organiser}</a>
        </p>
        <div className="nav">
          <span />
          <button
            className="btn btn-primary"
            disabled={codeState === 'checking' || (!!def.notice && !noticeConfirmed)}
            onClick={async () => {
              if (def.notice && !noticeConfirmed) return;
              if (await verifyCode()) goTo(0);
            }}
          >
            {def.accessCodes && codeState !== 'ok' && normalizeCode(code) ? t.codeStart : t.start}
          </button>
        </div>
      </Shell>
    );
  }

  if (current >= sections.length) {
    return (
      <Shell {...shellProps}>
        <Progress current={sections.length} total={sections.length} label={t.reviewTitle} />
        <h1 className="page-title" id={HEADING_ID} tabIndex={-1}>{t.reviewTitle}</h1>
        {notice === 'changed' && <div className="panel panel-warn" role="alert">{t.changed}</div>}
        {notice === 'code' &&
          (codeState === 'course_closed' ? (
            <div className="panel panel-warn" role="status">
              <p>{t.keptOnDevice}</p>
              <p><button className="btn btn-link" onClick={discard}>{t.discard}</button></p>
            </div>
          ) : (
            <div className="panel panel-error" role="alert">{t.codeResubmit}</div>
          ))}
        {def.accessCodes && (notice === 'code' || !course) ? codeField : course && <p className="course-line">{t.course(course)}</p>}
        <ol className="review-list">
          {sections.map((s, i) => {
            const fields = fieldsOf(def).filter((f) => f.sectionId === s.id);
            const given = fields.filter((f) => isAnswered(answers[f.key])).length;
            return (
              <li key={s.id} className="review-entry">
                <span className="review-num">{s.label ?? i + 1}</span>
                <span className="review-title">{s.title}</span>
                <span className="review-count">{given}/{fields.length}</span>
                <button className="btn btn-link review-edit" onClick={() => goTo(i)}>{t.edit}</button>
              </li>
            );
          })}
        </ol>
        <p className="review-summary">
          {t.reviewAnswered(answeredCount, fieldCount)}.{' '}
          {def.sections.every((_, i) => sectionProblems(def, i, answers).length === 0) ? t.reviewRequiredOk : t.requiredMissing}
        </p>
        <p className="review-final">{t.reviewFinal}</p>
        <div className="nav">
          <button className="btn btn-secondary" onClick={() => goTo(sections.length - 1)}>{t.back}</button>
          <button
            className="btn btn-primary"
            disabled={codeState === 'checking'}
            onClick={async () => {
              if (notice === 'code' && !(await verifyCode())) return;
              setNotice(null);
              submit();
            }}
          >
            {t.submit}
          </button>
        </div>
      </Shell>
    );
  }

  const section = sections[current];
  return (
    <Shell {...shellProps}>
      <Progress current={current + 1} total={sections.length} label={t.sectionOf(current + 1, sections.length)} />
      {def.sectionNav && (
        <label className="section-jump">
          <span className="section-jump-label">{t.jumpTo}</span>
          <select
            value={current}
            onChange={(e) => {
              const target = Number(e.target.value);
              setNotice(null);
              goTo(target);
            }}
          >
            {sections.map((s, i) => {
              const fields = fieldsOf(def).filter((f) => f.sectionId === s.id);
              const given = fields.filter((f) => isAnswered(answers[f.key])).length;
              return (
                <option key={s.id} value={i}>
                  {s.label ?? i + 1}. {s.title} ({given}/{fields.length})
                </option>
              );
            })}
            <option value={sections.length}>{t.reviewTitle}</option>
          </select>
        </label>
      )}
      <h1 className="section-title" id={HEADING_ID} tabIndex={-1}>
        <span className="section-num">{section.label ?? current + 1}</span>
        <span>{section.title}</span>
      </h1>
      {section.description && (
        <div className="section-desc"><Inline text={section.description} /></div>
      )}
      {section.legendScale && def.scales[section.legendScale] && <Legend scale={def.scales[section.legendScale]} />}
      {notice === 'changed' && <div className="panel panel-warn" role="alert">{t.changed}</div>}
      {missing.size > 0 && (
        <div className="panel panel-error" role="alert">{t.requiredMissing}</div>
      )}
      <div className="items">
        {section.items.map((item) => (
          <ItemCard key={item.id} def={def} item={item} answers={answers} missing={missing} onAnswer={onAnswer} t={t} />
        ))}
      </div>
      <div className="nav">
        <button className="btn btn-secondary" onClick={() => goTo(current - 1)}>{t.back}</button>
        <button className="btn btn-primary" onClick={next}>
          {current === sections.length - 1 ? t.toReview : t.next}
        </button>
      </div>
    </Shell>
  );
}

function CodeField({
  t,
  code,
  setCode,
  state,
  course,
  optional,
}: {
  t: Strings;
  code: string;
  setCode: (v: string) => void;
  state: CodeState;
  course: string | null;
  optional: boolean;
}) {
  const messages: Partial<Record<CodeState, string>> = {
    checking: t.codeChecking,
    unknown: t.codeUnknown,
    used: t.codeUsed,
    required: t.codeRequired,
    offline: t.codeOffline,
    course_closed: t.courseClosed,
    busy: t.codeBusy,
  };
  const message = messages[state] ?? null;
  const bad = state === 'unknown' || state === 'used' || state === 'required' || state === 'course_closed';
  return (
    <div className={`code-field${bad ? ' is-invalid' : ''}`}>
      <label htmlFor="access-code">{t.codeLabel}{optional ? ` (${t.optional})` : ''}</label>
      <input
        id="access-code"
        className="text-input code-input"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        inputMode="text"
        maxLength={12}
        placeholder="XXXX-XXXX"
        aria-required={optional ? undefined : true}
        aria-invalid={bad || undefined}
        aria-describedby={message ? 'access-code-hint access-code-message' : 'access-code-hint'}
      />
      <p className="code-hint" id="access-code-hint">{optional ? t.codeOptionalHint : t.codeHint}</p>
      {state === 'ok' && course && <p className="course-line">{t.course(course)}</p>}
      {message && <p id="access-code-message" className={bad ? 'code-error' : 'code-note'} role={bad ? 'alert' : 'status'}>{message}</p>}
    </div>
  );
}

function Message({ text }: { text: string }) {
  return <div className="panel"><p>{text}</p></div>;
}

function Progress({ current, total, label }: { current: number; total: number; label: string }) {
  return (
    <div className="progress">
      <div className="progress-label">{label}</div>
      <progress className="progress-bar" value={current} max={total} aria-label={label} />
    </div>
  );
}
