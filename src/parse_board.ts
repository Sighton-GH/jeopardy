/**
 * Spreadsheet -> BoardInput parsing for the host create flow.
 *
 * Supported inputs:
 *  - Jeopardy Labs CSV/xlsx export: header columns round, cat, value, q, a, dd
 *    (value is optional; dd flags a daily double)
 *  - Simple variant: header columns category, question, answer, value
 *
 * Column names match case-insensitively; common aliases are accepted
 * (cat/category, q/question/clue, a/answer/response, dd/daily double).
 * Rows normalize into BoardInput: grouped by category in first-seen order,
 * cells sorted by ascending value, daily-double flag preserved. A file must
 * contain a single round; BoardInput models one board.
 *
 * No dependencies: CSV is tokenized directly and xlsx is read as a ZIP
 * (central directory + DecompressionStream) with a small XML reader, so the
 * module runs unchanged in the browser and in workerd (vitest pool).
 */
import type { BoardInput } from './protocol';

export const MAX_CATEGORIES = 10;
export const MAX_CELLS_PER_CATEGORY = 10;
export const MAX_VALUE = 100000;
const MAX_ROWS = 200; // sanity cap; a legal board needs at most 100 clue rows
const FIRST_ROUND_VALUES = [200, 400, 600, 800, 1000];

export class BoardParseError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join('\n'));
    this.name = 'BoardParseError';
  }
}

function fail(issues: string[]): never { throw new BoardParseError(issues); }

/** Parse an uploaded file (.csv or .xlsx) into a validated BoardInput. */
export async function parseBoardFile(fileName: string, data: Uint8Array | string): Promise<BoardInput> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xls')) {
    fail(['This is an old .xls file. In Excel, use Save As and choose ".xlsx" (or export CSV), then upload that.']);
  }
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (lower.endsWith('.xlsx') || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    return rowsToBoard(await parseXlsx(bytes));
  }
  if (lower.endsWith('.csv')) {
    return rowsToBoard(parseCsv(typeof data === 'string' ? data : new TextDecoder().decode(bytes)));
  }
  fail([`"${fileName}" is not a supported file. Upload a .csv or .xlsx spreadsheet.`]);
}

/* ---------------------------------- CSV ---------------------------------- */

/** Tokenize CSV text (RFC 4180 style: quoted fields, "" escapes, CRLF) into rows of cells. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') inQuotes = true; // quotes open at field start
    else if (ch === ',') pushField();
    else if (ch === '\n') pushRow();
    else if (ch === '\r') { if (text[i + 1] !== '\n') pushRow(); }
    else field += ch;
  }
  pushRow();
  // Drop trailing/whitespace-only rows (a trailing newline produces one empty row).
  return rows.filter(cells => cells.some(cell => cell.trim() !== ''));
}

/* --------------------------- Row normalization --------------------------- */

const HEADER_ALIASES: Record<string, string> = {
  round: 'round',
  cat: 'category', category: 'category',
  q: 'question', question: 'question', clue: 'question',
  a: 'answer', answer: 'answer', response: 'answer',
  value: 'value', points: 'value', score: 'value',
  dd: 'dd', 'daily double': 'dd', dailydouble: 'dd', 'daily_double': 'dd',
};

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'dd', 'daily double', 'x']);
const FALSE_WORDS = new Set(['', 'false', 'no', 'n', '0']);

interface RowRef { sheetRow: number; round: string; category: string; question: string; answer: string; value: number | null; dailyDouble: boolean }

/** Normalize parsed spreadsheet rows (header row + data rows) into a validated BoardInput. */
export function rowsToBoard(rows: string[][]): BoardInput {
  if (rows.length === 0) fail(['The spreadsheet is empty.']);
  if (rows.length - 1 > MAX_ROWS) fail([`The spreadsheet has ${rows.length - 1} rows; a board needs at most ${MAX_CATEGORIES * MAX_CELLS_PER_CATEGORY} clues.`]);

  const header = rows[0]!.map(cell => cell.trim().toLowerCase().replace(/[_-]+/g, ' '));
  const columns = new Map<string, number>(); // logical name -> column index
  const unknown: string[] = [];
  header.forEach((cell, index) => {
    if (cell === '') return;
    const logical = HEADER_ALIASES[cell] ?? HEADER_ALIASES[cell.replace(/ /g, '')];
    if (logical && !columns.has(logical)) columns.set(logical, index);
    else if (!logical) unknown.push(rows[0]![index]!.trim());
  });

  const missing: string[] = [];
  for (const required of ['category', 'question', 'answer'] as const) if (!columns.has(required)) missing.push(required);
  if (missing.length > 0) {
    fail([
      `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
      'Use the Jeopardy Labs export (round, cat, value, q, a, dd) or a simple sheet with columns: category, question, answer, value.',
    ]);
  }

  const issues: string[] = [];
  const refs: RowRef[] = [];
  const valueCol = columns.get('value');
  const roundCol = columns.get('round');
  const ddCol = columns.get('dd');

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    const at = (col: number | undefined) => (col === undefined ? '' : (cells[col] ?? '').trim());
    const label = `Row ${r + 1}`;
    const category = at(columns.get('category'));
    const question = at(columns.get('question'));
    const answer = at(columns.get('answer'));
    const round = at(roundCol);
    if (!category) issues.push(`${label}: category is empty.`);
    if (!question) issues.push(`${label}: question is empty.`);
    if (!answer) issues.push(`${label}: answer is empty.`);
    let value: number | null = null;
    if (valueCol !== undefined) {
      const raw = at(valueCol).replace(/[$,]/g, '');
      if (raw === '') issues.push(`${label}: value is empty.`);
      else if (!/^\d+$/.test(raw)) issues.push(`${label}: value "${at(valueCol)}" is not a whole number.`);
      else {
        value = Number(raw);
        if (value < 1 || value > MAX_VALUE) issues.push(`${label}: value ${value} is outside 1-${MAX_VALUE}.`);
      }
    }
    let dailyDouble = false;
    if (ddCol !== undefined) {
      const raw = at(ddCol).toLowerCase();
      if (TRUE_WORDS.has(raw)) dailyDouble = true;
      else if (!FALSE_WORDS.has(raw)) issues.push(`${label}: daily double "${at(ddCol)}" is not yes/no.`);
    }
    refs.push({ sheetRow: r + 1, round, category, question, answer, value, dailyDouble });
  }

  const rounds = [...new Set(refs.map(ref => ref.round).filter(r => r !== ''))];
  if (rounds.length > 1) {
    issues.push(`The file has ${rounds.length} rounds (${rounds.join(', ')}). Upload one round per file - create a separate room for each round.`);
  }

  // Group by category in first-seen order.
  const groups = new Map<string, RowRef[]>();
  for (const ref of refs) {
    if (!ref.category) continue;
    const list = groups.get(ref.category) ?? [];
    list.push(ref);
    groups.set(ref.category, list);
  }
  if (groups.size > MAX_CATEGORIES) issues.push(`The board has ${groups.size} categories; the maximum is ${MAX_CATEGORIES}.`);
  if (groups.size === 0 && issues.length === 0) issues.push('No usable rows found under the header row.');

  for (const [name, list] of groups) {
    if (list.length > MAX_CELLS_PER_CATEGORY) issues.push(`Category "${name}" has ${list.length} clues; the maximum is ${MAX_CELLS_PER_CATEGORY}.`);
    const seen = new Map<number, number>();
    for (const ref of list) {
      if (ref.value === null) continue;
      const first = seen.get(ref.value);
      if (first !== undefined) issues.push(`Category "${name}" has two clues worth ${ref.value} (rows ${first} and ${ref.sheetRow}).`);
      else seen.set(ref.value, ref.sheetRow);
    }
  }
  if (issues.length > 0) fail(issues.slice(0, 12));

  const categories = [...groups.entries()].map(([name, list], ci) => {
    const sorted = [...list].sort((a, b) => {
      if (a.value !== null && b.value !== null) return a.value - b.value;
      return a.sheetRow - b.sheetRow; // no value column: keep sheet order
    });
    return {
      id: `c${ci + 1}`,
      name,
      cells: sorted.map((ref, ri) => ({
        id: `c${ci + 1}q${ri + 1}`,
        question: ref.question,
        answer: ref.answer,
        value: ref.value ?? FIRST_ROUND_VALUES[ri] ?? (ri + 1) * 200,
        dailyDouble: ref.dailyDouble,
      })),
    };
  });
  return { categories };
}

/* ---------------------------------- XLSX ---------------------------------- */

interface ZipEntry { name: string; method: number; size: number; compressedSize: number; offset: number }

function readZipEntries(data: Uint8Array): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Locate the End Of Central Directory record (signature 0x06054b50).
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail(['This .xlsx file is not a valid ZIP archive. Re-save it in Excel and try again.']);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLen));
    entries.push({ name, method, size, compressedSize, offset: localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateEntry(data: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(entry.offset, true) !== 0x04034b50) fail(['This .xlsx file has an unexpected layout. Re-save it in Excel and try again.']);
  const nameLen = view.getUint16(entry.offset + 26, true);
  const extraLen = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLen + extraLen;
  const bytes = data.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return bytes.slice(); // stored
  if (entry.method !== 8) fail(['This .xlsx file uses an unsupported compression. Re-save it in Excel and try again.']);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

/** Concatenate the text of every <t> run inside an <si>/<is> fragment. */
function innerText(fragment: string): string {
  const parts: string[] = [];
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment))) parts.push(decodeXml(m[1]!));
  return parts.join('');
}

function columnIndex(ref: string): number {
  let index = 0;
  for (const ch of ref) {
    const code = ch.toUpperCase().charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

/** Read the first worksheet of an .xlsx file into rows of cells. */
export async function parseXlsx(data: Uint8Array): Promise<string[][]> {
  const entries = readZipEntries(data);
  const byName = new Map(entries.map(e => [e.name, e]));
  const decoder = new TextDecoder();
  const readText = async (name: string) => {
    const entry = byName.get(name);
    return entry ? decoder.decode(await inflateEntry(data, entry)) : null;
  };

  // Resolve the first sheet through the workbook relationships, falling back
  // to the conventional path for writers that omit nothing but order.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const workbook = await readText('xl/workbook.xml');
  const rels = await readText('xl/_rels/workbook.xml.rels');
  if (workbook && rels) {
    const sheetMatch = /<sheet[^>]*\br:id="([^"]+)"/.exec(workbook) ?? /<sheet[^>]*\bid="([^"]+)"[^>]*\bname=/.exec(workbook);
    if (sheetMatch) {
      const relMatch = new RegExp(`<Relationship[^>]*\\bId="${sheetMatch[1]}"[^>]*\\bTarget="([^"]+)"`).exec(rels)
        ?? new RegExp(`<Relationship[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${sheetMatch[1]}"`).exec(rels);
      if (relMatch) {
        const target = relMatch[1]!;
        sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
      }
    }
  }
  const sheetEntry = byName.get(sheetPath) ?? entries.find(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
  if (!sheetEntry) fail(['This .xlsx file has no worksheet. Add your clues to the first sheet and try again.']);
  const sheetXml = decoder.decode(await inflateEntry(data, sheetEntry));

  const shared: string[] = [];
  const sharedXml = await readText('xl/sharedStrings.xml');
  if (sharedXml) {
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sharedXml))) shared.push(innerText(m[1]!));
  }

  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(sheetXml))) {
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1]!))) {
      const attrs = cellMatch[1]!;
      const body = cellMatch[2] ?? '';
      const refMatch = /\br="([A-Z]+)\d+"/i.exec(attrs);
      const index = refMatch ? columnIndex(refMatch[1]!) : cells.length;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      let value = '';
      if (type === 'inlineStr') value = innerText(body);
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        if (type === 's') value = shared[Number(v)] ?? '';
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else value = decodeXml(v);
      }
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }
    rows.push(cells);
  }
  return rows.filter(cells => cells.some(cell => cell.trim() !== ''));
}
