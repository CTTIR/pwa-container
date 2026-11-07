import { fieldsOf, type AnswerValue, type Field, type SurveyDefinition } from '../shared/schema.ts';
import type { StoredRecord, StoredResponse } from './db.ts';
import { recordsTable } from '../shared/records.ts';

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
    return {
      kind: 'text',
      key: field.key,
      answered: values.length,
      missing,
      values: values.map(String),
    };
  });
}

/** Column keys for exports: current fields first, then keys only found in older versions. */
export function exportKeys(def: SurveyDefinition, rows: StoredResponse[]): string[] {
  const keys = fieldsOf(def).map((f) => f.key);
  const known = new Set(keys);
  for (const r of rows) {
    for (const k of Object.keys(r.answers)) {
      if (!known.has(k)) {
        known.add(k);
        keys.push(k);
      }
    }
  }
  return keys;
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
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(input) && !/^-?\d+(\.\d+)?$/.test(input)) input = "'" + input;
  return /[",\r\n]/.test(input) ? `"${input.replace(/"/g, '""')}"` : input;
}

export function buildCsv(def: SurveyDefinition, rows: StoredResponse[]): string {
  const keys = exportKeys(def, rows);
  const withCourse = def.accessCodes !== undefined || rows.some((r) => r.course);
  const header = ['response', 'survey_version', 'submitted_on', ...(withCourse ? ['course'] : []), ...keys];
  const lines = [header.map(csvField).join(',')];
  rows.forEach((r, i) => {
    const course = withCourse ? [r.course ?? ''] : [];
    lines.push([String(i + 1), String(r.surveyVersion), r.submittedOn, ...course, ...keys.map((k) => cellText(r.answers[k]))].map(csvField).join(','));
  });
  return BOM + lines.join('\r\n') + '\r\n';
}

export function recordsCsv(records: StoredRecord[]): string {
  const { header, rows } = recordsTable(records);
  return BOM + [header, ...rows].map((line) => line.map(csvField).join(',')).join('\r\n') + '\r\n';
}
