import type { FieldSummary, ResponsesResponse } from './types.ts';

/** Builds the Excel workbook in the browser; SheetJS is loaded only when needed. */
export async function downloadXlsx(data: ResponsesResponse, summary: FieldSummary[], suffix = ''): Promise<void> {
  const XLSX = await import('xlsx');
  const withCourse = data.rows.some((r) => r.course);
  const header = ['response', 'survey_version', 'submitted_on', ...(withCourse ? ['course'] : []), ...data.keys];
  const rows = data.rows.map((r, i) => [
    i + 1,
    r.surveyVersion,
    r.submittedOn,
    ...(withCourse ? [r.course ?? ''] : []),
    ...data.keys.map((k) => {
      const v = r.answers[k];
      if (v === undefined) return null;
      return Array.isArray(v) ? v.join('|') : v;
    }),
  ]);
  const wb = XLSX.utils.book_new();
  const answersSheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  XLSX.utils.book_append_sheet(wb, answersSheet, 'Antworten');

  const questions = data.fields.map((f) => [f.key, f.sectionTitle, f.itemId, f.text.replace(/\*\*/g, ''), f.column ?? '', f.type]);
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['key', 'section', 'item', 'text', 'column', 'type'], ...questions]),
    'Fragen',
  );

  const scaleRows = summary
    .filter((s): s is Extract<FieldSummary, { kind: 'scale' }> => s.kind === 'scale')
    .map((s) => [s.key, s.answered, s.missing, s.notApplicable, s.mean, s.median, ...s.counts.map((c) => c.count)]);
  const first = summary.find((s): s is Extract<FieldSummary, { kind: 'scale' }> => s.kind === 'scale');
  if (first) {
    const head = ['key', 'answered', 'missing', 'not_applicable', 'mean', 'median', ...first.counts.map((c) => `n_${c.value}`)];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...scaleRows]), 'Übersicht');
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

/** Excel workbook of app records: one sheet per collection. */
export async function downloadRecordsXlsx(
  appId: string,
  records: { collection: string; receivedOn: string; data: unknown }[],
  table: (r: typeof records) => { header: string[]; rows: string[][] },
): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const collections = [...new Set(records.map((r) => r.collection))].sort();
  for (const c of collections) {
    const { header, rows } = table(records.filter((r) => r.collection === c));
    const name = c.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'records';
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), name);
  }
  if (collections.length === 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['record', 'collection', 'received_on']]), 'records');
  XLSX.writeFile(wb, `${appId}_records.xlsx`, { compression: true });
}
