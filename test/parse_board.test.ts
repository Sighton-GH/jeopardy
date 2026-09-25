import { describe, expect, it } from 'vitest';
import { BoardParseError, parseBoardFile, parseCsv, parseXlsx, rowsToBoard } from '../src/parse_board';

it('gives a trim path for multi-round and oversized-category uploads', () => {
  const rows = [['round', 'cat', 'value', 'q', 'a']];
  for (let c = 1; c <= 11; c++) rows.push([String(c <= 4 ? 1 : 2), `Cat ${c}`, '200', `Q ${c}`, `A ${c}`]);
  try { rowsToBoard(rows); throw new Error('Expected validation error'); }
  catch (error) {
    expect(error).toBeInstanceOf(BoardParseError);
    const issues = (error as BoardParseError).issues.join(' ');
    expect(issues).toContain('2 rounds');
    expect(issues).toContain('11 categories');
    expect(issues).toContain('Keep only one round');
  }
});

/* Minimal ZIP writer so tests can build real .xlsx files without fixtures. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function zip(files: Array<{ name: string; text: string; deflate?: boolean }>): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    let data = encoder.encode(file.text);
    let method = 0;
    if (file.deflate) {
      const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
      method = 8;
    }
    const crc = crc32(encoder.encode(file.text));
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(8, method, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, encoder.encode(file.text).length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true); head.setUint16(10, method, true);
    head.setUint32(16, crc, true); head.setUint32(20, data.length, true); head.setUint32(24, encoder.encode(file.text).length, true);
    head.setUint16(28, name.length, true); head.setUint32(42, offset, true);
    central.push(new Uint8Array(head.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, files.length, true); eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true); eocd.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of all) { out.set(chunk, at); at += chunk.length; }
  return out;
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function xlsx(rows: string[][], deflate = false): Promise<Uint8Array> {
  const shared = [...new Set(rows.flat())];
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheetRows = rows.map((cells, r) => `<row r="${r + 1}">${cells.map((cell, c) => {
    if (cell !== '' && !Number.isNaN(Number(cell))) return `<c r="${col(c)}${r + 1}"><v>${cell}</v></c>`;
    if (cell === '') return '';
    return `<c r="${col(c)}${r + 1}" t="s"><v>${shared.indexOf(cell)}</v></c>`;
  }).join('')}</row>`).join('');
  return zip([
    { name: 'xl/workbook.xml', text: '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>', deflate },
    { name: 'xl/_rels/workbook.xml.rels', text: '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>', deflate },
    { name: 'xl/sharedStrings.xml', text: `<sst>${shared.map(s => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`, deflate },
    { name: 'xl/worksheets/sheet1.xml', text: `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`, deflate },
  ]);
}

const issuesOf = (fn: () => unknown): string[] => {
  try { fn(); } catch (error) {
    if (error instanceof BoardParseError) return error.issues;
    throw error;
  }
  return [];
};

describe('parseCsv', () => {
  it('handles quoted commas, escaped quotes, CRLF and blank lines', () => {
    const rows = parseCsv('category,question,answer,value\r\nScience,"What is ""H2O""?",Water,200\nScience,"Line one\nline two",Answer,400\n\n');
    expect(rows).toEqual([
      ['category', 'question', 'answer', 'value'],
      ['Science', 'What is "H2O"?', 'Water', '200'],
      ['Science', 'Line one\nline two', 'Answer', '400'],
    ]);
  });
});

describe('rowsToBoard', () => {
  it('normalizes the Jeopardy Labs export (round, cat, value, q, a, dd)', () => {
    const board = rowsToBoard(parseCsv([
      'round,cat,value,q,a,dd',
      '1,Lightning Talks,400,Second clue,Answer two,no',
      '1,Keynote Speakers,200,Who gave the keynote?,Noah,false',
      '1,Lightning Talks,200,First clue,Answer one,yes',
    ].join('\n')));
    expect(board.categories.map(c => c.name)).toEqual(['Lightning Talks', 'Keynote Speakers']);
    expect(board.categories[0]?.cells.map(c => c.value)).toEqual([200, 400]);
    expect(board.categories[0]?.cells[0]).toMatchObject({ question: 'First clue', dailyDouble: true });
    expect(board.categories[0]?.cells[1]?.dailyDouble).toBe(false);
  });

  it('normalizes the simple category,question,answer,value variant case-insensitively', () => {
    const board = rowsToBoard([['Category', 'Question', 'Answer', 'Value'], ['Science', 'Q?', 'A', '$1,000']]);
    expect(board.categories[0]).toMatchObject({ name: 'Science', cells: [{ question: 'Q?', answer: 'A', value: 1000 }] });
  });

  it('derives 200-1000 values in sheet order when there is no value column', () => {
    const board = rowsToBoard([['round', 'cat', 'q', 'a', 'dd'], ['1', 'Jokes', 'Q1', 'A1', ''], ['1', 'Jokes', 'Q2', 'A2', 'TRUE']]);
    expect(board.categories[0]?.cells.map(c => c.value)).toEqual([200, 400]);
    expect(board.categories[0]?.cells[1]?.dailyDouble).toBe(true);
  });

  it('reports every bad cell with its row number', () => {
    const issues = issuesOf(() => rowsToBoard([
      ['category', 'question', 'answer', 'value'],
      ['', 'Q', 'A', '200'],
      ['Science', '', 'A', 'lots'],
    ]));
    expect(issues.join('\n')).toContain('Row 2: category is empty.');
    expect(issues.join('\n')).toContain('Row 3: question is empty.');
    expect(issues.join('\n')).toContain('value "lots" is not a whole number.');
  });

  it('rejects missing columns with guidance', () => {
    const issues = issuesOf(() => rowsToBoard([['foo', 'bar'], ['1', '2']]));
    expect(issues[0]).toContain('Missing required columns: category, question, answer.');
    expect(issues[1]).toContain('Jeopardy Labs');
  });

  it('rejects multiple rounds, over 10 categories and duplicate values', () => {
    const multi = issuesOf(() => rowsToBoard([
      ['round', 'cat', 'value', 'q', 'a'],
      ['1', 'A', '200', 'Q', 'X'],
      ['2', 'A', '400', 'Q', 'Y'],
    ]));
    expect(multi.join('\n')).toContain('2 rounds');
    const manyCats = issuesOf(() => rowsToBoard([
      ['category', 'question', 'answer', 'value'],
      ...Array.from({ length: 11 }, (_, i) => [`Cat ${i}`, 'Q', 'A', '200']),
    ]));
    expect(manyCats.join('\n')).toContain('maximum is 10');
    const dupes = issuesOf(() => rowsToBoard([
      ['category', 'question', 'answer', 'value'],
      ['Science', 'Q1', 'A1', '200'],
      ['Science', 'Q2', 'A2', '200'],
    ]));
    expect(dupes.join('\n')).toContain('two clues worth 200');
    const tooMany = issuesOf(() => rowsToBoard([
      ['category', 'question', 'answer', 'value'],
      ...Array.from({ length: 11 }, (_, i) => ['Science', `Q${i}`, 'A', `${(i + 1) * 100}`]),
    ]));
    expect(tooMany.join('\n')).toContain('has 11 clues');
  });

  it('rejects empty sheets and bad daily-double flags', () => {
    expect(issuesOf(() => rowsToBoard([]))[0]).toContain('empty');
    const issues = issuesOf(() => rowsToBoard([['round', 'cat', 'q', 'a', 'dd'], ['1', 'A', 'Q', 'X', 'maybe']]));
    expect(issues.join('\n')).toContain('not yes/no');
  });
});

describe('parseBoardFile', () => {
  it('parses a CSV upload by extension', async () => {
    const board = await parseBoardFile('board.csv', 'category,question,answer,value\nScience,Q,A,200');
    expect(board.categories[0]?.name).toBe('Science');
  });
  it('rejects unsupported and legacy formats', async () => {
    await expect(parseBoardFile('notes.txt', 'hello')).rejects.toThrow('not a supported file');
    await expect(parseBoardFile('old.xls', new Uint8Array([1, 2]))).rejects.toThrow('old .xls');
  });
});

describe('parseXlsx', () => {
  const sample = [
    ['round', 'cat', 'value', 'q', 'a', 'dd'],
    ['1', 'Keynote Speakers', '200', 'Who spoke first?', 'Noah & Evan', 'yes'],
    ['1', 'Keynote Speakers', '400', 'Second "quote"', 'Someone', ''],
  ];
  it('reads a stored (uncompressed) xlsx', async () => {
    const board = rowsToBoard(await parseXlsx(await xlsx(sample)));
    expect(board.categories[0]?.cells.map(c => [c.value, c.question, c.answer])).toEqual([
      [200, 'Who spoke first?', 'Noah & Evan'],
      [400, 'Second "quote"', 'Someone'],
    ]);
    expect(board.categories[0]?.cells[0]?.dailyDouble).toBe(true);
  });
  it('reads a deflate-compressed xlsx end to end', async () => {
    const board = await parseBoardFile('labs.xlsx', await xlsx(sample, true));
    expect(board.categories[0]?.cells).toHaveLength(2);
  });
  it('rejects a non-zip file with a clear error', async () => {
    await expect(parseXlsx(new TextEncoder().encode('not a zip at all'))).rejects.toThrow('not a valid ZIP');
  });
});
