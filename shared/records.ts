// Flattening of free-form app records into table rows, shared by server (CSV) and browser (XLSX).

export interface RecordRow {
  collection: string;
  receivedOn: string;
  data: unknown;
}

/** Flattens nested objects into dotted keys; arrays and other values become JSON text. */
export function flattenRecord(data: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0 && prefix) out[prefix] = '{}';
    for (const [k, v] of entries) flattenRecord(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    const key = prefix || 'value';
    out[key] = data === null || data === undefined ? '' : typeof data === 'string' ? data : JSON.stringify(data);
  }
  return out;
}

/** One row per record, one column per (flattened) field. */
export function recordsTable(records: RecordRow[]): { header: string[]; rows: string[][] } {
  const flat = records.map((r) => flattenRecord(r.data));
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const f of flat) {
    for (const k of Object.keys(f)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  const header = ['record', 'collection', 'received_on', ...keys];
  const rows = records.map((r, i) => [String(i + 1), r.collection, r.receivedOn, ...keys.map((k) => flat[i][k] ?? '')]);
  return { header, rows };
}
