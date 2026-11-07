import { randomInt } from 'node:crypto';
import { fieldsOf, type AnswerValue, type Answers, type Field, type SurveyDefinition } from '../shared/schema.ts';
import type { StoredResponse } from './db.ts';

/** Fisher–Yates shuffle with a cryptographic random source. */
export function shuffled<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface FieldInfo {
  key: string;
  type: Field['item']['type'];
  sectionId: string;
  sectionTitle: string;
  itemId: string;
  text: string;
  column?: string;
}

export interface ScaleSummary {
  kind: 'scale';
  key: string;
  answered: number;
  missing: number;
  notApplicable: number;
  counts: { value: number; label: string; count: number }[];
  mean: number | null;
  median: number | null;
}

export interface ChoiceSummary {
  kind: 'choice';
  key: string;
  answered: number;
  missing: number;
  counts: { option: string; count: number }[];
}

export interface TextSummary {
  kind: 'text';
  key: string;
  answered: number;
  missing: number;
  values: string[];
}

export type FieldSummary = ScaleSummary | ChoiceSummary | TextSummary;

export function fieldInfos(def: SurveyDefinition): FieldInfo[] {
  const titles = new Map(def.sections.map((s) => [s.id, s.title]));
  return fieldsOf(def).map((f) => ({
    key: f.key,
    type: f.item.type,
    sectionId: f.sectionId,
    sectionTitle: titles.get(f.sectionId) ?? f.sectionId,
    itemId: f.item.id,
    text: f.item.text,
    column: f.column?.label,
  }));
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(x: number | null, digits = 2): number | null {
  if (x === null) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function summarize(def: SurveyDefinition, rows: StoredResponse[]): FieldSummary[] {
  return fieldsOf(def).map((field): FieldSummary => {
    const values = rows.map((r) => r.answers[field.key]).filter((v): v is AnswerValue => v !== undefined);
    const missing = rows.length - values.length;
    const item = field.item;
    if (item.type === 'scale' || item.type === 'matrix') {
      const scale = def.scales[item.scale];
      const numbers = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
      const na = values.filter((v) => typeof v === 'string').length;
      return {
        kind: 'scale',
        key: field.key,
        answered: values.length,
        missing,
        notApplicable: na,
        counts: scale.options.map((o) => ({ value: o.value, label: o.label, count: numbers.filter((n) => n === o.value).length })),
        mean: numbers.length ? round(numbers.reduce((a, b) => a + b, 0) / numbers.length) : null,
        median: median(numbers),
      };
    }
    if (item.type === 'choice') {
      const flat = values.flatMap((v) => (Array.isArray(v) ? v : [v])).map(String);
      return {
        kind: 'choice',
        key: field.key,
        answered: values.length,
        missing,
        counts: item.options.map((o) => ({ option: o, count: flat.filter((x) => x === o).length })),
      };
    }
    // Free texts are shuffled per question, so their order cannot be matched with rating rows.
    return {
      kind: 'text',
      key: field.key,
      answered: values.length,
      missing,
      values: shuffled(values.map(String)),
    };
  });
}

/** Keys of free-text fields; their answers are only ever shown separately from ratings. */
export function textKeys(def: SurveyDefinition): string[] {
  return fieldsOf(def)
    .filter((f) => f.item.type === 'text')
    .map((f) => f.key);
}

/** Column keys for rating exports: all current fields except free texts. */
export function exportKeys(def: SurveyDefinition): string[] {
  return fieldsOf(def)
    .filter((f) => f.item.type !== 'text')
    .map((f) => f.key);
}

/**
 * Rows without free-text answers (and without keys of older versions, which could be texts),
 * and without the survey version (which could mark single answers).
 */
export function ratingRows(def: SurveyDefinition, rows: StoredResponse[]): { course: string | null; answers: Answers }[] {
  const keys = exportKeys(def);
  return rows.map((r) => {
    const answers: Answers = {};
    for (const k of keys) if (Object.hasOwn(r.answers, k)) answers[k] = r.answers[k];
    return { course: r.course, answers };
  });
}

/** Free-text answers per question, each list shuffled independently. */
export function textsByKey(def: SurveyDefinition, rows: StoredResponse[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of textKeys(def)) {
    out[key] = shuffled(rows.map((r) => r.answers[key]).filter((v): v is string => typeof v === 'string' && v.length > 0));
  }
  return out;
}

export function cellText(v: AnswerValue | undefined): string {
  if (v === undefined) return '';
  if (Array.isArray(v)) return v.join('|');
  return String(v);
}

/** Byte order mark so spreadsheet programs detect UTF-8. */
const BOM = '\uFEFF';

export function csvField(input: string): string {
  // Spreadsheet formula prefixes are neutralised so a free-text answer cannot run as a formula.
  if ((/^[\s\u0000-\u001f]*[=+@-]/u.test(input) && !/^-?\d+(\.\d+)?$/.test(input)) || /^[\t\r]/.test(input)) input = "'" + input;
  return /[",\r\n]/.test(input) ? `"${input.replace(/"/g, '""')}"` : input;
}

/** Ratings as CSV: one row per response, no free texts, no dates. */
export function buildCsv(def: SurveyDefinition, rows: StoredResponse[]): string {
  const keys = exportKeys(def);
  const withCourse = def.accessCodes !== undefined || rows.some((r) => r.course);
  // No survey version per row: a version change during a course would mark single answers.
  const header = ['response', ...(withCourse ? ['course'] : []), ...keys];
  const lines = [header.map(csvField).join(',')];
  rows.forEach((r, i) => {
    const course = withCourse ? [r.course ?? ''] : [];
    lines.push([String(i + 1), ...course, ...keys.map((k) => cellText(r.answers[k]))].map(csvField).join(','));
  });
  return BOM + lines.join('\r\n') + '\r\n';
}

/** Free texts as CSV: question key, question, text; shuffled per question. */
export function textsCsv(def: SurveyDefinition, rows: StoredResponse[]): string {
  const texts = textsByKey(def, rows);
  const questions = new Map(fieldsOf(def).map((f) => [f.key, f.item.text.replace(/\*\*/g, '')]));
  const lines = [['question_key', 'question', 'text'].map(csvField).join(',')];
  for (const [key, values] of Object.entries(texts)) {
    for (const v of values) lines.push([key, questions.get(key) ?? key, v].map(csvField).join(','));
  }
  return BOM + lines.join('\r\n') + '\r\n';
}
