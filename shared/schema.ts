// Survey definition format and validation, shared by the server and the browser app.
// Only erasable TypeScript syntax is used so Node can run this file directly.

export type Locale = 'de' | 'en';

export interface ScaleOption {
  value: number;
  label: string;
}

export interface Scale {
  options: ScaleOption[];
  /** Optional "not applicable" choice, stored as its string value (e.g. "NB"). */
  notApplicable?: { value: string; label: string };
  /**
   * "buttons" (default): one button per option. "slider": a slider over the options, which must
   * be consecutive integers; every value is marked on the track.
   */
  display?: 'buttons' | 'slider';
}

/** Words at the low and high end of a scale, e.g. "unklar" … "eindeutig". */
export interface ScaleAnchors {
  min: string;
  max: string;
}

interface BaseItem {
  id: string;
  text: string;
  required?: boolean;
  hint?: string;
}

/** Optional free-text remark shown under a scale item, stored as its own text field. */
export interface ItemComment {
  /** Answer key of the remark; defaults to `<item id>_txt`. */
  id?: string;
  label: string;
  maxLength?: number;
}

export interface ScaleItem extends BaseItem {
  type: 'scale';
  scale: string;
  /** End words for this item; default: the labels of the scale's first and last option. */
  anchors?: ScaleAnchors;
  comment?: ItemComment;
}

export interface MatrixColumn {
  id: string;
  label: string;
}

/** One row rated on the same scale in several columns (e.g. before / after). */
export interface MatrixItem extends BaseItem {
  type: 'matrix';
  scale: string;
  columns: MatrixColumn[];
}

export interface TextItem extends BaseItem {
  type: 'text';
  multiline?: boolean;
  maxLength?: number;
  placeholder?: string;
}

export interface ChoiceItem extends BaseItem {
  type: 'choice';
  options: string[];
  multiple?: boolean;
}

export type Item = ScaleItem | MatrixItem | TextItem | ChoiceItem;

export interface Section {
  id: string;
  title: string;
  description?: string;
  /** Short label (e.g. a roman numeral) shown instead of the running section number. */
  label?: string;
  /** Scale whose full legend is shown above the section's items. */
  legendScale?: string;
  items: Item[];
}

export interface TextBlock {
  heading?: string;
  paragraphs: string[];
}

/** Text the participant must confirm (checkbox) before the start button is enabled. */
export interface ConfirmBlock extends TextBlock {
  /** Label of the checkbox, e.g. "Ich habe den Hinweis gelesen." */
  confirm: string;
}

export interface SurveyDefinition {
  id: string;
  version: number;
  locale: Locale;
  title: string;
  subtitle?: string;
  /** Short brand text in the page header, e.g. "ACME®". */
  brand?: string;
  theme?: string;
  footer?: string;
  /** Preferred subdomain label for this survey (used when it is first installed). */
  subdomain?: string;
  opensAt?: string;
  closesAt?: string;
  maxResponses?: number;
  /**
   * Single-use access codes per course. "required": every response needs an unused code and is
   * assigned to the code's course (the code itself is not stored with the response).
   */
  accessCodes?: 'required' | 'optional';
  intro: TextBlock;
  /** Shown at the top of the start page; the start button needs its checkbox ticked. */
  notice?: ConfirmBlock;
  privacy?: TextBlock;
  thanks: TextBlock;
  scales: Record<string, Scale>;
  sections: Section[];
  /** Show a menu on every section page to jump to any other section. */
  sectionNav?: boolean;
}

export type AnswerValue = number | string | string[];
export type Answers = Record<string, AnswerValue>;

export interface Field {
  /** Column / answer key, e.g. "ORG01" or "RET01_VOR". */
  key: string;
  item: Item;
  sectionId: string;
  column?: MatrixColumn;
  /** For the remark of a scale item: the id of that item. */
  parent?: string;
}

export const DEFAULT_TEXT_MAX = 1000;
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SURVEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
/** One DNS label: lowercase letters, digits and inner hyphens. */
export const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The text item that stores the remark of a scale item. */
export function commentItem(item: ScaleItem): TextItem {
  const c = item.comment!;
  return {
    id: c.id ?? `${item.id}_txt`,
    type: 'text',
    text: `${stripBold(item.text)} – ${c.label}`,
    multiline: true,
    maxLength: c.maxLength,
  };
}

function stripBold(text: string): string {
  return text.replace(/\*\*/g, '');
}

/** All answer fields of a survey in display order. */
export function fieldsOf(def: SurveyDefinition): Field[] {
  const out: Field[] = [];
  for (const section of def.sections) {
    for (const item of section.items) {
      if (item.type === 'matrix') {
        for (const column of item.columns) {
          out.push({ key: `${item.id}_${column.id}`, item, sectionId: section.id, column });
        }
      } else {
        out.push({ key: item.id, item, sectionId: section.id });
        if (item.type === 'scale' && item.comment) {
          const c = commentItem(item);
          out.push({ key: c.id, item: c, sectionId: section.id, parent: item.id });
        }
      }
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function checkTextBlock(v: unknown, where: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (v.heading !== undefined && typeof v.heading !== 'string') errors.push(`${where}.heading must be a string`);
  if (!Array.isArray(v.paragraphs) || !v.paragraphs.every((p) => typeof p === 'string')) {
    errors.push(`${where}.paragraphs must be an array of strings`);
  }
}

function checkDate(v: unknown, where: string, errors: string[]): void {
  if (v === undefined) return;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) errors.push(`${where} must be an ISO date string`);
}

/** Validates a parsed survey definition. Returns a list of problems (empty = valid). */
export function validateDefinition(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(raw)) return ['survey definition must be a JSON object'];
  const d = raw;
  if (typeof d.id !== 'string' || !SURVEY_ID_PATTERN.test(d.id)) {
    errors.push('id must match ' + SURVEY_ID_PATTERN.source);
  }
  if (!Number.isInteger(d.version) || (d.version as number) < 1) errors.push('version must be an integer >= 1');
  if (d.locale !== 'de' && d.locale !== 'en') errors.push('locale must be "de" or "en"');
  if (!isNonEmptyString(d.title)) errors.push('title is required');
  if (d.subdomain !== undefined && (typeof d.subdomain !== 'string' || !HOST_LABEL_PATTERN.test(d.subdomain) || d.subdomain.length < 3)) {
    errors.push('subdomain must be a lowercase DNS label of at least 3 characters');
  }
  for (const key of ['subtitle', 'brand', 'theme', 'footer'] as const) {
    if (d[key] !== undefined && typeof d[key] !== 'string') errors.push(`${key} must be a string`);
  }
  if (typeof d.theme === 'string' && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(d.theme)) {
    errors.push('theme must be a lowercase folder name');
  }
  checkDate(d.opensAt, 'opensAt', errors);
  checkDate(d.closesAt, 'closesAt', errors);
  if (d.maxResponses !== undefined && (!Number.isInteger(d.maxResponses) || (d.maxResponses as number) < 1)) {
    errors.push('maxResponses must be a positive integer');
  }
  if (d.accessCodes !== undefined && d.accessCodes !== 'required' && d.accessCodes !== 'optional') {
    errors.push('accessCodes must be "required" or "optional"');
  }
  checkTextBlock(d.intro, 'intro', errors);
  checkTextBlock(d.thanks, 'thanks', errors);
  if (d.privacy !== undefined) checkTextBlock(d.privacy, 'privacy', errors);
  if (d.sectionNav !== undefined && typeof d.sectionNav !== 'boolean') errors.push('sectionNav must be a boolean');
  if (d.notice !== undefined) {
    checkTextBlock(d.notice, 'notice', errors);
    if (!isRecord(d.notice) || !isNonEmptyString(d.notice.confirm)) errors.push('notice.confirm is required');
  }

  const scaleNames = new Set<string>();
  if (!isRecord(d.scales)) {
    errors.push('scales must be an object');
  } else {
    for (const [name, scale] of Object.entries(d.scales)) {
      scaleNames.add(name);
      if (!isRecord(scale) || !Array.isArray(scale.options) || scale.options.length < 2) {
        errors.push(`scale ${name} needs at least two options`);
        continue;
      }
      const values = new Set<number>();
      for (const o of scale.options) {
        if (!isRecord(o) || !Number.isFinite(o.value) || !isNonEmptyString(o.label)) {
          errors.push(`scale ${name} has an invalid option`);
        } else if (values.has(o.value as number)) {
          errors.push(`scale ${name} repeats value ${String(o.value)}`);
        } else {
          values.add(o.value as number);
        }
      }
      if (scale.display !== undefined && scale.display !== 'buttons' && scale.display !== 'slider') {
        errors.push(`scale ${name}.display must be "buttons" or "slider"`);
      }
      if (scale.display === 'slider') {
        const vals = scale.options.map((o) => (isRecord(o) ? o.value : NaN));
        if (!vals.every((v, i) => Number.isInteger(v) && (i === 0 || v === (vals[i - 1] as number) + 1))) {
          errors.push(`scale ${name}: a slider needs consecutive ascending integer values`);
        }
      }
      if (scale.notApplicable !== undefined) {
        const na = scale.notApplicable;
        if (!isRecord(na) || !isNonEmptyString(na.value) || !isNonEmptyString(na.label)) {
          errors.push(`scale ${name}.notApplicable needs value and label`);
        }
      }
    }
  }

  if (!Array.isArray(d.sections) || d.sections.length === 0) {
    errors.push('sections must be a non-empty array');
    return errors;
  }
  const sectionIds = new Set<string>();
  const keys = new Set<string>();
  for (const [si, section] of d.sections.entries()) {
    const where = `sections[${si}]`;
    if (!isRecord(section)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    if (typeof section.id !== 'string' || !ID_PATTERN.test(section.id)) errors.push(`${where}.id is invalid`);
    else if (sectionIds.has(section.id)) errors.push(`${where}.id ${section.id} is duplicated`);
    else sectionIds.add(section.id);
    if (!isNonEmptyString(section.title)) errors.push(`${where}.title is required`);
    if (section.label !== undefined && (typeof section.label !== 'string' || section.label.length > 8)) {
      errors.push(`${where}.label must be a string of at most 8 characters`);
    }
    if (section.legendScale !== undefined && !scaleNames.has(section.legendScale as string)) {
      errors.push(`${where}.legendScale refers to an unknown scale`);
    }
    if (!Array.isArray(section.items) || section.items.length === 0) {
      errors.push(`${where}.items must be a non-empty array`);
      continue;
    }
    for (const [ii, item] of section.items.entries()) {
      const w = `${where}.items[${ii}]`;
      if (!isRecord(item)) {
        errors.push(`${w} must be an object`);
        continue;
      }
      if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) {
        errors.push(`${w}.id is invalid`);
        continue;
      }
      if (!isNonEmptyString(item.text)) errors.push(`${w}.text is required`);
      const addKey = (key: string) => {
        if (keys.has(key)) errors.push(`answer key ${key} is duplicated`);
        keys.add(key);
      };
      switch (item.type) {
        case 'scale':
          if (!scaleNames.has(item.scale as string)) errors.push(`${w} refers to unknown scale`);
          addKey(item.id);
          if (item.anchors !== undefined && (!isRecord(item.anchors) || !isNonEmptyString(item.anchors.min) || !isNonEmptyString(item.anchors.max))) {
            errors.push(`${w}.anchors needs min and max`);
          }
          if (item.comment !== undefined) {
            const c = item.comment;
            if (!isRecord(c) || !isNonEmptyString(c.label)) {
              errors.push(`${w}.comment needs a label`);
            } else {
              if (c.id !== undefined && (typeof c.id !== 'string' || !ID_PATTERN.test(c.id))) errors.push(`${w}.comment.id is invalid`);
              if (c.maxLength !== undefined && (!Number.isInteger(c.maxLength) || (c.maxLength as number) < 1 || (c.maxLength as number) > 20000)) {
                errors.push(`${w}.comment.maxLength must be an integer between 1 and 20000`);
              }
              addKey(typeof c.id === 'string' ? c.id : `${item.id}_txt`);
            }
          }
          break;
        case 'matrix':
          if (!scaleNames.has(item.scale as string)) errors.push(`${w} refers to unknown scale`);
          if (!Array.isArray(item.columns) || item.columns.length === 0) {
            errors.push(`${w}.columns must be a non-empty array`);
          } else {
            for (const c of item.columns) {
              if (!isRecord(c) || typeof c.id !== 'string' || !ID_PATTERN.test(c.id) || !isNonEmptyString(c.label)) {
                errors.push(`${w} has an invalid column`);
              } else {
                addKey(`${item.id}_${c.id}`);
              }
            }
          }
          break;
        case 'text':
          if (item.maxLength !== undefined && (!Number.isInteger(item.maxLength) || (item.maxLength as number) < 1 || (item.maxLength as number) > 20000)) {
            errors.push(`${w}.maxLength must be an integer between 1 and 20000`);
          }
          addKey(item.id);
          break;
        case 'choice':
          if (!Array.isArray(item.options) || item.options.length < 2 || !item.options.every(isNonEmptyString)) {
            errors.push(`${w}.options needs at least two strings`);
          } else if (new Set(item.options).size !== item.options.length) {
            errors.push(`${w}.options must be unique`);
          }
          addKey(item.id);
          break;
        default:
          errors.push(`${w}.type must be scale, matrix, text or choice`);
      }
    }
  }
  return errors;
}

function allowedScaleValue(scale: Scale, value: unknown): boolean {
  if (typeof value === 'number') return scale.options.some((o) => o.value === value);
  if (typeof value === 'string') return scale.notApplicable?.value === value;
  return false;
}

export function isAnswered(value: AnswerValue | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Answers for one field that are acceptable; used by both the client and the server. */
export function fieldProblem(def: SurveyDefinition, field: Field, value: AnswerValue | undefined): string | null {
  const { item } = field;
  if (!isAnswered(value)) return item.required ? 'required' : null;
  switch (item.type) {
    case 'scale':
    case 'matrix': {
      const scale = def.scales[item.scale];
      return scale && allowedScaleValue(scale, value) ? null : 'invalid';
    }
    case 'text': {
      if (typeof value !== 'string') return 'invalid';
      return value.length > (item.maxLength ?? DEFAULT_TEXT_MAX) ? 'too_long' : null;
    }
    case 'choice': {
      if (item.multiple) {
        if (!Array.isArray(value) || !value.every((v) => item.options.includes(v))) return 'invalid';
        return new Set(value).size === value.length ? null : 'invalid';
      }
      return typeof value === 'string' && item.options.includes(value) ? null : 'invalid';
    }
    default:
      return 'invalid';
  }
}

/** Validates a full answer set. Returns problems keyed by field (empty = valid). */
export function validateAnswers(def: SurveyDefinition, raw: unknown): Record<string, string> {
  const problems: Record<string, string> = {};
  if (!isRecord(raw)) return { _: 'answers must be an object' };
  const fields = fieldsOf(def);
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) problems[key] = 'unknown';
  }
  for (const field of fields) {
    const p = fieldProblem(def, field, raw[field.key] as AnswerValue | undefined);
    if (p) problems[field.key] = p;
  }
  return problems;
}

/** Drops empty values so stored answers only contain what was actually given. */
export function compactAnswers(def: SurveyDefinition, answers: Answers): Answers {
  const out: Answers = {};
  for (const field of fieldsOf(def)) {
    const v = answers[field.key];
    if (isAnswered(v)) out[field.key] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

export type SurveyStatus = 'open' | 'not_yet_open' | 'closed';

export function surveyStatus(def: SurveyDefinition, now: Date = new Date()): SurveyStatus {
  if (def.opensAt && now < new Date(def.opensAt)) return 'not_yet_open';
  if (def.closesAt && now > new Date(def.closesAt)) return 'closed';
  return 'open';
}

// ---- access codes ----

/** Unambiguous characters (no 0/O, 1/I/L). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

/** Uppercase, without separators or spaces: "k7m2-q9xw" -> "K7M2Q9XW". */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function isWellFormedCode(code: string): boolean {
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

/** Display form "K7M2-Q9XW". */
export function formatCode(code: string): string {
  return code.length === CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
