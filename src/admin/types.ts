import type { Answers, SurveyDefinition } from '../../shared/schema.ts';

export interface FieldInfo {
  key: string;
  type: 'scale' | 'matrix' | 'text' | 'choice';
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
  | { kind: 'text'; key: string; answered: number; missing: number; values: string[] };

export interface SummaryResponse {
  survey: {
    id: string;
    version: number;
    title: string;
    subtitle: string | null;
    status: 'open' | 'closed' | 'not_yet_open';
    opensAt: string | null;
    closesAt: string | null;
  };
  definition: SurveyDefinition;
  responses: number;
  fields: FieldInfo[];
  summary: FieldSummary[];
}

export interface ResponsesResponse {
  survey: { id: string; version: number; title: string };
  keys: string[];
  fields: FieldInfo[];
  rows: { surveyVersion: number; submittedOn: string; answers: Answers }[];
}
