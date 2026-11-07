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
  | { kind: 'invalid' }
  | { kind: 'error' };

export async function submitAnswers(id: string, submissionId: string, surveyVersion: number, answers: Answers): Promise<SubmitResult> {
  let res: Response;
  try {
    res = await fetch(`/api/surveys/${encodeURIComponent(id)}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ submissionId, surveyVersion, answers }),
      cache: 'no-store',
    });
  } catch {
    return { kind: 'offline' };
  }
  if (res.status === 201 || res.status === 200) return { kind: 'stored' };
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === 'closed' || body.error === 'not_yet_open' || body.error === 'full') return { kind: body.error };
    return { kind: 'error' };
  }
  if (res.status === 422) return { kind: 'invalid' };
  // Proxy or server trouble: keep the answers and retry later.
  if (res.status >= 500 || res.status === 429 || res.status === 408) return { kind: 'offline' };
  return { kind: 'error' };
}
