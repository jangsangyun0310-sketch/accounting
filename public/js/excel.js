// Excel(.xlsx) 내려받기 (거래 조회·결산서 공용)
import { buildXlsx, cellValue } from './shared/xlsx.js';

/** 시트 목록을 .xlsx 파일로 내려받는다 */
export function downloadXlsx(fileName, sheets) {
  const blob = new Blob([buildXlsx(sheets)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName.replace(/[\\/:*?"<>|]/g, '-');
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

/** 칸 너비(글자 수 기준): 숫자는 쉼표까지, 한글은 두 칸으로 센다 */
function cellWidth(cell) {
  const v = cell !== null && typeof cell === 'object' ? cell.v : cell;
  if (typeof v === 'number') return v.toLocaleString('en-US').length + 3;
  return [...String(v ?? '')].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2E80 ? 2 : 1), 0) + 2;
}

/**
 * 화면의 결산서(용지)를 시트 하나로: 제목·성당 정보 → 각 표(소제목 줄 + 표 내용).
 * 금액 칸의 "1,234" 는 숫자로 바꿔 Excel 에서 바로 계산할 수 있게 한다. 결재란은 넣지 않는다.
 */
export function reportSheet(paper, name) {
  const rows = [[{ v: name + (paper.querySelector('h1 small') ? ' (가결산)' : ''), bold: true }]];
  for (const tr of paper.querySelectorAll('.r-meta tr')) {
    rows.push([
      (tr.querySelector('th')?.textContent ?? '').replace(/\s+/g, ''),
      (tr.querySelector('td')?.textContent ?? '').replace('(인)', '').replace(/\s+/g, ' ').trim(),
    ]);
  }
  const widths = [];
  for (const el of paper.querySelectorAll('h2, table.r-table')) {
    if (el.tagName === 'H2') {
      rows.push([], [{ v: el.textContent.trim(), bold: true }]);
      continue;
    }
    for (const tr of el.querySelectorAll('tr')) {
      const head = ['THEAD', 'TFOOT'].includes(tr.parentElement.tagName);
      const row = [];
      for (const cell of tr.children) {
        const value = cellValue(cell.textContent.replace(/\s+/g, ' ').trim());
        row.push(head ? { v: value, bold: true } : value);
        for (let k = 1; k < (cell.colSpan || 1); k++) row.push(null); // 합친 칸은 빈 칸으로 자리 맞춤
      }
      rows.push(row);
      // 표 안의 가장 긴 값에 맞춘다 (제목·성당 정보 줄은 너비 계산에서 뺀다)
      row.forEach((cell, i) => { widths[i] = Math.min(42, Math.max(widths[i] ?? 8, cellWidth(cell))); });
    }
  }
  return { name, rows, widths };
}
