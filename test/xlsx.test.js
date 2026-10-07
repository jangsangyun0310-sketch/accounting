// Excel(.xlsx) 만들기: zip 구조·CRC·XML 내용, 금액 글자 → 숫자
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx, cellValue, crc32 } from '../public/js/shared/xlsx.js';

/** 압축 없는 zip 을 풀어 { 이름: 글자 } 로 (중앙 목록 기준, CRC 확인) */
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054B50);
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(p, true), 0x02014B50);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const offset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const localName = view.getUint16(offset + 26, true);
    const data = bytes.subarray(offset + 30 + localName, offset + 30 + localName + size);
    assert.equal(crc32(data), crc, name);
    files[name] = new TextDecoder().decode(data);
    p += 46 + nameLen;
  }
  return files;
}

test('xlsx: 필요한 파일이 모두 있고, 숫자는 숫자 칸·글자는 글자 칸, 특수문자는 안전하게', () => {
  const files = unzip(buildXlsx([
    { name: '거래 조회', header: 1, widths: [12, 20], rows: [['날짜', '금액'], ['2026-10-01', 150000], ['<김&이>', -20000], [null, ''], [{ v: '합계', bold: true }, { v: 130000, bold: true }]] },
    { name: '거래 조회', rows: [['둘째']] },
    { name: 'a/b:c*?[x]', rows: [['이름 규칙']] },
  ]));
  assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels',
    'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml']);
  const s1 = files['xl/worksheets/sheet1.xml'];
  assert.match(s1, /<c r="B2" s="2"><v>150000<\/v><\/c>/);
  assert.match(s1, /<c r="B3" s="2"><v>-20000<\/v><\/c>/);
  assert.match(s1, /&lt;김&amp;이&gt;/);
  assert.match(s1, /<c r="A1" t="inlineStr" s="4">/); // 머리줄
  assert.match(s1, /<c r="B5" s="3">/); // 굵은 숫자
  assert.match(s1, /state="frozen"/);
  assert.doesNotMatch(s1, /r="A4"/); // 빈 칸은 쓰지 않는다
  assert.match(files['xl/workbook.xml'], /name="거래 조회".*name="거래 조회 \(2\)".*name="a b c +x"/);
});

test('화면 금액 글자 → 숫자, 나머지는 글자 그대로', () => {
  assert.equal(cellValue('1,234,000'), 1234000);
  assert.equal(cellValue('-20,000'), -20000);
  assert.equal(cellValue('+500'), 500);
  assert.equal(cellValue('0'), 0);
  assert.equal(cellValue('25.0%'), '25.0%');
  assert.equal(cellValue('2026-10-01'), '2026-10-01');
  assert.equal(cellValue('12,34'), '12,34');
});
