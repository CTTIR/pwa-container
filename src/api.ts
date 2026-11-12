import type { Answers, SurveyDefinition, SurveyStatus } from '../shared/schema.ts';

export interface SurveyResponse {
  definition: SurveyDefinition;
  status: SurveyStatus;
  opensAt: string | null;
  closesAt: string | null;
}

/** Request time limits. A request that runs out of time counts as "offline". */
const DEFINITION_TIMEOUT_MS = 15_000;
const SUBMIT_TIMEOUT_MS = 45_000;
const CODE_TIMEOUT_MS = 20_000;

/** AbortSignal.timeout where available (Safari 16+), otherwise an AbortController with a timer. */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  if (typeof AbortController === 'undefined') return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** True for a parsed object that looks like a survey response (guards against captive portals). */
export function isSurveyResponse(value: unknown): value is SurveyResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { definition?: { version?: unknown; sections?: unknown }; status?: unknown };
  return (
    typeof v.definition === 'object' &&
    v.definition !== null &&
    typeof v.definition.version === 'number' &&
    Array.isArray(v.definition.sections) &&
    (v.status === 'open' || v.status === 'closed' || v.status === 'not_yet_open')
  );
}

/** What a gated survey tells anyone with the link: only that it needs a code, and its state. */
export interface GatedStub {
  locale: string;
  status: SurveyStatus;
}

function gatedStubOf(value: unknown): GatedStub | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as { gated?: unknown; locale?: unknown; status?: unknown };
  if (v.gated !== true) return null;
  if (v.status !== 'open' && v.status !== 'closed' && v.status !== 'not_yet_open') return null;
  return { locale: typeof v.locale === 'string' ? v.locale : 'de', status: v.status };
}

export type LoadResult =
  | { kind: 'ok'; data: SurveyResponse }
  /** The survey shows its definition only for a valid access code (see checkCode). */
  | { kind: 'gated'; stub: GatedStub }
  | { kind: 'not_found' }
  | { kind: 'error' };

export async function loadSurvey(id: string): Promise<LoadResult> {
  try {
    const res = await fetch(`/api/surveys/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
      signal: timeoutSignal(DEFINITION_TIMEOUT_MS),
    });
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) return { kind: 'error' };
    const body: unknown = await res.json();
    if (isSurveyResponse(body)) return { kind: 'ok', data: body };
    const stub = gatedStubOf(body);
    return stub ? { kind: 'gated', stub } : { kind: 'error' };
  } catch {
    // Network failure, time limit or a non-JSON answer (e.g. a Wi-Fi sign-in page).
    return { kind: 'error' };
  }
}

export type SubmitResult =
  /** 201 stored or 200 duplicate: the server has the answers. */
  | { kind: 'stored' }
  /** No connection, time limit, rate limit or server trouble: keep the answers and retry later. */
  | { kind: 'offline' }
  | { kind: 'closed' | 'not_yet_open' | 'full' }
  | { kind: 'code_unknown' | 'code_used' | 'code_required' | 'course_closed' }
  /** The survey definition changed since the page was loaded. */
  | { kind: 'version_changed'; version: number | null }
  | { kind: 'invalid' }
  | { kind: 'notice_not_confirmed' }
  /** The server lacks photos the answers refer to: upload them (again) and resend. */
  | { kind: 'photo_missing'; photos: string[] }
  | { kind: 'error' };

export type CodeResult =
  /** `data`: the definition of a gated survey, handed out with a valid code only. */
  | { kind: 'ok'; course: string; data?: SurveyResponse }
  | { kind: 'unknown' | 'used' | 'course_closed' }
  /** The whole survey is closed (or not open yet): every code is expired. */
  | { kind: 'closed' | 'not_yet_open' }
  /** Too many attempts from this network: temporary, the code is not marked bad. */
  | { kind: 'busy' }
  | { kind: 'offline' };

async function errorOf(res: Response): Promise<{ error?: string; version?: unknown }> {
  try {
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null ? (body as { error?: string; version?: unknown }) : {};
  } catch {
    return {};
  }
}

export async function checkCode(id: string, code: string): Promise<CodeResult> {
  let res: Response;
  try {
    res = await fetch(`/api/surveys/${encodeURIComponent(id)}/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
      signal: timeoutSignal(CODE_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'offline' };
  }
  try {
    if (res.ok) {
      const body = (await res.json()) as { status?: string; course?: unknown; definition?: unknown };
      const course = body.course;
      if (body.status === 'ok' && typeof course === 'string') {
        if (body.definition === undefined) return { kind: 'ok', course };
        // A gated survey's definition, with the state fields (status, opensAt, closesAt).
        const data: unknown = { ...body, status: (body as { surveyStatus?: unknown }).surveyStatus };
        if (isSurveyResponse(data)) return { kind: 'ok', course, data };
      }
      return { kind: 'offline' };
    }
  } catch {
    return { kind: 'offline' };
  }
  if (res.status === 409) {
    const { error } = await errorOf(res);
    if (error === 'course_closed') return { kind: 'course_closed' };
    if (error === 'closed') return { kind: 'closed' };
    if (error === 'not_yet_open') return { kind: 'not_yet_open' };
    return { kind: 'used' };
  }
  if (res.status === 404 || res.status === 400) return { kind: 'unknown' };
  if (res.status === 429) return { kind: 'busy' };
  return { kind: 'offline' };
}

export async function submitAnswers(id: string, submissionId: string, surveyVersion: number, answers: Answers, code?: string, noticeConfirmed?: boolean): Promise<SubmitResult> {
  let res: Response;
  try {
    res = await fetch(`/api/surveys/${encodeURIComponent(id)}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ submissionId, surveyVersion, answers, code, noticeConfirmed }),
      cache: 'no-store',
      signal: timeoutSignal(SUBMIT_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'offline' };
  }
  if (res.status === 201 || res.status === 200) {
    // Only a confirmation from the server counts; a 200 page from a proxy or Wi-Fi sign-in
    // page must not make the device forget the answers.
    try {
      const body = (await res.json()) as { status?: string };
      if (body.status === 'stored' || body.status === 'duplicate') return { kind: 'stored' };
    } catch {
      /* fall through */
    }
    return { kind: 'offline' };
  }
  if (res.status === 409 || res.status === 422) {
    const body = await errorOf(res);
    const { error, version } = body;
    switch (error) {
      case 'version_changed':
        return { kind: 'version_changed', version: typeof version === 'number' ? version : null };
      case 'photo_missing': {
        const photos = (body as { photos?: unknown }).photos;
        return { kind: 'photo_missing', photos: Array.isArray(photos) ? photos.filter((p): p is string => typeof p === 'string') : [] };
      }
      case 'closed':
      case 'not_yet_open':
      case 'full':
      case 'code_used':
      case 'code_unknown':
      case 'code_required':
      case 'course_closed':
      case 'notice_not_confirmed':
        return { kind: error };
      default:
        return res.status === 422 ? { kind: 'invalid' } : { kind: 'error' };
    }
  }
  // Proxy or server trouble, time limit, rate limit: keep the answers and retry later.
  if (res.status >= 500 || res.status === 429 || res.status === 408) return { kind: 'offline' };
  return { kind: 'error' };
}

export type PhotoUploadResult =
  | { kind: 'stored' }
  | { kind: 'offline' }
  | { kind: 'closed' | 'not_yet_open' | 'full' }
  /** Gated surveys take photos only with a valid code. */
  | { kind: 'code_unknown' | 'code_required' | 'course_closed' }
  | { kind: 'invalid' };

const PHOTO_TIMEOUT_MS = 90_000;

/** Sends one photo before the answers that refer to it. Resends of a stored photo succeed. */
export async function uploadPhoto(surveyId: string, photoId: string, blob: Blob, code?: string): Promise<PhotoUploadResult> {
  let res: Response;
  const headers: Record<string, string> = { 'Content-Type': 'image/jpeg', Accept: 'application/json' };
  if (code) headers['X-Access-Code'] = code;
  try {
    res = await fetch(`/api/surveys/${encodeURIComponent(surveyId)}/photos/${photoId}`, {
      method: 'PUT',
      headers,
      body: blob,
      cache: 'no-store',
      signal: timeoutSignal(PHOTO_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'offline' };
  }
  if (res.status === 201 || res.status === 200) {
    try {
      const body = (await res.json()) as { status?: string };
      if (body.status === 'stored' || body.status === 'exists') return { kind: 'stored' };
    } catch {
      /* fall through */
    }
    return { kind: 'offline' };
  }
  if (res.status === 409) {
    const { error } = await errorOf(res);
    if (error === 'closed' || error === 'not_yet_open' || error === 'full' || error === 'course_closed') return { kind: error };
    return { kind: 'offline' };
  }
  if (res.status === 422) {
    const { error } = await errorOf(res);
    if (error === 'code_unknown' || error === 'code_required') return { kind: error };
    return { kind: 'invalid' };
  }
  if (res.status === 413 || res.status === 415 || res.status === 400) return { kind: 'invalid' };
  return { kind: 'offline' };
}
