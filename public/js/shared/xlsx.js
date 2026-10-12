// 아주 작은 Excel(.xlsx) 만들기 — 외부 라이브러리 없이 (브라우저·Node 공용)
// .xlsx 는 XML 파일 몇 개를 zip 으로 묶은 것이다. 압축 없이(stored) 묶어도 Excel 이 그대로 연다.
//
// buildXlsx([{ name: '거래 조회', rows: [[...], ...], widths: [12, 30, ...], header: 1 }])
//   rows 의 칸: 숫자 → 숫자 칸(천 단위 쉼표 서식), 글자 → 글자 칸, null/'' → 빈 칸
//   { v: 값, bold: true } 처럼 쓰면 굵게. header: 위에서 몇 줄을 굵은 머리줄로 할지 (틀 고정도 함께)
//
// 양식 모양 시트 (날짜별 사목일지)에 쓰는 것:
//   칸 { v, st: { bold, size, fill: 'EEF1F5', border: true, h: 'center', v: 'top', wrap: true, shrink: true, color: '888888', strike: true } }
//     (st 가 있으면 값이 없어도 칸을 쓴다 — 병합칸 테두리)
//   시트 { merges: ['A1:G1'], heights: { 행(0부터): pt }, breaks: [이 행부터 새 장(0부터)],
//          page: { scale: 100, margins: { top, bottom, left, right } (인치), footer: '&C&P / &N' } (A4 세로),
//          images: [{ data: Uint8Array(JPEG), x, y, cx, cy }] (시트 왼쪽 위에서 EMU) }

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const escXml = (s) => String(s)
  // XML 에 넣을 수 없는 제어 문자는 뺀다
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 0 → A, 25 → Z, 26 → AA */
export function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** 시트 이름 규칙: 31자 이하, : \ / ? * [ ] 쓸 수 없음, 겹치면 번호 */
function sheetNames(sheets) {
  const used = new Set();
  return sheets.map((s, i) => {
    let base = String(s.name || `Sheet${i + 1}`).replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 28)} (${n})`;
    used.add(name.toLowerCase());
    return name;
  });
}

/**
 * 스타일 모음: 0 보통, 1 굵게, 2 숫자(#,##0), 3 굵은 숫자, 4 머리줄(굵게·회색 바탕·가운데) 은 늘 같은 번호.
 * 양식 칸(st)은 처음 쓰일 때 번호를 하나씩 더한다.
 */
function styleBook() {
  const fonts = ['<font><sz val="11"/><name val="맑은 고딕"/><family val="2"/></font>', '<font><b/><sz val="11"/><name val="맑은 고딕"/><family val="2"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFEEF1F5"/><bgColor indexed="64"/></patternFill></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
    '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>',
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf>',
  ];
  const keys = new Map();
  const add = (list, xml) => { const i = list.indexOf(xml); return i >= 0 ? i : list.push(xml) - 1; };
  return {
    /** 양식 칸 스타일 → 번호 (isNum: 숫자 칸이면 #,##0) */
    id(st, isNum) {
      const key = JSON.stringify([st, isNum]);
      if (keys.has(key)) return keys.get(key);
      const font = add(fonts, `<font>${st.bold ? '<b/>' : ''}${st.strike ? '<strike/>' : ''}<sz val="${st.size ?? 10}"/>${st.color ? `<color rgb="FF${st.color}"/>` : ''}<name val="맑은 고딕"/><family val="2"/></font>`);
      const fill = st.fill ? add(fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${st.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
      const line = '<color rgb="FF666666"/>';
      const border = st.border ? add(borders, `<border><left style="thin">${line}</left><right style="thin">${line}</right><top style="thin">${line}</top><bottom style="thin">${line}</bottom><diagonal/></border>`) : 0;
      const align = `<alignment${st.h ? ` horizontal="${st.h}"` : ''} vertical="${st.v ?? 'center'}"${st.wrap ? ' wrapText="1"' : ''}${st.shrink ? ' shrinkToFit="1"' : ''}/>`;
      const id = xfs.push(`<xf numFmtId="${isNum ? 164 : 0}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${align}</xf>`) - 1;
      keys.set(key, id);
      return id;
    },
    xml: () => `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>
<fonts count="${fonts.length}">${fonts.join('')}</fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="${borders.length}">${borders.join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('\n')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
  };
}

function sheetXml({ rows, widths = [], header = 0, merges = [], heights = {}, breaks = [], page = null, images = [] }, styles) {
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const pane = header > 0
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${header}" topLeftCell="A${header + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : `<sheetViews><sheetView workbookViewId="0"${page ? ' showGridLines="0" view="pageLayout"' : ''}/></sheetViews>`;
  const body = rows.map((row, r) => {
    const cells = (row ?? []).map((raw, c) => {
      const cell = raw !== null && typeof raw === 'object' ? raw : { v: raw };
      const { v } = cell;
      const ref = `${colName(c)}${r + 1}`;
      const isNum = typeof v === 'number' && Number.isFinite(v);
      if (cell.st) {
        const s = styles.id(cell.st, isNum);
        if (v === null || v === undefined || v === '') return `<c r="${ref}" s="${s}"/>`;
        return isNum ? `<c r="${ref}" s="${s}"><v>${v}</v></c>`
          : `<c r="${ref}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
      }
      if (v === null || v === undefined || v === '') return '';
      const isHead = r < header;
      if (isNum) {
        const s = isHead ? 4 : cell.bold ? 3 : 2;
        return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
      }
      const s = isHead ? 4 : cell.bold ? 1 : 0;
      return `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
    }).join('');
    const ht = heights[r] ? ` ht="${heights[r]}" customHeight="1"` : '';
    return `<row r="${r + 1}"${ht}>${cells}</row>`;
  }).join('');
  const merge = merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  let tail = '';
  if (page) {
    const m = { top: 0.75, bottom: 0.6, left: 0.6, right: 0.6, ...page.margins };
    tail += '<printOptions horizontalCentered="1"/>';
    tail += `<pageMargins left="${m.left}" right="${m.right}" top="${m.top}" bottom="${m.bottom}" header="0.3" footer="0.3"/>`;
    tail += `<pageSetup paperSize="9" orientation="portrait" scale="${page.scale ?? 100}"/>`;
    if (page.footer) tail += `<headerFooter><oddFooter>${escXml(page.footer)}</oddFooter></headerFooter>`;
  }
  if (breaks.length) tail += `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${breaks.map((r) => `<brk id="${r}" max="16383" man="1"/>`).join('')}</rowBreaks>`;
  if (images.length) tail += '<drawing r:id="rId1"/>';
  return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${pane}${cols}<sheetData>${body}</sheetData>${merge}${tail}</worksheet>`;
}

// 칸 크기 → EMU (그림 자리 계산용): 너비 w 칸은 약 (w × 7 + 5) 픽셀, 1 픽셀 = 9525 EMU, 1pt = 12700 EMU
export const colEmu = (w) => Math.round((w * 7 + 5) * 9525);

/** 시트 왼쪽 위에서 x, y (EMU) → 칸 + 칸 안 위치 */
function anchorAt(x, y, widths, heights, defaultHeight = 15) {
  let col = 0;
  for (; col < 200; col++) {
    const w = colEmu(widths[col] ?? 8.43);
    if (x < w) break;
    x -= w;
  }
  let row = 0;
  for (; row < 100000; row++) {
    const h = Math.round((heights[row] ?? defaultHeight) * 12700);
    if (y < h) break;
    y -= h;
  }
  return `<xdr:col>${col}</xdr:col><xdr:colOff>${Math.round(x)}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${Math.round(y)}</xdr:rowOff>`;
}

function drawingXml(sheet) {
  const pics = sheet.images.map((im, i) => `<xdr:oneCellAnchor><xdr:from>${anchorAt(im.x, im.y, sheet.widths ?? [], sheet.heights ?? {})}</xdr:from>
<xdr:ext cx="${Math.round(im.cx)}" cy="${Math.round(im.cy)}"/>
<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="사진 ${i + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
<xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(im.cx)}" cy="${Math.round(im.cy)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>
<xdr:clientData/></xdr:oneCellAnchor>`).join('\n');
  return `${XML_HEAD}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${pics}
</xdr:wsDr>`;
}

/** JPEG 그림의 가로 · 세로 픽셀 (SOF 표시를 찾는다). 모르면 null */
export function jpegSize(bytes) {
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
  for (let p = 2; p + 9 < bytes.length;) {
    if (bytes[p] !== 0xFF) return null;
    const marker = bytes[p + 1];
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
      return { height: (bytes[p + 5] << 8) | bytes[p + 6], width: (bytes[p + 7] << 8) | bytes[p + 8] };
    }
    p += 2 + len;
  }
  return null;
}

/** 시트 목록 → .xlsx 파일 바이트 */
export function buildXlsx(sheets) {
  const names = sheetNames(sheets);
  const styles = styleBook();
  const enc = new TextEncoder();
  const sheetFiles = sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s, styles)]);
  // 그림이 있는 시트: 시트 → drawing → media 로 이어진다
  const extra = [];
  const drawings = [];
  let imageNo = 1;
  sheets.forEach((s, i) => {
    if (!s.images?.length) return;
    const n = drawings.push(i);
    extra.push([`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${n}.xml"/>
</Relationships>`]);
    extra.push([`xl/drawings/drawing${n}.xml`, drawingXml(s)]);
    extra.push([`xl/drawings/_rels/drawing${n}.xml.rels`, `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${s.images.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${imageNo + k}.jpeg"/>`).join('\n')}
</Relationships>`]);
    s.images.forEach((im, k) => extra.push([`xl/media/image${imageNo + k}.jpeg`, im.data]));
    imageNo += s.images.length;
  });
  const files = [
    ['[Content_Types].xml', `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${imageNo > 1 ? '<Default Extension="jpeg" ContentType="image/jpeg"/>\n' : ''}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
${drawings.map((_, n) => `<Override PartName="/xl/drawings/drawing${n + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join('\n')}
</Types>`],
    ['_rels/.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
    ['xl/workbook.xml', `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${escXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ['xl/styles.xml', styles.xml()],
    ...sheetFiles,
    ...extra,
  ];
  return zipStored(files.map(([name, data]) => [name, typeof data === 'string' ? enc.encode(data) : data]));
}

// ---------------------------------------------------------------- zip (압축 없이 묶기)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 압축 없는 zip 파일 (entries: [[이름, Uint8Array]]) — xlsx 와 사진 내려받기에서 쓴다 */
export function zipStored(entries) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;
  // 파일 시각: 1980-01-01 00:00 (zip 의 가장 이른 날짜. 내용과 무관)
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  for (const [name, data] of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034B50, true);
    head.setUint16(4, 20, true);         // 필요한 버전
    head.setUint16(6, 0x0800, true);     // 이름은 UTF-8
    head.setUint16(8, 0, true);          // 압축 없음
    head.setUint16(10, DOS_TIME, true);
    head.setUint16(12, DOS_DATE, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, nameBytes.length, true);
    head.setUint16(28, 0, true);
    local.push(new Uint8Array(head.buffer), nameBytes, data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014B50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, DOS_TIME, true);
    dir.setUint16(14, DOS_DATE, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);     // 이 파일의 로컬 머리 위치
    central.push(new Uint8Array(dir.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054B50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}

/** 화면의 금액 글자("1,234,000", "-20,000", "+500")를 숫자로. 숫자가 아니면 글자 그대로 */
export function cellValue(text) {
  const t = String(text ?? '').trim();
  if (/^[+-]?\d{1,3}(,\d{3})*$|^[+-]?\d+$/.test(t)) return Number(t.replace(/,/g, ''));
  return t;
}
