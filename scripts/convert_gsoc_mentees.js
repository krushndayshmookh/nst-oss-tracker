#!/usr/bin/env node
// Converts NST's GSoC tracking workbook (GSoC_Mentees.xlsx, tab "Proposals" with a "Selected?" column) into the
// calibration CSV that the private page accepts (Settings → Past outcomes): username,program,year,org,selected
//
//   node scripts/convert_gsoc_mentees.js data/GSoC_Mentees.xlsx --year 2025 > /tmp/gsoc-2025-outcomes.csv
//   ... --sheet Proposals   the tab to read (default Proposals)
//   ... --all               also rows whose "Submitted" is not true (default: submitted proposals only)
//
// The output holds student outcomes: keep it OUT of the repository and upload it on the private page. Nothing here is
// stored by the app until the owner uploads it. No dependency: a small reader for the .xlsx container (zip + XML).
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { csvLine } from '../src/csv.js';

/** Entries of a zip archive: Map<name, Buffer> (stored and deflated entries; enough for .xlsx). */
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + csize);
    out.set(name, method === 0 ? data : zlib.inflateRawSync(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (m, d) => String.fromCodePoint(parseInt(d, 16))).replace(/&amp;/g, '&');
const textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Rows of one worksheet as arrays of strings / booleans / null. */
export function readSheet(file, sheetName) {
  const zip = unzip(readFileSync(file));
  const get = (name) => zip.get(name)?.toString('utf8') ?? '';
  const workbook = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels');
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: unxml(/name="([^"]*)"/.exec(m[0])?.[1] ?? ''), rid: /r:id="([^"]*)"/.exec(m[0])?.[1] }));
  const sheet = sheets.find((s) => s.name.trim().toLowerCase() === sheetName.trim().toLowerCase());
  if (!sheet) throw new Error(`no tab named "${sheetName}" (tabs: ${sheets.map((s) => s.name).join(', ')})`);
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${sheet.rid}"`));
  const target = /Target="([^"]*)"/.exec(rel || '')?.[1];
  if (!target) throw new Error(`cannot locate the data of tab "${sheetName}"`);
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const xml = get(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  const rows = [];
  for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /r="([A-Z]+\d+)"/.exec(c[1])?.[1];
      const type = /t="([^"]*)"/.exec(c[1])?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] || '')?.[1];
      let value = null;
      if (type === 's') value = shared[Number(v)] ?? null;
      else if (type === 'inlineStr') value = textOf(c[2] || '');
      else if (type === 'b') value = v === '1';
      else if (v !== undefined) value = unxml(v);
      row[ref ? colIndex(ref) : row.length] = value;
    }
    rows.push(Array.from(row, (x) => x ?? null));
  }
  return rows;
}

const truthy = (v) => v === true || /^(true|yes|y|1|selected)$/i.test(String(v ?? '').trim());

/** -> { rows:[{username, program, year, org, selected}], skipped:[reason] } */
export function proposalsToOutcomes(rows, { year, program = 'gsoc', all = false } = {}) {
  const header = (rows[0] || []).map((h) => String(h ?? '').trim().toLowerCase());
  const col = (...names) => header.findIndex((h) => names.includes(h));
  const gi = col('github', 'github id', 'github username');
  const si = col('selected?', 'selected');
  const oi = col('org', 'organization', 'organisation');
  const su = col('submitted');
  if (gi < 0 || si < 0) throw new Error('the tab needs a "Github" and a "Selected?" column in its first row');
  const out = new Map();
  const skipped = [];
  rows.slice(1).forEach((r, i) => {
    const raw = String(r[gi] ?? '').trim();
    if (!raw) return;
    const username = raw.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/[/?#].*$/, '').replace(/^@/, '');
    if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(username)) { skipped.push(`row ${i + 2}: "${raw.slice(0, 40)}" is not a GitHub login`); return; }
    if (!all && su >= 0 && !truthy(r[su])) { skipped.push(`row ${i + 2}: ${username} did not submit a proposal`); return; }
    const selected = truthy(r[si]);
    const prev = out.get(username.toLowerCase());
    // several proposals by one student: one outcome, selected if any was
    out.set(username.toLowerCase(), { username, program, year, org: String((selected ? r[oi] : prev?.org || r[oi]) ?? '').trim(), selected: selected || Boolean(prev?.selected) });
  });
  return { rows: [...out.values()], skipped };
}

function main() {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--') && !/^\d{4}$/.test(a));
  const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
  const year = Number(opt('year', ''));
  if (!file || !Number.isInteger(year) || year < 2015 || year > 2035) {
    console.error('usage: node scripts/convert_gsoc_mentees.js <GSoC_Mentees.xlsx> --year <YYYY> [--sheet Proposals] [--program gsoc] [--all] > outcomes.csv');
    return 2;
  }
  const { rows, skipped } = proposalsToOutcomes(readSheet(file, opt('sheet', 'Proposals')), { year, program: opt('program', 'gsoc'), all: argv.includes('--all') });
  let out = csvLine(['username', 'program', 'year', 'org', 'selected']);
  for (const r of rows) out += csvLine([r.username, r.program, r.year, r.org, r.selected ? 'yes' : 'no']);
  process.stdout.write(out);
  for (const s of skipped) console.error(`skipped ${s}`);
  console.error(`${rows.length} outcomes (${rows.filter((r) => r.selected).length} selected), ${skipped.length} rows skipped`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exit(main()); } catch (e) { console.error(`convert_gsoc_mentees failed: ${e?.message || e}`); process.exit(1); }
}
