import type { Answers, SurveyDefinition, SurveyStatus } from '../shared/schema.ts';

export interface SurveyResponse {
  definition: SurveyDefinition;
  status: SurveyStatus;
  opensAt: string | null;
  closesAt: string | null;
}

export type LoadResult =
  | { kind: 'ok'; data: SurveyResponse }
  | { kind: 'not_found' }
  | { kind: 'error' };

export async function loadSurvey(id: string): Promise<LoadResult> {
  try {
    const res = await fetch(`/api/surveys/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) return { kind: 'error' };
    return { kind: 'ok', data: (await res.json()) as SurveyResponse };
  } catch {
    return { kind: 'error' };
  }
}

export type SubmitResult =
  | { kind: 'stored' }
  | { kind: 'offline' }
  | { kind: 'closed' | 'not_yet_open' | 'full' }
  | { kind: 'code_unknown' | 'code_used' | 'code_required' }
  | { kind: 'invalid' }
  | { kind: 'error' };

export type CodeResult = { kind: 'ok'; course: string } | { kind: 'unknown' | 'used' | 'offline' };

export async function checkCode(id: string, code: string): Promise<CodeResult> {
  let res: Response;
  try {
    res = await fetch(`/api/surveys/${encodeURIComponent(id)}/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
    });
  } catch {
    return { kind: 'offline' };
  }
  if (res.ok) return { kind: 'ok', course: ((await res.json()) as { course: string }).course };
  if (res.status === 409) return { kind: 'used' };
  if (res.status === 404 || res.status === 400) return { kind: 'unknown' };
  return { kind: 'offline' };
}

export async function submitAnswers(id: string, submissionId: string, surveyVersion: number, answers: Answers, code?: string): Promise<SubmitResult> {
  let res: Response;
  try {
    res = await fetch(`/api/surveys/${encodeURIComponent(id)}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ submissionId, surveyVersion, answers, code }),
      cache: 'no-store',
    });
  } catch {
    return { kind: 'offline' };
  }
  if (res.status === 201 || res.status === 200) return { kind: 'stored' };
  if (res.status === 409 || res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const e = body.error;
    if (e === 'closed' || e === 'not_yet_open' || e === 'full' || e === 'code_used' || e === 'code_unknown' || e === 'code_required') {
      return { kind: e };
    }
    return res.status === 422 ? { kind: 'invalid' } : { kind: 'error' };
  }
  // Proxy or server trouble: keep the answers and retry later.
  if (res.status >= 500 || res.status === 429 || res.status === 408) return { kind: 'offline' };
  return { kind: 'error' };
}
