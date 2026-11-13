import type { Answers, SurveyDefinition } from '../../shared/schema.ts';

export interface FieldInfo {
  key: string;
  type: 'scale' | 'matrix' | 'text' | 'choice' | 'photo';
  sectionId: string;
  sectionTitle: string;
  itemId: string;
  text: string;
  column?: string;
}

export type FieldSummary =
  | {
      kind: 'scale';
      key: string;
      answered: number;
      missing: number;
      notApplicable: number;
      counts: { value: number; label: string; count: number }[];
      mean: number | null;
      median: number | null;
    }
  | { kind: 'choice'; key: string; answered: number; missing: number; counts: { option: string; count: number }[] }
  /** Free texts arrive already shuffled per question and are never shown beside ratings. */
  | { kind: 'text'; key: string; answered: number; missing: number; values: string[] }
  | { kind: 'photo'; key: string; answered: number; missing: number; photos: number };

export type SurveyStatus = 'open' | 'closed' | 'not_yet_open';

/** A course as organisers see it. Its results are released only when it is closed and has at least `minGroup` responses. */
export interface CourseInfo {
  id: string;
  /** Name of the event, entered by the organiser. */
  label: string;
  /** First day of the event, YYYY-MM-DD. */
  eventDate: string;
  /** Last day of a multi-day event, YYYY-MM-DD, or null. */
  eventDateEnd: string | null;
  closed: boolean;
  codes: number;
  /** Exact only for closed courses (null while open: no live counts). */
  used: number | null;
  revoked: number;
  /** Exact only for closed courses (null while open). */
  responses: number | null;
  /** While open: whether at least the minimum group size has answered. */
  responsesBand?: 'belowMin' | 'atLeastMin' | null;
  released: boolean;
}

/** A code as organisers see it: whether it is blocked, never whether it was used. */
export interface CodeInfo {
  code: string;
  revoked: boolean;
}

/** Answer of POST courses and POST courses/<id>/codes. */
export interface CreatedCodes {
  course: { id: string; label: string; eventDate: string; eventDateEnd: string | null };
  codes: string[];
}

export interface SummaryResponse {
  survey: {
    id: string;
    version: number;
    title: string;
    subtitle: string | null;
    status: SurveyStatus;
    opensAt?: string | null;
    closesAt?: string | null;
    url: string;
  };
  definition: SurveyDefinition;
  /** Smallest group whose results are shown (k-anonymity), 5. */
  minGroup: number;
  /** Whether a printable questionnaire (paper.pdf) is available for download. */
  paperPdf?: boolean;
  /** Whether a manual for this administration page (manual.pdf) is available for download. */
  manualPdf?: boolean;
  /** Signed-in role: 'global' (administration) or 'survey' (course lead). */
  role?: 'global' | 'survey';
  /** Whether the data of this view are released. */
  released: boolean;
  /** Responses in this view (0 when not released). */
  responses: number;
  course: string | null;
  courses: CourseInfo[];
  fields: FieldInfo[];
  summary: FieldSummary[];
}

export interface ResponsesResponse {
  survey: { id: string; version: number; title: string };
  /** Keys of the rated / chosen answers; free-text keys are listed in `textKeys` only. */
  keys: string[];
  textKeys: string[];
  fields: FieldInfo[];
  /** One row per response, without free texts and without any date. */
  rows: { surveyVersion: number; course: string | null; answers: Answers }[];
  /** Free texts per question, shuffled, not linked to rows. */
  texts: Record<string, string[]>;
}
