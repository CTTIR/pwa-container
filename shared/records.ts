// Flattening of free-form app records into table rows, shared by server (CSV) and browser (XLSX).
// Records carry no date of any kind: a row is its running number, its collection and its fields.

export interface RecordRow {
  collection: string;
  data: unknown;
}

/** Nesting below this depth is written as JSON text instead of further columns. */
export const FLATTEN_MAX_DEPTH = 6;
/** Columns beyond this number are collected in one "_more" column as JSON. */
export const MAX_COLUMNS = 500;

/**
 * Flattens nested objects into dotted keys; arrays, deep subtrees and other values become text.
 * The result has no prototype, so keys such as "__proto__" or "constructor" are ordinary fields.
 */
export function flattenRecord(
  data: unknown,
  prefix = '',
  out: Record<string, string> = Object.create(null) as Record<string, string>,
  depth = 0,
): Record<string, string> {
  if (data !== null && typeof data === 'object' && !Array.isArray(data) && depth < FLATTEN_MAX_DEPTH) {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0 && prefix) out[prefix] = '{}';
    for (const [k, v] of entries) flattenRecord(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  } else {
    const key = prefix || 'value';
    out[key] = data === null || data === undefined ? '' : typeof data === 'string' ? data : JSON.stringify(data);
  }
  return out;
}

/** Column order: first appearance across records, capped at MAX_COLUMNS. */
export function collectColumns(records: Iterable<RecordRow>, maxColumns = MAX_COLUMNS): { keys: string[]; overflow: boolean } {
  const keys: string[] = [];
  const seen = new Set<string>();
  let overflow = false;
  for (const r of records) {
    for (const k of Object.keys(flattenRecord(r.data))) {
      if (seen.has(k)) continue;
      if (keys.length >= maxColumns) {
        overflow = true;
        continue;
      }
      seen.add(k);
      keys.push(k);
    }
  }
  return { keys, overflow };
}

/** Header row: record, collection, the field columns and, if needed, "_more". */
export function headerFor(keys: string[], overflow: boolean): string[] {
  return ['record', 'collection', ...keys, ...(overflow ? ['_more'] : [])];
}

/** One table row; fields beyond the known columns go into "_more" as JSON. */
export function rowFor(index: number, r: RecordRow, keys: string[], overflow: boolean): string[] {
  const flat = flattenRecord(r.data);
  // Only own values: a column named "constructor" or "toString" must never read Object.prototype.
  const row = [String(index), r.collection, ...keys.map((k) => (Object.hasOwn(flat, k) ? flat[k] : ''))];
  if (overflow) {
    const known = new Set(keys);
    const rest = Object.fromEntries(Object.entries(flat).filter(([k]) => !known.has(k)));
    row.push(Object.keys(rest).length ? JSON.stringify(rest) : '');
  }
  return row;
}

/** One row per record, one column per (flattened) field. */
export function recordsTable(records: RecordRow[]): { header: string[]; rows: string[][] } {
  const { keys, overflow } = collectColumns(records);
  return { header: headerFor(keys, overflow), rows: records.map((r, i) => rowFor(i + 1, r, keys, overflow)) };
}

/** True when a JSON value nests no deeper than `maxDepth` and has at most `maxNodes` values. */
export function withinShape(value: unknown, maxDepth = 32, maxNodes = 20_000): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (++nodes > maxNodes || depth > maxDepth) return false;
    if (v !== null && typeof v === 'object') {
      for (const child of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) stack.push([child, depth + 1]);
    }
  }
  return true;
}
