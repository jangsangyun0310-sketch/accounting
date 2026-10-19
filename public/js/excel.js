// Excel(.xlsx) 내려받기 (거래 조회·결산서 공용)
import { buildXlsx, cellValue, colName } from './shared/xlsx.js';

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

/**
 * 화면의 결산서(용지)를 인쇄한 종이와 같은 모양의 시트 하나로:
 * 제목 · 성당 정보 · 결재란 → 소제목 · 표 (테두리, 합친 칸, 머리줄 · 합계줄 바탕색, 금액은 숫자).
 * 표 칸의 data-f 는 함수 틀이다 (금액을 고치면 합계가 따라 바뀌게). 틀 안의 낱말:
 *   {c-2} 같은 줄 왼쪽 두 번째 칸 · {r-1} 같은 칸의 바로 윗줄 · {up:3} 같은 칸 위 세 줄 범위
 *   {body} 같은 칸의 표 본문 전체 범위 · {row:in} 같은 칸, data-k="in" 줄
 * 용지(article)가 여러 장이면 장마다 새 페이지. A4 폭에 맞춰 인쇄되게 한다.
 */
export function paperSheet(paper, name) {
  const visible = (el) => !el.closest('.no-print');
  const tables = [...paper.querySelectorAll('table.r-table')];
  const cellsOf = (tr) => [...tr.children].filter(visible);
  const span = (tr) => cellsOf(tr).reduce((n, c) => n + (c.colSpan || 1), 0);
  const ncol = Math.max(2, ...tables.map((t) => Math.max(...[...t.rows].map(span))));
  // 칸 너비: 칸이 가장 많은 표의 화면 너비 비율 그대로 (A4 폭에 맞춰 인쇄되므로 비율만 맞으면 된다)
  const widths = Array(ncol).fill(12);
  const model = tables.find((t) => [...t.rows].some((tr) => span(tr) === ncol && cellsOf(tr).length === ncol));
  if (model) {
    const tr = [...model.rows].find((x) => span(x) === ncol && cellsOf(x).length === ncol);
    const px = cellsOf(tr).map((c) => c.getBoundingClientRect().width);
    // 화면에서 줄였어도(주간결산서) 비율만 쓰고, 전체 너비는 A4 한 줄 (약 95글자)
    const total = px.reduce((t, w) => t + w, 0) || 1;
    px.forEach((w, i) => { widths[i] = Math.max(4, Math.round((w / total) * 95 * 10) / 10); });
  }
  const last = colName(ncol - 1);
  const rows = [];
  const merges = [];
  const heights = {};
  const breaks = [];
  const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
  const put = (r, c, cell) => { (rows[r] ??= [])[c] = cell; };

  /** 표 하나 */
  function table(t) {
    const taken = new Set(); // 'r,c' (합친 칸이 차지한 자리)
    const order = []; // 내보낸 줄의 Excel 줄 번호 (1부터)
    const body = [];
    const keyRow = {};
    const pending = [];
    for (const tr of t.rows) {
      if (tr.classList.contains('blank')) continue; // 종이를 채우는 빈 줄
      const r = rows.length;
      rows.push([]);
      order.push(r + 1);
      const part = tr.parentElement.tagName;
      if (part === 'TBODY') body.push(r + 1);
      if (tr.dataset.k) keyRow[tr.dataset.k] = r + 1;
      let c = 0;
      for (const cell of cellsOf(tr)) {
        while (taken.has(`${r},${c}`)) c++;
        const cs = cell.colSpan || 1;
        const rs = cell.rowSpan || 1;
        const cls = cell.classList;
        const amt = cls.contains('amt');
        const input = cell.querySelector('input');
        let v = input ? input.value.trim() : text(cell);
        if (cls.contains('nil')) v = amt ? 0 : '';
        else if (amt) v = cellValue(v.replace(/원$/, ''));
        const head = cell.tagName === 'TH' || part === 'THEAD';
        const strong = head || part === 'TFOOT' || tr.classList.contains('sum') || tr.classList.contains('bal')
          || cls.contains('strong') || (tr.classList.contains('carry') && cls.contains('item'));
        const fill = head || part === 'TFOOT' || tr.classList.contains('bal') ? 'ECEEF1'
          : tr.classList.contains('sum') ? 'F4F5F7'
            : tr.classList.contains('carry') && cls.contains('item') ? 'E2E4E8' : null;
        const center = head || ['item', 'grp', 'no', 'nil', 'empty', 'fund-cell'].some((k) => cls.contains(k));
        const st = {
          border: true, size: cls.contains('memo') ? 9 : 10, bold: strong || undefined, fill: fill ?? undefined,
          h: amt ? 'right' : center ? 'center' : 'left', wrap: !amt || undefined, dot: amt || undefined,
          color: cls.contains('xfer') ? '1F4E9A' : cls.contains('ng') ? 'B42318' : undefined,
        };
        put(r, c, { v, st });
        if (cell.dataset.f) pending.push({ r, c, f: cell.dataset.f, idx: order.length - 1 });
        for (let dr = 0; dr < rs; dr++) {
          for (let dc = 0; dc < cs; dc++) {
            if (dr || dc) { taken.add(`${r + dr},${c + dc}`); if (!dr) put(r, c + dc, { v: null, st }); }
          }
        }
        if (rs > 1) for (let dr = 1; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) pending.push({ fillBorder: true, r: r + dr, c: c + dc, st });
        if (cs > 1 || rs > 1) merges.push(`${colName(c)}${r + 1}:${colName(c + cs - 1)}${r + rs}`);
        c += cs;
      }
    }
    // 합친 칸 아래쪽 자리에도 테두리 (Excel 은 합친 칸의 테두리를 칸마다 그린다)
    for (const p of pending.filter((x) => x.fillBorder)) if (!rows[p.r]?.[p.c]) put(p.r, p.c, { v: null, st: p.st });
    // 함수
    for (const p of pending.filter((x) => x.f)) {
      const col = colName(p.c);
      const at = (i) => order[i];
      let ok = true;
      const f = p.f.replace(/^=/, '').replace(/\{([^}]+)\}/g, (_, tok) => {
        let m;
        if ((m = /^c-(\d+)$/.exec(tok))) return `${colName(p.c - Number(m[1]))}${p.r + 1}`;
        if (tok === 'r-1') { if (p.idx < 1) ok = false; return `${col}${at(p.idx - 1)}`; }
        if ((m = /^up:(\d+)$/.exec(tok))) {
          const n = Number(m[1]);
          if (n < 1 || p.idx < n) { ok = false; return ''; }
          return `${col}${at(p.idx - n)}:${col}${at(p.idx - 1)}`;
        }
        if (tok === 'body') { if (!body.length) ok = false; return `${col}${body[0]}:${col}${body.at(-1)}`; }
        if ((m = /^row:(.+)$/.exec(tok))) { if (!keyRow[m[1]]) ok = false; return `${col}${keyRow[m[1]]}`; }
        ok = false;
        return '';
      });
      if (ok) rows[p.r][p.c].f = f;
    }
  }

  const arts = [...paper.querySelectorAll('article.report')];
  arts.forEach((art, i) => {
    if (i > 0) breaks.push(rows.length);
    let page = null; // 월말결산서: 화면에서 나눈 장(.ms-page)마다 새 페이지
    for (const el of art.querySelectorAll('h1, table.r-meta, table.approval-box, h2, table.r-table, p.r-note')) {
      if (!visible(el)) continue;
      const pg = el.closest('.ms-page');
      if (pg && page && pg !== page) breaks.push(rows.length);
      page = pg ?? page;
      if (el.tagName === 'H1') {
        const r = rows.length;
        put(r, 0, { v: text(el), st: { bold: true, size: 16, h: 'center' } });
        merges.push(`A${r + 1}:${last}${r + 1}`);
        heights[r] = 30;
      } else if (el.classList.contains('r-meta')) {
        for (const tr of el.rows) {
          const r = rows.length;
          put(r, 0, { v: text(tr.cells[0]).replace(/\s+/g, ''), st: { size: 10, color: '333333' } });
          put(r, 1, { v: text(tr.cells[1]).replace('(인)', '').trim(), st: { size: 10, bold: true } });
          if (ncol > 3) merges.push(`B${r + 1}:${colName(Math.min(3, ncol - 1))}${r + 1}`);
        }
      } else if (el.classList.contains('approval-box')) {
        // 결재란: 오른쪽 끝 칸들에 (결재 | 직함들), 아래 줄은 서명 칸
        const titles = [...el.querySelectorAll('th:not(.vertical)')].map(text);
        const start = Math.max(0, ncol - titles.length - 1);
        const r = rows.length;
        const st = { border: true, size: 9, h: 'center', fill: 'F2F2F2' };
        put(r, start, { v: '결재', st: { ...st, wrap: true } });
        put(r + 1, start, { v: null, st });
        merges.push(`${colName(start)}${r + 1}:${colName(start)}${r + 2}`);
        titles.forEach((t, k) => {
          put(r, start + 1 + k, { v: t, st });
          put(r + 1, start + 1 + k, { v: null, st: { border: true } });
        });
        heights[r + 1] = 48;
        rows.push([]); // 결재란 아래 한 줄 띄움
      } else if (el.tagName === 'H2') {
        rows.push([]);
        put(rows.length, 0, { v: text(el), st: { bold: true, size: 11 } });
      } else if (el.classList.contains('r-note')) {
        put(rows.length, 0, { v: text(el), st: { size: 9, color: '555555' } });
      } else {
        table(el);
      }
    }
  });
  for (let r = 0; r < rows.length; r++) rows[r] ??= [];
  // 금액이 ####### 로 보이지 않게: 숫자 칸은 가장 긴 숫자만큼은 넓게 (A4 폭 맞춤이라 비율만 바뀐다)
  for (const row of rows) {
    row.forEach((cell, c) => {
      if (typeof cell?.v === 'number') widths[c] = Math.max(widths[c], Math.abs(cell.v).toLocaleString('en-US').length + 4);
    });
  }
  return { name, rows, widths, merges, heights, breaks, page: { fitWidth: true, margins: { top: 0.6, bottom: 0.6, left: 0.5, right: 0.5 }, footer: '&C&P / &N' } };
}
