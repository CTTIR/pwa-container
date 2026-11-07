import type { RecordRow } from '../../shared/records.ts';
import type { FieldSummary, ResponsesResponse } from './types.ts';

/** Excel's limit per cell; longer text is cut and marked. */
export const MAX_CELL_CHARS = 32_767;
const CUT_MARKER = ' … [gekürzt]';

type Cell = string | number | null;

/** Cuts a string to at most `max` UTF-16 units without splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** Text that fits into one Excel cell; longer text ends with a visible marker. */
export function fitCell(s: string): string {
  return s.length <= MAX_CELL_CHARS ? s : cut(s, MAX_CELL_CHARS - CUT_MARKER.length) + CUT_MARKER;
}

function cellOf(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'string') return fitCell(v);
  if (Array.isArray(v)) return fitCell(v.join('|'));
  return fitCell(typeof v === 'boolean' ? String(v) : JSON.stringify(v));
}

/**
 * Returns a namer that yields valid, unique sheet names: no \ / ? * [ ] :, no leading or trailing
 * apostrophe, at most 31 characters, unique ignoring case, and never Excel's reserved "History".
 */
export function sheetNamer(): (wanted: string) => string {
  const used = new Set<string>();
  const clean = (s: string) => s.replace(/^'+|'+$/g, '');
  return (wanted) => {
    let base = clean(wanted.replace(/[\\/?*[\]:\u0000-\u001f]/g, '_').trim()) || 'Tabelle';
    if (base.toLowerCase() === 'history') base = `${base}_`;
    base = clean(cut(base, 31)) || 'Tabelle';
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()) || name.toLowerCase() === 'history'; n += 1) {
      const suffix = ` (${n})`;
      name = clean(cut(base, 31 - suffix.length)) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  };
}

const plain = (text: string) => text.replace(/\*\*/g, '');

/**
 * Builds the results workbook in the browser (SheetJS is loaded only when needed): one row per
 * response with ratings only, the free texts on their own sheet, the questions and a summary.
 * No sheet contains a date.
 */
export async function downloadXlsx(data: ResponsesResponse, summary: FieldSummary[], suffix = ''): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const name = sheetNamer();
  const add = (rows: Cell[][], sheet: string) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name(sheet));

  const textKeys = new Set([...data.textKeys, ...data.fields.filter((f) => f.type === 'text').map((f) => f.key)]);
  const keys = data.keys.filter((k) => !textKeys.has(k));
  const withCourse = data.rows.some((r) => r.course);
  const header = ['response', 'survey_version', ...(withCourse ? ['course'] : []), ...keys];
  const rows = data.rows.map((r, i): Cell[] => [
    i + 1,
    r.surveyVersion,
    ...(withCourse ? [cellOf(r.course ?? '')] : []),
    ...keys.map((k) => cellOf(r.answers[k])),
  ]);
  add([header.map(fitCell), ...rows], 'Bewertungen');

  const fieldByKey = new Map(data.fields.map((f) => [f.key, f]));
  const textList = data.textKeys.length ? data.textKeys : [...textKeys];
  if (textList.length) {
    const textRows: Cell[][] = [];
    for (const key of textList) {
      const f = fieldByKey.get(key);
      const question = f ? plain(f.text) + (f.column ? ` – ${f.column}` : '') : key;
      for (const t of data.texts[key] ?? []) textRows.push([key, fitCell(question), fitCell(t)]);
    }
    add([['question_key', 'question', 'text'], ...textRows], 'Freitexte');
  }

  const questions = data.fields.map((f): Cell[] => [f.key, f.sectionTitle, f.itemId, fitCell(plain(f.text)), f.column ?? '', f.type]);
  add([['key', 'section', 'item', 'text', 'column', 'type'], ...questions], 'Fragen');

  const scales = summary.filter((s): s is Extract<FieldSummary, { kind: 'scale' }> => s.kind === 'scale');
  if (scales.length) {
    const head = ['key', 'answered', 'missing', 'not_applicable', 'mean', 'median', ...scales[0].counts.map((c) => `n_${c.value}`)];
    add([head, ...scales.map((s): Cell[] => [s.key, s.answered, s.missing, s.notApplicable, s.mean, s.median, ...s.counts.map((c) => c.count)])], 'Übersicht');
  }
  XLSX.writeFile(wb, `${data.survey.id}${suffix}_responses.xlsx`, { compression: true });
}

export function saveBlob(content: string, type: string, filename: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(data: ResponsesResponse, suffix = ''): void {
  saveBlob(JSON.stringify(data, null, 2), 'application/json', `${data.survey.id}${suffix}_responses.json`);
}

/** Excel workbook of app records: one sheet per collection, no date column. */
export async function downloadRecordsXlsx(
  appId: string,
  records: RecordRow[],
  table: (r: RecordRow[]) => { header: string[]; rows: string[][] },
): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const name = sheetNamer();
  const collections = [...new Set(records.map((r) => r.collection))].sort();
  for (const c of collections) {
    const { header, rows } = table(records.filter((r) => r.collection === c));
    const sheet = [header, ...rows].map((row) => row.map(fitCell));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), name(c || 'records'));
  }
  if (collections.length === 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['record', 'collection']]), name('records'));
  XLSX.writeFile(wb, `${appId}_records.xlsx`, { compression: true });
}
