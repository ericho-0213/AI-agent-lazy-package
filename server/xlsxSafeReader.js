/**
 * Excel (.xlsx) Zero-OOM 安全極速解析模組 (依據 excel-safe-parser 規範)
 * 特色：
 * 1. 4-Byte 檔頭預檢 (PK\x03\x04)，防止加密檔或損壞檔阻塞網路磁碟 I/O
 * 2. 按需工作表解壓，跳過無關巨型附表
 * 3. Last-Value (</v> / </is>) 智慧截斷，自動捨棄整欄格式化造成的 104 萬空白列
 * 4. 完整支援 sharedStrings、inlineStr、超連結 (<hyperlinks>) 及 Excel 序列日期轉換
 */
const fs = require('node:fs');
const JSZip = require('jszip');

function decodeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/_x000D_/g, '');
}

function getAttr(tag, attrName) {
  const re = new RegExp(`(?:^|\\s)${attrName}="([^"]*)"`);
  const m = tag.match(re);
  return m ? decodeXml(m[1]) : '';
}

function colToNum(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n;
}

function numToCol(num) {
  let s = '';
  let n = num;
  while (n > 0) {
    const mod = (n - 1) % 26;
    s = String.fromCharCode(65 + mod) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseSharedStrings(xml) {
  const list = [];
  if (!xml) return list;
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const tm of m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
      text += decodeXml(tm[1]);
    }
    list.push(text);
  }
  return list;
}

function parseRels(xml) {
  const map = {};
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = getAttr(m[1], 'Id');
    const target = getAttr(m[1], 'Target');
    if (id && target) map[id] = target;
  }
  return map;
}

function formatPossibleExcelDate(val) {
  if (!val) return '';
  if (/^\d{5}(?:\.\d+)?$/.test(val)) {
    const n = Number(val);
    if (n >= 40000 && n <= 60000) {
      const d = new Date(Math.round((n - 25569) * 86400 * 1000));
      return d.toISOString().slice(0, 10);
    }
  }
  return val;
}

function parseWorksheetXml(sheetXml, sheetRelsXml, sharedStrings) {
  const relMap = parseRels(sheetRelsXml);
  const lastV = Math.max(sheetXml.lastIndexOf('</v>'), sheetXml.lastIndexOf('</is>'));
  const endSD = sheetXml.indexOf('</sheetData>');
  const endRowPos = lastV > 0 ? sheetXml.indexOf('</row>', lastV) : -1;

  // Last-Value 智慧截斷：切斷後方百萬筆空白格式列
  const dataXml = endRowPos > 0
    ? sheetXml.slice(0, endRowPos + 6)
    : (endSD > 0 ? sheetXml.slice(0, endSD) : sheetXml);
  const tailXml = endSD > 0 ? sheetXml.slice(endSD) : '';

  const linkByCell = {};
  for (const m of tailXml.matchAll(/<hyperlink\b([^>]*?)\/?>/g)) {
    const attrs = m[1];
    const ref = getAttr(attrs, 'ref');
    const rId = getAttr(attrs, 'r:id');
    const target = (rId && relMap[rId]) || getAttr(attrs, 'location') || '';
    if (!ref || !target) continue;
    const rm = ref.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
    if (rm) {
      const col = rm[1];
      const r1 = Number(rm[2]);
      const r2 = rm[4] ? Math.min(Number(rm[4]), r1 + 50) : r1;
      for (let r = r1; r <= r2; r++) {
        linkByCell[`${col}${r}`] = target;
      }
    }
  }

  const rows = [];
  for (const rm of dataXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rNum = Number(getAttr(rm[1], 'r')) || (rows.length + 1);
    const rowBody = rm[2];
    if (!rowBody.includes('</v>') && !rowBody.includes('</is>')) continue;

    const cells = {};
    for (const cm of rowBody.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cAttrs = cm[1];
      const cBody = cm[2] || '';
      const cellRef = getAttr(cAttrs, 'r');
      if (!cellRef) continue;
      const colLetters = (cellRef.match(/^([A-Z]+)/) || [])[1];
      if (!colLetters) continue;
      const colIdx = colToNum(colLetters);
      const cType = getAttr(cAttrs, 't');

      let text = '';
      if (cType === 'inlineStr') {
        for (const tm of cBody.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
          text += decodeXml(tm[1]);
        }
      } else {
        const vm = cBody.match(/<v>([\s\S]*?)<\/v>/);
        if (vm) {
          const rawV = decodeXml(vm[1]).trim();
          if (cType === 's') {
            text = (sharedStrings[Number(rawV)] ?? '').trim();
          } else if (cType === 'str' || cType === 'e' || cType === 'b') {
            text = rawV;
          } else {
            const num = Number(rawV);
            text = !Number.isNaN(num) ? String(Math.round(num * 10000) / 10000) : rawV;
          }
        }
      }
      const link = linkByCell[cellRef] || '';
      if (text !== '' || link !== '') {
        cells[colIdx] = { text: text.trim(), link: link.trim() };
      }
    }
    if (Object.keys(cells).length > 0) {
      rows.push({ rNum, cells });
    }
  }

  return {
    rows,
    stats: {
      rawXmlBytes: Buffer.byteLength(sheetXml, 'utf8'),
      truncatedXmlBytes: Buffer.byteLength(dataXml, 'utf8'),
      validRows: rows.length,
      hyperlinkCount: Object.keys(linkByCell).length
    }
  };
}

/**
 * 4-Byte 檔頭預檢 (PK\x03\x04)
 */
function verifyZipHeader(srcPath) {
  const head = Buffer.alloc(4);
  const fd = fs.openSync(srcPath, 'r');
  try {
    const bytesRead = fs.readSync(fd, head, 0, 4, 0);
    const hex = head.subarray(0, bytesRead).toString('hex').toUpperCase();
    const isZip = bytesRead >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    return { isZip, headerHex: hex };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 安全讀取並解析 .xlsx 指定工作表
 */
async function readWorkbookSheets(srcPath, options = {}) {
  if (!fs.existsSync(srcPath)) {
    return { success: false, error: `找不到 Excel 檔案: ${srcPath}`, sheets: {} };
  }

  const stat = fs.statSync(srcPath);
  const headerCheck = verifyZipHeader(srcPath);
  if (!headerCheck.isZip) {
    return {
      success: false,
      error: `Excel 檔案受加密保護或非標準 xlsx 格式 (Header: ${headerCheck.headerHex})`,
      headerHex: headerCheck.headerHex,
      sheets: {}
    };
  }

  const t0 = Date.now();
  const rawBuf = fs.readFileSync(srcPath);
  const zip = await JSZip.loadAsync(rawBuf);

  const ssFile = zip.file('xl/sharedStrings.xml');
  const sharedStrings = ssFile ? parseSharedStrings(await ssFile.async('string')) : [];

  const wbFile = zip.file('xl/workbook.xml');
  const wbRelsFile = zip.file('xl/_rels/workbook.xml.rels');
  if (!wbFile || !wbRelsFile) {
    return { success: false, error: '無法解析 workbook.xml', sheets: {} };
  }

  const wbXml = await wbFile.async('string');
  const wbRels = parseRels(await wbRelsFile.async('string'));
  const allSheetNames = [];
  const sheets = {};
  const sheetStats = {};

  for (const sm of wbXml.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const sheetName = getAttr(sm[1], 'name');
    const rId = getAttr(sm[1], 'r:id');
    const target = rId ? wbRels[rId] : '';
    if (!sheetName || !target) continue;
    allSheetNames.push(sheetName);

    if (typeof options.sheetFilter === 'function' && !options.sheetFilter(sheetName)) continue;

    const cleanTarget = target.replace(/^\//, '');
    const sheetPath = cleanTarget.startsWith('xl/') ? cleanTarget : `xl/${cleanTarget}`;
    const relsPath = sheetPath.replace(/worksheets\/([^/]+)$/, 'worksheets/_rels/$1.rels');

    const sf = zip.file(sheetPath);
    if (!sf) continue;

    const sheetXml = await sf.async('string');
    const rf = zip.file(relsPath);
    const sheetRelsXml = rf ? await rf.async('string') : '';

    const parsed = parseWorksheetXml(sheetXml, sheetRelsXml, sharedStrings);
    sheets[sheetName] = parsed.rows;
    sheetStats[sheetName] = parsed.stats;
  }

  return {
    success: true,
    fileSizeBytes: stat.size,
    headerHex: headerCheck.headerHex,
    elapsedMs: Date.now() - t0,
    allSheetNames,
    sheetStats,
    sheets
  };
}

/**
 * 將 parsed rows 轉成易讀表格陣列（含日期自動轉換）
 */
async function summarizeWorkbook(srcPath, { sheetName = '', maxRows = 40 } = {}) {
  const res = await readWorkbookSheets(srcPath, {
    sheetFilter: sheetName ? (name) => name === sheetName : undefined
  });
  if (!res.success) return res;

  const formattedSheets = {};
  for (const [name, rows] of Object.entries(res.sheets)) {
    const limited = rows.slice(0, maxRows);
    let maxCol = 0;
    for (const row of limited) {
      for (const cIdx of Object.keys(row.cells)) {
        maxCol = Math.max(maxCol, Number(cIdx));
      }
    }
    const headers = [];
    for (let c = 1; c <= maxCol; c++) {
      headers.push(numToCol(c));
    }
    const tableRows = limited.map((row) => {
      const obj = { _row: row.rNum };
      for (let c = 1; c <= maxCol; c++) {
        const cell = row.cells[c];
        if (!cell) {
          obj[numToCol(c)] = '';
        } else {
          const val = formatPossibleExcelDate(cell.text);
          obj[numToCol(c)] = cell.link ? `${val} [link:${cell.link}]` : val;
        }
      }
      return obj;
    });

    formattedSheets[name] = {
      totalValidRows: rows.length,
      previewRows: tableRows.length,
      stats: res.sheetStats[name],
      columns: headers,
      rows: tableRows
    };
  }

  return {
    success: true,
    filePath: srcPath,
    fileSizeKB: Math.round((res.fileSizeBytes / 1024) * 10) / 10,
    headerHex: res.headerHex,
    elapsedMs: res.elapsedMs,
    allSheetNames: res.allSheetNames,
    sheets: formattedSheets
  };
}

module.exports = {
  readWorkbookSheets,
  summarizeWorkbook,
  parseWorksheetXml,
  formatPossibleExcelDate,
  verifyZipHeader
};
