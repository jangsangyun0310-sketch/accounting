// 날짜별 사목일지 Excel: 한 달에 한 파일, 하루에 시트 한 장 (설정 → 백업·계정 → 백업)
// 시트 안은 인쇄하는 사목일지와 같은 모양 — 1쪽 사목일지(사진까지) / 2쪽 회계, A4 두 장으로 나뉘어 인쇄된다.
// 칸은 24칸 바둑판을 합쳐서 그린다 (표마다 칸 나눔이 달라도 맞출 수 있게). 금액 · 인원은 숫자 칸, 빈 칸은 가운데 점.
import { colEmu, jpegSize } from './shared/xlsx.js';
import { formatKoreanDate } from './shared/dates.js';

const COLS = 24;
const COL_W = 3.14; // 24칸 × 약 27픽셀 = A4 세로 인쇄 너비 (여백 빼고)
const MASS_KIND = { SUNDAY: '주일', WEEKDAY: '평일', WEDDING: '혼배', FUNERAL: '장례', SPECIAL: '특별' };
const DOC_DIR = { '': '·', IN: '수신', OUT: '발신' };
const SACRAMENTS = [['baptism', '세례'], ['confirmation', '견진'], ['anointing', '병자'], ['marriage', '혼인'], ['funeral', '장례'], ['communion', '봉성체']];
const FUND_SHORT = { GENERAL: '일반', SPECIAL: '특별' };
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// 칸 모양
const S = {
  title: { bold: true, size: 20, h: 'center' },
  h2: { bold: true, size: 12 },
  sub: { bold: true, size: 10 },
  th: { bold: true, size: 10, fill: 'EEF1F5', border: true, h: 'center' },
  td: { size: 10, border: true, shrink: true }, // 칸보다 긴 글은 글자를 줄여 다 보이게
  tdc: { size: 10, border: true, h: 'center' },
  num: { size: 10, border: true, h: 'right' },
  nil: { size: 10, border: true, h: 'center', color: '999999' },
  foot: { bold: true, size: 10, border: true, fill: 'F7F8FA', h: 'center' },
  footNum: { bold: true, size: 10, border: true, fill: 'F7F8FA', h: 'right' },
  cash: { bold: true, size: 10, fill: 'E3F0E6', border: true, h: 'center' }, // 현금 표 머리 (화면의 현금 색)
  note: { size: 10, border: true, v: 'top', wrap: true },
  plain: { size: 10 },
  caption: { size: 9, h: 'center' },
  wait: { size: 10, h: 'center', color: '777777', border: true },
};

/** 시트 한 장을 줄 단위로 쌓는다. 칸: { v, span, st } */
function grid() {
  const rows = [];
  const merges = [];
  const heights = {};
  const colName = (i) => String.fromCharCode(65 + i); // 24칸이라 A ~ X
  return {
    rows, merges, heights,
    get at() { return rows.length; },
    /** 한 줄: 칸 목록 (span 합이 24가 되게). 합친 칸의 나머지도 같은 모양으로 채워 테두리가 이어진다 */
    line(cells, height = 18) {
      const r = rows.length;
      const row = [];
      for (const c of cells) {
        const span = c.span ?? 1;
        const start = row.length;
        row.push({ v: c.v ?? null, st: c.st });
        for (let k = 1; k < span; k++) row.push({ v: null, st: c.st });
        if (span > 1) merges.push(`${colName(start)}${r + 1}:${colName(start + span - 1)}${r + 1}`);
      }
      rows.push(row);
      heights[r] = height;
      return r;
    },
    gap(height = 8) { heights[rows.length] = height; rows.push([]); },
    /** 위아래로 합친 칸 (결재란 서명 칸) */
    mergeDown(col, span, r1, r2) {
      // 줄마다 옆으로 합친 칸은 지우고 (Excel 은 겹친 병합을 열지 못한다) 한 덩어리로
      const inside = (m) => {
        const [, c1, a, c2, b] = m.match(/^([A-Z])(\d+):([A-Z])(\d+)$/);
        const x1 = c1.charCodeAt(0) - 65; const x2 = c2.charCodeAt(0) - 65;
        return x1 >= col && x2 <= col + span - 1 && a - 1 >= r1 && b - 1 <= r2;
      };
      for (let i = merges.length - 1; i >= 0; i--) if (inside(merges[i])) merges.splice(i, 1);
      merges.push(`${colName(col)}${r1 + 1}:${colName(col + span - 1)}${r2 + 1}`); },
    height(from, to) { let n = 0; for (let r = from; r < to; r++) n += heights[r] ?? 15; return n; },
  };
}

const cell = (v, span, st) => ({ v, span, st });
const th = (v, span) => cell(v, span, S.th);
/** 숫자 칸: 0 · 빈 값이면 가운데 점 */
const num = (n, span, st = S.num) => (n ? cell(n, span, st) : cell('·', span, S.nil));
/** 글자 칸: 비어 있으면 가운데 점 */
const txt = (v, span, st = S.td) => (v ? cell(v, span, st) : cell('·', span, S.nil));

/** 특이사항 줄 수 어림 (한글은 두 칸, 한 줄에 약 90칸) */
function noteLines(text) {
  return String(text).split('\n').reduce((n, p) => {
    const w = [...p].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2E80 ? 2 : 1), 0);
    return n + Math.max(1, Math.ceil(w / 90));
  }, 0);
}

function dataUrlBytes(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** 시트 이름: 10-11(토) */
export function daySheetName(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${date.slice(5)}(${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
}

/** 하루 사목일지 → 시트 한 장 */
export function journalDaySheet({ date, journal: j, daily: day }) {
  const g = grid();
  const images = [];

  // ---- 머리: 제목, 성당 · 날짜 · 작성자 (왼쪽) + 결재란 (오른쪽)
  g.line([cell('사 목 일 지', COLS, S.title)], 36);
  g.gap(10);
  const steps = j.approvalSteps;
  const stepW = steps.length ? Math.max(2, Math.min(3, Math.floor((COLS - 11) / steps.length))) : 0;
  const boxW = steps.length ? 2 + stepW * steps.length : 0;
  const metaW = COLS - boxW - (boxW ? 1 : 0) - 3;
  const box = (k) => (boxW ? [cell(null, 1), ...(k === 0
    ? [cell('결재', 2, S.th), ...steps.map((t) => th(t, stepW))]
    : [cell(null, 2, S.th), ...steps.map(() => cell(null, stepW, S.td))])] : []);
  const top = g.line([th('성 당', 3), cell(j.parishName, metaW, S.td), ...box(0)], 20);
  g.line([th('날 짜', 3), cell(formatKoreanDate(date), metaW, S.td), ...box(1)], 22);
  g.line([th('작성자', 3), cell(`${j.writerName}  (인)`, metaW, S.td), ...box(2)], 22);
  if (boxW) {
    const c0 = 3 + metaW + 1;
    g.mergeDown(c0, 2, top, top + 2);
    steps.forEach((_, i) => g.mergeDown(c0 + 2 + i * stepW, stepW, top + 1, top + 2));
  }

  // ---- 1. 신자 현황
  g.gap(12);
  g.line([cell('1. 신자 현황', COLS, S.h2)], 22);
  g.line([th('구분', 6), th('전입 (+)', 6), th('전출 (−)', 6), th('현재 총원', 6)]);
  for (const [label, t] of [['세대', j.households], ['인원 (명)', j.members]]) {
    const total = t.total ?? Math.max(0, t.prev + t.in - t.out);
    g.line([cell(label, 6, S.tdc), num(t.in, 6), num(t.out, 6), num(total, 6)]);
  }

  // ---- 2. 미사 (+ 주일이면 ※ 주일미사 줄)
  g.gap(12);
  g.line([cell('2. 미사', COLS, S.h2)], 22);
  g.line([th('시간', 3), th('미사', 9), th('구분', 4), th('참석 인원', 4), th('고해성사', 4)]);
  const masses = j.saved ? j.masses : [];
  for (const m of masses) g.line([txt(m.time, 3, S.tdc), txt(m.name, 9), cell(MASS_KIND[m.kind], 4, S.tdc), num(m.attendance, 4), num(m.confessions, 4)]);
  if (!masses.length) g.line([cell('·', 3, S.nil), cell('·', 9, S.nil), cell('·', 4, S.nil), cell('·', 4, S.nil), cell('·', 4, S.nil)]);
  const sumAtt = masses.reduce((n, m) => n + m.attendance, 0);
  const sumConf = masses.reduce((n, m) => n + m.confessions, 0);
  g.line([cell('합 계', 16, S.foot), num(sumAtt, 4, S.footNum), num(sumConf, 4, S.footNum)]);
  if (j.sunday) {
    const s = j.sunday;
    const people = masses.filter((m) => m.kind === 'SUNDAY').reduce((n, m) => n + m.attendance, 0) + s.saturdayAttendance;
    const off = s.subjectName && s.offering ? s.offering : 0;
    const won = (n) => n.toLocaleString('ko-KR');
    g.line([cell(`※ 주일미사(토 저녁 · 주일) 참석 ${people ? `${won(people)}명` : '·'} · ${s.subjectName ?? '주일헌금'} ${off ? `${won(off)}원` : '·'}`
      + ` · 1인당 ${off && people ? `${won(Math.round(off / people))}원` : '·'}`, COLS, S.plain)], 20);
  }

  // ---- 3. 성사
  g.gap(12);
  g.line([cell('3. 성사', COLS, S.h2)], 22);
  g.line(SACRAMENTS.map(([, l]) => th(l, 4)));
  g.line(SACRAMENTS.map(([k]) => num(j.sacraments[k], 4, S.tdc)));

  // ---- 4. 공문서 수발신
  g.gap(12);
  g.line([cell('4. 공문서 수발신', COLS, S.h2)], 22);
  g.line([th('구분', 3), th('문서번호', 5), th('수신·발신처', 6), th('제목', 10)]);
  const docs = j.documents.length ? j.documents : [{ direction: '', docNo: '', party: '', title: '' }];
  for (const x of docs) g.line([cell(DOC_DIR[x.direction], 3, x.direction ? S.tdc : S.nil), txt(x.docNo, 5), txt(x.party, 6), txt(x.title, 10)]);

  // ---- 5. 특이사항 + 사진 (사진이 없으면 아무것도 넣지 않는다)
  g.gap(12);
  g.line([cell('5. 특이사항', COLS, S.h2)], 22);
  const notes = j.notes.trim();
  g.line([notes ? cell(j.notes, COLS, S.note) : cell('·', COLS, S.nil)], Math.max(60, noteLines(j.notes) * 14 + 8));
  const photos = [...j.photos].sort((a, b) => a.slot - b.slot);
  if (photos.length) {
    g.gap(6);
    const PHOTO_H = 175; // pt
    const half = colEmu(COL_W) * 12;
    const y0 = g.height(0, g.at) * 12700;
    g.line([cell(null, COLS)], PHOTO_H);
    photos.forEach((p, i) => {
      const data = dataUrlBytes(p.image);
      const size = jpegSize(data) ?? { width: 4, height: 3 };
      const maxW = half - 12 * 9525;
      const maxH = (PHOTO_H - 6) * 12700;
      const k = Math.min(maxW / size.width, maxH / size.height);
      const cx = size.width * k;
      const cy = size.height * k;
      // 사진이 한 장이면 가운데, 두 장이면 반쪽씩 가운데
      const left = photos.length === 1 ? (half * 2 - cx) / 2 : i * half + (half - cx) / 2;
      images.push({ data, x: left, y: y0 + (PHOTO_H * 12700 - cy) / 2, cx, cy });
    });
    const caps = photos.map((p) => cell(p.caption || '', photos.length === 1 ? COLS : 12, S.caption));
    g.line(caps, 18);
  }
  const page1End = g.at;

  // ---- 2쪽: 6. 회계
  g.line([cell('6. 회계', COLS, S.h2)], 24);
  if (day.status !== 'CLOSED') {
    g.line([cell('이 날짜는 일 마감 전이라 회계 내용이 없습니다.', COLS, S.wait)], 40);
  } else {
    const sub = (t) => { g.gap(6); g.line([cell(t, COLS, S.sub)], 20); };
    sub('회계별 현황');
    g.line([th('구분', 4), th('전일잔액', 4), th('당일수입', 4), th('당일지출', 4), th('이체(±)', 4), th('당일잔액', 4)]);
    const fundLine = (label, f, foot) => g.line([cell(label, 4, foot ? S.foot : S.tdc), num(f.prev, 4, foot ? S.footNum : S.num),
      num(f.income, 4, foot ? S.footNum : S.num), num(f.expense, 4, foot ? S.footNum : S.num),
      num(f.transferIn - f.transferOut, 4, foot ? S.footNum : S.num), num(f.end, 4, S.footNum)]);
    for (const f of day.funds) fundLine(f.name, f, false);
    fundLine('합 계', day.total, true);

    for (const [label, sec] of [['수입', day.income], ['지출', day.expense]]) {
      sub(`${label} 내역`);
      g.line([th('No', 2), th('회계', 2), th('통장', 5), th('예산과목', 4), th('적요', 7), th('금액', 4)]);
      sec.rows.forEach((t, i) => g.line([cell(i + 1, 2, S.tdc), cell(FUND_SHORT[t.fundCode], 2, S.tdc), txt(t.accountName, 5),
        txt(t.subjectName, 4), txt(t.memo, 7), num(t.amount, 4)]));
      if (!sec.rows.length) g.line([cell(`${label} 내역 없음`, COLS, S.wait)]);
      g.line([cell(`${label} 합계 (${sec.rows.length}건)`, 20, S.foot), num(sec.total, 4, S.footNum)]);
    }

    if (day.transfers.rows.length) {
      sub('통장 간 이체');
      g.line([th('No', 2), th('출금 통장', 6), th('입금 통장', 6), th('적요', 6), th('금액', 4)]);
      day.transfers.rows.forEach((t, i) => g.line([cell(i + 1, 2, S.tdc), txt(`${t.fromName} (${FUND_SHORT[t.fromFund]})`, 6),
        txt(`${t.toName}${t.toFund ? ` (${FUND_SHORT[t.toFund]})` : ''}`, 6), txt(t.memo, 6), num(t.amount, 4)]));
      g.line([cell(`이체 합계 (${day.transfers.rows.length}건)`, 20, S.foot), num(day.transfers.total, 4, S.footNum)]);
    }

    const cash = day.accounts.filter((a) => a.isCash);
    if (cash.length) {
      sub('보유 현금');
      g.line([cell('현금', 4, S.cash), cell('전일잔액', 5, S.cash), cell('당일 입금', 5, S.cash), cell('당일 출금', 5, S.cash), cell('현재잔액', 5, S.cash)]);
      const lines = cash.map((a) => ({ name: a.name, prev: a.prev, in: a.income + a.transferIn, out: a.expense + a.transferOut, end: a.end }));
      for (const a of lines) g.line([cell(a.name, 4, S.tdc), num(a.prev, 5), num(a.in, 5), num(a.out, 5), num(a.end, 5, S.footNum)]);
      if (lines.length > 1) {
        const sum = (k) => lines.reduce((n, a) => n + a[k], 0);
        g.line([cell('합계', 4, S.foot), num(sum('prev'), 5, S.footNum), num(sum('in'), 5, S.footNum), num(sum('out'), 5, S.footNum), num(sum('end'), 5, S.footNum)]);
      }
    }

    sub('통장별 현재잔액');
    const banks = day.funds.map((f) => day.accounts.filter((a) => !a.isCash && a.fundCode === f.code));
    // 회계별 표를 나란히 (화면과 같이). 회계가 둘이 아니면 위아래로
    const sideBySide = day.funds.length === 2;
    const blocks = sideBySide ? [day.funds] : day.funds.map((f) => [f]);
    for (const fs of blocks) {
      const w = sideBySide ? 4 : 8;
      const lists = fs.map((f) => banks[day.funds.indexOf(f)]);
      g.line(fs.flatMap((f) => [th(`${f.name} 통장`, w), th('전일잔액', w), th('현재잔액', w)]));
      const n = Math.max(...lists.map((l) => l.length));
      for (let i = 0; i < n; i++) {
        g.line(lists.flatMap((l) => (l[i]
          ? [cell(l[i].name, w, S.td), num(l[i].prev, w), num(l[i].end, w, S.footNum)]
          : [cell(null, w, S.td), cell(null, w, S.td), cell(null, w, S.td)])));
      }
      const subSum = (l, k) => l.reduce((a, x) => a + x[k], 0);
      g.line(lists.flatMap((l) => [cell('소계', w, S.foot), num(subSum(l, 'prev'), w, S.footNum), num(subSum(l, 'end'), w, S.footNum)]));
    }
    g.gap(6);
    g.line([cell(`전체 합계${cash.length ? ' (현금 + 통장)' : ''}`, 8, S.foot), cell('전일잔액', 4, S.th), num(day.total.prev, 4),
      cell('현재잔액', 4, S.th), num(day.total.end, 4, S.footNum)], 22);
  }

  // 1쪽 · 2쪽이 각각 A4 한 장에 들어가도록 (넘치면 시트 전체를 같이 줄인다)
  const AVAIL = 700; // pt: A4 297mm − 위 25mm(철하는 자리) − 아래 여백 · 쪽 번호
  const tallest = Math.max(g.height(0, page1End), g.height(page1End, g.at));
  const scale = Math.max(40, Math.min(100, Math.floor((AVAIL / tallest) * 100)));

  return {
    name: daySheetName(date),
    widths: Array(COLS).fill(COL_W),
    rows: g.rows,
    merges: g.merges,
    heights: g.heights,
    breaks: [page1End],
    page: { scale, margins: { top: 0.98, bottom: 0.6, left: 0.5, right: 0.5 }, footer: '&C&P / &N' },
    images,
  };
}

/** 한 달 (/api/export/journals 응답) → 시트 목록 */
export function journalMonthSheets(data) {
  return data.days.map(journalDaySheet);
}
