import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { checkCode, loadSurvey, submitAnswers, type SurveyResponse } from './api.ts';
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

type CodeState = 'idle' | 'checking' | 'ok' | 'unknown' | 'used' | 'offline' | 'required';
/** Any step past the last section shows the review page. */
const REVIEW = 9999;

export function SurveyApp({ surveyId }: { surveyId: string }) {
  const [survey, setSurvey] = useState<SurveyResponse | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [answers, setAnswers] = useState<Answers>({});
  const [step, setStep] = useState(INTRO);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState(linkCode ?? '');
  const [course, setCourse] = useState<string | null>(null);
  const [codeState, setCodeState] = useState<CodeState>('idle');
  const sendingRef = useRef(false);

  const def = survey?.definition;
  const t: Strings = def ? stringsFor(def.locale) : browserStrings();

  const trySend = useCallback(
    async (outbox: Outbox) => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      setPhase({ kind: 'sending' });
      const result = await submitAnswers(surveyId, outbox.submissionId, outbox.surveyVersion, outbox.answers, outbox.code);
      sendingRef.current = false;
      switch (result.kind) {
        case 'stored':
          // The submission id is removed together with the outbox, so nothing on the device
          // links it to the stored response.
          storage.clearOutbox(surveyId);
          storage.markDone(surveyId);
          setPhase({ kind: 'thanks' });
          break;
        case 'offline':
          setPhase({ kind: 'pending' });
          break;
        case 'closed':
        case 'not_yet_open':
        case 'full':
          storage.clearOutbox(surveyId);
          setPhase({ kind: 'unavailable', reason: result.kind });
          break;
        case 'code_unknown':
        case 'code_used':
        case 'code_required':
          // Answers stay; the participant enters another code on the review page.
          storage.clearOutbox(surveyId);
          setAnswers(outbox.answers);
          setCode(outbox.code ?? '');
          setCourse(null);
          setCodeState(result.kind === 'code_used' ? 'used' : result.kind === 'code_required' ? 'required' : 'unknown');
          setStep(REVIEW);
          setNotice('code');
          setPhase({ kind: 'form' });
          break;
        case 'invalid':
          // The definition changed since the answers were given: put them back for review.
          storage.clearOutbox(surveyId);
          setAnswers(outbox.answers);
          setStep(REVIEW);
          setNotice('changed');
          setPhase({ kind: 'form' });
          break;
        default:
          setPhase({ kind: 'rejected' });
      }
    },
    [surveyId],
  );

  // Load the definition, then restore the device state (pending submission, draft, done).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await loadSurvey(surveyId);
      if (cancelled) return;
      if (result.kind === 'not_found') return setPhase({ kind: 'not_found' });
      if (result.kind === 'error') {
        const outbox = storage.loadOutbox(surveyId);
        return setPhase(outbox ? { kind: 'pending' } : { kind: 'load_error' });
      }
      const data = result.data;
      await applyTheme(data.definition.theme);
      if (cancelled) return;
      document.title = data.definition.title;
      document.documentElement.lang = data.definition.locale;
      setSurvey(data);
      const outbox = storage.loadOutbox(surveyId);
      if (outbox) {
        void trySend(outbox);
        return;
      }
      if (data.status !== 'open') return setPhase({ kind: 'unavailable', reason: data.status });
      if (storage.isDone(surveyId)) return setPhase({ kind: 'thanks' });
      const draft = storage.loadDraft(surveyId, data.definition.version);
      if (draft) {
        setAnswers(draft.answers ?? {});
        if (!linkCode && draft.code) {
          setCode(draft.code);
          setCourse(draft.course ?? null);
          setCodeState(draft.course ? 'ok' : 'idle');
        }
        const maxStep = data.definition.sections.length;
        setStep(Math.min(Math.max(INTRO, draft.step ?? INTRO), maxStep));
      }
      setPhase({ kind: 'form' });
    })();
    return () => {
      cancelled = true;
    };
  }, [surveyId, trySend]);

  // Retry a pending submission when the connection returns, the page becomes visible again,
  // or every 20 seconds while the page stays open.
  useEffect(() => {
    if (phase.kind !== 'pending') return;
    const retry = () => {
      const outbox = storage.loadOutbox(surveyId);
      if (outbox) void trySend(outbox);
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

  const persist = useCallback(
    (nextAnswers: Answers, nextStep: number, nextCode = code, nextCourse = course) => {
      if (def) storage.saveDraft(surveyId, def.version, { answers: nextAnswers, step: nextStep, code: nextCode, course: nextCourse });
    },
    [def, surveyId, code, course],
  );

  /** Checks the access code before starting (or before resubmitting). Offline, it is checked on submit. */
  const verifyCode = async (): Promise<boolean> => {
    if (!def?.accessCodes) return true;
    const normalized = normalizeCode(code);
    if (!normalized) {
      if (def.accessCodes === 'optional') return true;
      setCodeState('required');
      return false;
    }
    setCodeState('checking');
    const result = await checkCode(surveyId, normalized);
    if (result.kind === 'ok') {
      setCourse(result.course);
      setCodeState('ok');
      setCode(formatCode(normalized));
      persist(answers, step, formatCode(normalized), result.course);
      return true;
    }
    setCourse(null);
    setCodeState(result.kind);
    return result.kind === 'offline';
  };

  const onAnswer = useCallback(
    (key: string, value: AnswerValue | undefined) => {
      setAnswers((prev) => {
        const next = { ...prev };
        if (value === undefined) delete next[key];
        else next[key] = value;
        persist(next, step);
        return next;
      });
      setMissing((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    },
    [persist, step],
  );

  const goTo = (next: number) => {
    setStep(next);
    setMissing(new Set());
    persist(answers, next);
    window.scrollTo({ top: 0 });
  };

  const sectionProblems = (d: SurveyDefinition, index: number): string[] =>
    fieldsOf(d)
      .filter((f) => f.sectionId === d.sections[index].id)
      .filter((f) => fieldProblem(d, f, answers[f.key]) !== null)
      .map((f) => f.key);

  const next = () => {
    if (!def) return;
    const current = Math.min(step, def.sections.length);
    if (current >= 0 && current < def.sections.length) {
      const problems = sectionProblems(def, current);
      if (problems.length > 0) {
        setMissing(new Set(problems));
        const firstItem = fieldsOf(def).find((f) => f.key === problems[0])?.item.id;
        document.getElementById(`item-${firstItem}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
    setNotice(null);
    goTo(current + 1);
  };

  const submit = () => {
    if (!def) return;
    const firstBad = def.sections.findIndex((_, i) => sectionProblems(def, i).length > 0);
    if (firstBad >= 0) {
      goTo(firstBad);
      setMissing(new Set(sectionProblems(def, firstBad)));
      return;
    }
    const normalized = normalizeCode(code);
    if (def.accessCodes === 'required' && !normalized) {
      setCodeState('required');
      setNotice('code');
      return;
    }
    const outbox: Outbox = {
      submissionId: newSubmissionId(),
      surveyVersion: def.version,
      answers,
      code: normalized || undefined,
      course,
    };
    storage.saveOutbox(surveyId, outbox);
    storage.clearDraft(surveyId, def.version);
    void trySend(outbox);
  };

  const startAnother = () => {
    storage.clearDone(surveyId);
    setAnswers({});
    setCode('');
    setCourse(null);
    setCodeState('idle');
    setStep(INTRO);
    setPhase({ kind: 'form' });
    window.scrollTo({ top: 0 });
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
    return <Shell {...shellProps}><Message text={text} /></Shell>;
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
          <button
            className="btn btn-primary"
            onClick={() => {
              const outbox = storage.loadOutbox(surveyId);
              if (outbox) void trySend(outbox);
            }}
          >
            {t.retry}
          </button>
        </div>
      </Shell>
    );
  }
  if (phase.kind === 'rejected') {
    return <Shell {...shellProps}><Message text={t.sendError} /></Shell>;
  }
  if (!def) {
    return <Shell><Message text={phase.kind === 'thanks' ? t.sentOk : t.loadError} /></Shell>;
  }

  if (phase.kind === 'thanks') {
    return (
      <Shell {...shellProps}>
        <div className="panel panel-done">
          {def.thanks.heading && <h2 className="panel-title">{def.thanks.heading}</h2>}
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
  if (current === INTRO) {
    return (
      <Shell {...shellProps}>
        <article className="intro">
          {def.intro.heading && <h1 className="page-title">{def.intro.heading}</h1>}
          <Paragraphs paragraphs={def.intro.paragraphs} />
          {def.accessCodes && <CodeField t={t} code={code} setCode={setCode} state={codeState} course={course} optional={def.accessCodes === 'optional'} />}
          {def.privacy && (
            <details className="privacy">
              <summary>{def.privacy.heading ?? 'Datenschutz'}</summary>
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
            disabled={codeState === 'checking'}
            onClick={async () => {
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
        <h1 className="page-title">{t.reviewTitle}</h1>
        {notice === 'changed' && <div className="panel panel-warn" role="alert">{t.changed}</div>}
        {notice === 'code' && <div className="panel panel-error" role="alert">{t.codeResubmit}</div>}
        {def.accessCodes && (notice === 'code' || !course) ? (
          <CodeField t={t} code={code} setCode={setCode} state={codeState} course={course} optional={def.accessCodes === 'optional'} />
        ) : (
          course && <p className="course-line">{t.course(course)}</p>
        )}
        <ol className="review-list">
          {sections.map((s, i) => {
            const fields = fieldsOf(def).filter((f) => f.sectionId === s.id);
            const given = fields.filter((f) => isAnswered(answers[f.key])).length;
            return (
              <li key={s.id} className="review-entry">
                <span className="review-num">{i + 1}</span>
                <span className="review-title">{s.title}</span>
                <span className="review-count">{given}/{fields.length}</span>
                <button className="btn btn-link review-edit" onClick={() => goTo(i)}>{t.edit}</button>
              </li>
            );
          })}
        </ol>
        <p className="review-summary">{t.reviewAnswered(answeredCount, fieldCount)}. {t.reviewRequiredOk}</p>
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
      <h1 className="section-title">
        <span className="section-num">{current + 1}</span>
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
  const message =
    state === 'checking'
      ? t.codeChecking
      : state === 'unknown'
        ? t.codeUnknown
        : state === 'used'
          ? t.codeUsed
          : state === 'required'
            ? t.codeRequired
            : state === 'offline'
              ? t.codeOffline
              : null;
  const bad = state === 'unknown' || state === 'used' || state === 'required';
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
      />
      <p className="code-hint">{optional ? t.codeOptionalHint : t.codeHint}</p>
      {state === 'ok' && course && <p className="course-line">{t.course(course)}</p>}
      {message && <p className={bad ? 'code-error' : 'code-note'} role={bad ? 'alert' : 'status'}>{message}</p>}
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
