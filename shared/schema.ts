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
  /**
   * Slider only: resolution of a continuous slider (e.g. 0.1). Any multiple of `step` between
   * the first and the last option is a valid answer; the options stay the marked ticks.
   */
  step?: number;
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
  /** Photos for documentation, attached to this item and stored as their own photo field. */
  photos?: ItemPhotos;
}

/** Photos attached to a scale item, stored under `<item id>_foto` (default). */
export interface ItemPhotos {
  id?: string;
  /** Most photos per item (1–10, default 3). */
  max?: number;
  label?: string;
}

/** A field holding up to `max` photos; its answer is a list of photo ids. */
export interface PhotoItem extends BaseItem {
  type: 'photo';
  max?: number;
}

export const DEFAULT_PHOTO_MAX = 3;
/** Photo ids are random, chosen on the device: 32 lowercase hex characters. */
export const PHOTO_ID_PATTERN = /^[0-9a-f]{32}$/;
/** Largest photo the server accepts (the app sends re-encoded JPEGs well below this). */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

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

export type Item = ScaleItem | MatrixItem | TextItem | ChoiceItem | PhotoItem;

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
  /**
   * With accessCodes "required": the link alone reveals nothing about the survey. Its definition
   * (title, texts, questions, theme) is only handed out together with a valid access code.
   */
  gated?: boolean;
  /**
   * Participants use their own devices: with access codes, drafts are still kept on the device
   * (not only for the browser tab, as for shared course devices) until they are sent.
   */
  personalDevices?: boolean;
  /**
   * The administration sees all answers at any time (live): no minimum group size and no closing
   * needed before results are shown, exact counts while open. For surveys whose participants are
   * not anonymous towards the organisers anyway (e.g. observers giving their name).
   */
  liveResults?: boolean;
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

/** The photo item that stores the photos of a scale item. */
export function photoItem(item: ScaleItem, locale: Locale = 'de'): PhotoItem {
  const p = item.photos!;
  const label = p.label ?? (locale === 'en' ? 'Photos' : 'Fotos');
  return { id: p.id ?? `${item.id}_foto`, type: 'photo', text: `${stripBold(item.text)} – ${label}`, max: p.max };
}

/** Photo ids referenced anywhere in an answer set. */
export function photoIdsOf(def: SurveyDefinition, answers: Answers): string[] {
  const out: string[] = [];
  for (const f of fieldsOf(def)) {
    const v = answers[f.key];
    if (f.item.type === 'photo' && Array.isArray(v)) out.push(...v);
  }
  return out;
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
        if (item.type === 'scale' && item.photos) {
          const p = photoItem(item, def.locale);
          out.push({ key: p.id, item: p, sectionId: section.id, parent: item.id });
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
  if (d.gated !== undefined && typeof d.gated !== 'boolean') errors.push('gated must be a boolean');
  if (d.gated === true && d.accessCodes !== 'required') errors.push('gated needs accessCodes "required"');
  if (d.personalDevices !== undefined && typeof d.personalDevices !== 'boolean') errors.push('personalDevices must be a boolean');
  if (d.personalDevices === true && d.accessCodes === undefined) errors.push('personalDevices needs accessCodes');
  if (d.liveResults !== undefined && typeof d.liveResults !== 'boolean') errors.push('liveResults must be a boolean');
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
      if (scale.step !== undefined) {
        const st = scale.step as number;
        if (scale.display !== 'slider') errors.push(`scale ${name}.step needs display "slider"`);
        else if (typeof st !== 'number' || !(st >= 0.01 && st <= 1) || Math.abs(Math.round(1 / st) * st - 1) > 1e-9) {
          errors.push(`scale ${name}.step must divide 1 and be at least 0.01 (e.g. 0.1, 0.25, 0.5)`);
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
    if (section.label !== undefined && (!isNonEmptyString(section.label) || section.label.length > 8)) {
      errors.push(`${where}.label must be a non-empty string of at most 8 characters`);
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
      if (item.type !== 'scale') {
        for (const k of ['anchors', 'comment', 'photos'] as const) {
          if (item[k] !== undefined) errors.push(`${w}.${k} is only allowed on scale items`);
        }
      }
      switch (item.type) {
        case 'scale':
          if (!scaleNames.has(item.scale as string)) errors.push(`${w} refers to unknown scale`);
          addKey(item.id);
          if (item.anchors !== undefined && (!isRecord(item.anchors) || !isNonEmptyString(item.anchors.min) || !isNonEmptyString(item.anchors.max))) {
            errors.push(`${w}.anchors needs min and max`);
          }
          if (item.photos !== undefined) {
            const ph = item.photos;
            if (!isRecord(ph)) {
              errors.push(`${w}.photos must be an object`);
            } else {
              if (ph.id !== undefined && (typeof ph.id !== 'string' || !ID_PATTERN.test(ph.id))) errors.push(`${w}.photos.id is invalid`);
              if (ph.max !== undefined && (!Number.isInteger(ph.max) || (ph.max as number) < 1 || (ph.max as number) > 10)) {
                errors.push(`${w}.photos.max must be an integer between 1 and 10`);
              }
              if (ph.label !== undefined && !isNonEmptyString(ph.label)) errors.push(`${w}.photos.label must be a string`);
              addKey(typeof ph.id === 'string' ? ph.id : `${item.id}_foto`);
            }
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
        case 'photo':
          if (item.max !== undefined && (!Number.isInteger(item.max) || (item.max as number) < 1 || (item.max as number) > 10)) {
            errors.push(`${w}.max must be an integer between 1 and 10`);
          }
          addKey(item.id);
          break;
        default:
          errors.push(`${w}.type must be scale, matrix, text, choice or photo`);
      }
    }
  }
  return errors;
}

/** Decimal places of a slider step: 0.1 -> 1, 0.25 -> 2, 0.125 -> 3. */
export function stepDecimals(step: number): number {
  const s = String(step);
  const e = s.match(/e-(\d+)$/);
  if (e) return Number(e[1]) + (s.split('e')[0].split('.')[1]?.length ?? 0);
  return s.split('.')[1]?.length ?? 0;
}

/** The nearest value on a slider's grid `lo + k * step`, without float noise. */
export function snapToStep(value: number, lo: number, step: number): number {
  return Number((lo + Math.round((value - lo) / step) * step).toFixed(stepDecimals(step)));
}

function allowedScaleValue(scale: Scale, value: unknown): boolean {
  if (typeof value === 'number' && scale.step !== undefined) {
    const lo = scale.options[0].value;
    const hi = scale.options[scale.options.length - 1].value;
    if (!Number.isFinite(value) || value < lo || value > hi) return false;
    // Only exact grid values (as the slider sends them, e.g. 4.7), never float noise like 4.70000001.
    return value === snapToStep(value, lo, scale.step);
  }
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
    case 'photo': {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && PHOTO_ID_PATTERN.test(v))) return 'invalid';
      if (new Set(value).size !== value.length) return 'invalid';
      return value.length > (item.max ?? DEFAULT_PHOTO_MAX) ? 'too_many' : null;
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
