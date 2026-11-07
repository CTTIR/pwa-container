// Full data access for a survey's own administration: single responses (ratings and free texts),
// filtered by course, version and field, as JSON, CSV or R data file (RDS). Everything here works
// on the rows of one survey only; the caller has already checked the sign-in for that survey.
import { gzipSync } from 'node:zlib';
import { fieldsOf, type AnswerValue, type Answers, type SurveyDefinition } from '../shared/schema.ts';

export interface RawRow {
  surveyVersion: number;
  courseId: string | null;
  course: string | null;
  answers: Answers;
}

export interface CodebookEntry {
  key: string;
  /** scale, matrix, choice, text; "unknown" for keys of older versions that are no longer asked. */
  type: 'scale' | 'matrix' | 'choice' | 'text' | 'unknown';
  section: string | null;
  text: string | null;
  column: string | null;
  /** Rating values with labels (scale, matrix). */
  values?: { value: number; label: string }[];
  /** Stored value for "not applicable" (e.g. "NB"), if the scale has one. */
  notApplicable?: { value: string; label: string } | null;
  /** Options of a choice item. */
  options?: string[];
  multiple?: boolean;
}

export interface DataFilter {
  courses?: (string | null)[];
  versions?: number[];
  fields?: string[];
}

export interface Dataset {
  survey: { id: string; title: string; version: number };
  filter: { courses: (string | null)[] | null; versions: number[] | null; fields: string[] | null };
  codebook: CodebookEntry[];
  /** Fixed columns first, then the answer keys in codebook order. */
  columns: string[];
  rows: { response: number; surveyVersion: number; course: string | null; answers: Answers }[];
}

const plain = (text: string) => text.replace(/\*\*/g, '');

/** Separator of multiple-choice answers in every export format (CSV, XLSX, RDS). */
export const MULTI_SEPARATOR = '|';

/** Codebook of the current definition plus keys that only older versions used. */
export function codebook(def: SurveyDefinition, rows: RawRow[]): CodebookEntry[] {
  const titles = new Map(def.sections.map((s) => [s.id, s.title]));
  const entries: CodebookEntry[] = fieldsOf(def).map((f) => {
    const item = f.item;
    const base = { key: f.key, type: item.type, section: titles.get(f.sectionId) ?? f.sectionId, text: plain(item.text), column: f.column?.label ?? null };
    if (item.type === 'scale' || item.type === 'matrix') {
      const scale = def.scales[item.scale];
      return { ...base, values: scale.options.map((o) => ({ value: o.value, label: o.label })), notApplicable: scale.notApplicable ?? null };
    }
    if (item.type === 'choice') return { ...base, options: [...item.options], multiple: !!item.multiple };
    return base;
  });
  const known = new Set(entries.map((e) => e.key));
  const extra = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.answers)) if (!known.has(k)) extra.add(k);
  for (const key of [...extra].sort()) entries.push({ key, type: 'unknown', section: null, text: null, column: null });
  return entries;
}

export function buildDataset(def: SurveyDefinition, raw: RawRow[], filter: DataFilter): Dataset {
  let book = codebook(def, raw);
  if (filter.fields) {
    const wanted = new Set(filter.fields);
    book = book.filter((e) => wanted.has(e.key));
  }
  const keys = book.map((e) => e.key);
  return {
    survey: { id: def.id, title: def.title, version: def.version },
    filter: { courses: filter.courses ?? null, versions: filter.versions ?? null, fields: filter.fields ?? null },
    codebook: book,
    columns: ['response', 'survey_version', 'course', ...keys],
    rows: raw.map((r, i) => {
      const answers: Answers = {};
      for (const k of keys) if (Object.hasOwn(r.answers, k)) answers[k] = r.answers[k];
      return { response: i + 1, surveyVersion: r.surveyVersion, course: r.course, answers };
    }),
  };
}

// ---- CSV ----

/** Byte order mark so spreadsheet programs detect UTF-8. */
const BOM = '﻿';

function cellText(v: AnswerValue | null | undefined): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.join(MULTI_SEPARATOR);
  return String(v);
}

/** One CSV field: formula prefixes neutralised (free texts must not run as formulas), quoted when needed. */
export function csvCell(input: string, sep: ',' | ';'): string {
  if ((/^[\s\u0000-\u001f]*[=+@-]/u.test(input) && !/^-?\d+(\.\d+)?$/.test(input)) || /^[\t\r]/.test(input)) input = "'" + input;
  return input.includes(sep) || /["\r\n]/.test(input) ? `"${input.replace(/"/g, '""')}"` : input;
}

export function datasetCsv(data: Dataset, sep: ',' | ';'): string {
  const keys = data.codebook.map((e) => e.key);
  const lines = [data.columns.map((c) => csvCell(c, sep)).join(sep)];
  for (const r of data.rows) {
    const cells = [String(r.response), String(r.surveyVersion), r.course ?? '', ...keys.map((k) => cellText(r.answers[k]))];
    lines.push(cells.map((c) => csvCell(c, sep)).join(sep));
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

export function codebookCsv(data: Dataset, sep: ',' | ';'): string {
  const header = ['key', 'type', 'section', 'question', 'column', 'values', 'not_applicable', 'options', 'multiple'];
  const lines = [header.join(sep)];
  for (const e of data.codebook) {
    const cells = [
      e.key,
      e.type,
      e.section ?? '',
      e.text ?? '',
      e.column ?? '',
      e.values ? e.values.map((v) => `${v.value}=${v.label}`).join(' | ') : '',
      e.notApplicable ? `${e.notApplicable.value}=${e.notApplicable.label}` : '',
      e.options ? e.options.join(' | ') : '',
      e.multiple === undefined ? '' : String(e.multiple),
    ];
    lines.push(cells.map((c) => csvCell(c, sep)).join(sep));
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

// ---- RDS (R serialization format, version 3, XDR, gzip) ----

const NILVALUE = 254;
const SYMSXP = 1;
const LISTSXP = 2;
const CHARSXP = 9;
const INTSXP = 13;
const REALSXP = 14;
const STRSXP = 16;
const VECSXP = 19;
const NA_INTEGER = -2147483648;
const UTF8_MASK = 1 << 3;
const ASCII_MASK = 1 << 6;

type RValue =
  | { kind: 'int'; values: (number | null)[]; attrs?: RAttr[] }
  | { kind: 'real'; values: (number | null)[]; attrs?: RAttr[] }
  | { kind: 'str'; values: (string | null)[]; attrs?: RAttr[] }
  | { kind: 'list'; values: RValue[]; attrs?: RAttr[] };
type RAttr = [string, RValue];

/** Big-endian writer into one growing buffer (no allocation per value). */
class XdrWriter {
  private buf = Buffer.alloc(64 * 1024);
  private len = 0;
  private room(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = Buffer.alloc(size);
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  int(n: number): void {
    this.room(4);
    this.buf.writeInt32BE(n, this.len);
    this.len += 4;
  }
  real(n: number | null): void {
    this.room(8);
    if (n === null) {
      // R's NA_real_: a NaN with low word 1954.
      this.buf.writeUInt32BE(0x7ff00000, this.len);
      this.buf.writeUInt32BE(1954, this.len + 4);
    } else this.buf.writeDoubleBE(n, this.len);
    this.len += 8;
  }
  bytes(b: Buffer): void {
    this.room(b.length);
    b.copy(this.buf, this.len);
    this.len += b.length;
  }
  result(): Buffer {
    return this.buf.subarray(0, this.len);
  }
}

function flags(type: number, opts: { object?: boolean; attr?: boolean; tag?: boolean; levels?: number } = {}): number {
  return type | (opts.object ? 1 << 8 : 0) | (opts.attr ? 1 << 9 : 0) | (opts.tag ? 1 << 10 : 0) | ((opts.levels ?? 0) << 12);
}

function writeChar(w: XdrWriter, s: string | null): void {
  if (s === null) {
    w.int(flags(CHARSXP));
    w.int(-1);
    return;
  }
  const b = Buffer.from(s, 'utf8');
  // eslint-disable-next-line no-control-regex
  w.int(flags(CHARSXP, { levels: /^[\x00-\x7f]*$/.test(s) ? ASCII_MASK : UTF8_MASK }));
  w.int(b.length);
  w.bytes(b);
}

function writeValue(w: XdrWriter, v: RValue): void {
  const attrs = v.attrs ?? [];
  const object = attrs.some(([name]) => name === 'class');
  const opt = { attr: attrs.length > 0, object };
  switch (v.kind) {
    case 'int':
      w.int(flags(INTSXP, opt));
      w.int(v.values.length);
      for (const x of v.values) w.int(x === null ? NA_INTEGER : x);
      break;
    case 'real':
      w.int(flags(REALSXP, opt));
      w.int(v.values.length);
      for (const x of v.values) w.real(x);
      break;
    case 'str':
      w.int(flags(STRSXP, opt));
      w.int(v.values.length);
      for (const x of v.values) writeChar(w, x);
      break;
    case 'list':
      w.int(flags(VECSXP, opt));
      w.int(v.values.length);
      for (const x of v.values) writeValue(w, x);
      break;
  }
  if (attrs.length) {
    for (const [name, value] of attrs) {
      w.int(flags(LISTSXP, { tag: true }));
      w.int(SYMSXP);
      writeChar(w, name);
      writeValue(w, value);
    }
    w.int(NILVALUE);
  }
}

/** Serialises an R object as an RDS file (gzip, like saveRDS()). */
export function rds(value: RValue): Buffer {
  const w = new XdrWriter();
  w.bytes(Buffer.from('X\n', 'latin1'));
  w.int(3); // serialization format version
  w.int((4 << 16) | (4 << 8) | 0); // written "by" R 4.4.0
  w.int((3 << 16) | (5 << 8) | 0); // readable from R 3.5.0
  const enc = Buffer.from('UTF-8', 'latin1');
  w.int(enc.length);
  w.bytes(enc);
  writeValue(w, value);
  return gzipSync(w.result());
}

const str = (values: (string | null)[], attrs?: RAttr[]): RValue => ({ kind: 'str', values, attrs });
const label = (e: CodebookEntry): RAttr[] => {
  const text = [e.text, e.column].filter(Boolean).join(' – ');
  return text ? [['label', str([text])]] : [];
};

/** One answer column as an R vector: ratings as integers (not applicable = NA) with value labels, single choices as factors. */
function rColumn(e: CodebookEntry, values: (AnswerValue | undefined)[]): RValue {
  if (e.type === 'scale' || e.type === 'matrix') {
    const ints = values.map((v) => (typeof v === 'number' && Number.isInteger(v) ? v : null));
    const attrs = label(e);
    if (e.values?.length) {
      attrs.push(['labels', { kind: 'int', values: e.values.map((x) => x.value), attrs: [['names', str(e.values.map((x) => x.label))]] }]);
    }
    return { kind: 'int', values: ints, attrs };
  }
  if (e.type === 'choice' && !e.multiple) {
    const levels = [...(e.options ?? [])];
    for (const v of values) if (typeof v === 'string' && !levels.includes(v)) levels.push(v);
    const codes = values.map((v) => (typeof v === 'string' ? levels.indexOf(v) + 1 : null));
    return { kind: 'int', values: codes, attrs: [...label(e), ['levels', str(levels)], ['class', str(['factor'])]] };
  }
  if (e.type === 'unknown' && values.every((v) => v === undefined || typeof v === 'number')) {
    return { kind: 'real', values: values.map((v) => (typeof v === 'number' ? v : null)), attrs: label(e) };
  }
  return { kind: 'str', values: values.map((v) => (v === undefined ? null : Array.isArray(v) ? v.join(MULTI_SEPARATOR) : String(v))), attrs: label(e) };
}

/** The dataset as an R data.frame (one row per response), readable with readRDS(). */
export function datasetRds(data: Dataset): Buffer {
  const n = data.rows.length;
  const columns: RValue[] = [
    { kind: 'int', values: data.rows.map((r) => r.response), attrs: [['label', str(['Laufende Nummer (zufällige Reihenfolge)'])]] },
    { kind: 'int', values: data.rows.map((r) => r.surveyVersion), attrs: [['label', str(['Version des Fragebogens'])]] },
    str(
      data.rows.map((r) => r.course),
      [['label', str(['Kurs'])]],
    ),
    ...data.codebook.map((e) =>
      rColumn(
        e,
        data.rows.map((r) => r.answers[e.key]),
      ),
    ),
  ];
  return rds({
    kind: 'list',
    values: columns,
    attrs: [
      ['names', str(data.columns)],
      ['class', str(['data.frame'])],
      ['row.names', { kind: 'int', values: [null, -n] }],
      ['survey', str([data.survey.id])],
    ],
  });
}

// ---- request parameters ----

const COURSE_ID = /^k[0-9a-f]{10}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Parses the filter of a data request; returns an error text for malformed input. */
export function parseFilter(params: URLSearchParams): DataFilter | string {
  const list = (name: string) => {
    const v = params.get(name);
    if (v === null) return undefined;
    // Present but empty: an explicitly empty selection, which selects nothing.
    if (v === '') return [];
    const parts = v.split(',');
    return parts.length > 500 ? null : parts;
  };
  const filter: DataFilter = {};
  const courses = list('courses');
  if (courses === null) return 'too many courses';
  if (courses) {
    if (!courses.every((c) => c === 'none' || COURSE_ID.test(c))) return 'invalid course id';
    filter.courses = courses.map((c) => (c === 'none' ? null : c));
  }
  const versions = list('versions');
  if (versions === null) return 'too many versions';
  if (versions) {
    if (!versions.every((v) => /^[1-9][0-9]{0,5}$/.test(v))) return 'invalid version';
    filter.versions = versions.map(Number);
  }
  const fields = list('fields');
  if (fields === null) return 'too many fields';
  if (fields) {
    if (!fields.every((f) => KEY.test(f))) return 'invalid field key';
    filter.fields = fields;
  }
  return filter;
}
