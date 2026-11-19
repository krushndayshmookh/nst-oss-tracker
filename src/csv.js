// Minimal RFC 4180 CSV reader / writer (no dependency).

/** Parses CSV text into an array of string arrays. Handles quotes, escaped quotes, CRLF, BOM. */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Parses CSV text with a header row into objects keyed by trimmed, lowercased header names. */
export function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, idx) => { if (h) o[h] = (r[idx] ?? '').trim(); });
    return o;
  });
}

/** One CSV field. Values starting with = + - @ are prefixed with ' so spreadsheets do not run them as formulas. */
export function csvField(v) {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values) {
  return values.map(csvField).join(',') + '\n';
}
