// 결산서 (특별회계): 월말결산서 · 금전출납부 · 총계정원장 · 봉헌자 조회 A4 미리보기와 인쇄
// 과목이 없고 통장이 과목 역할. 세 서류는 결재란 하나를 함께 쓰고(설정의 '결산서' 결재란), 첫 장에만 인쇄된다.
// 서류마다 따로 인쇄해서 따로 서명받는다.
import { api, esc } from './api.js';
import { initPage, toast, reportHeadHtml } from './ui.js';
import { formatWon, sumAmounts } from './shared/money.js';
import { addDays, formatDateTimeKST, formatKoreanDate, todayKST } from './shared/dates.js';
import { downloadXlsx, reportSheet } from './excel.js';

const $ = (id) => document.getElementById(id);

const TYPES = {
  month: { title: '월 말 결 산 서', name: '월말결산서' },
  cashbook: { title: '금 전 출 납 부', name: '금전출납부' },
  gl: { title: '총 계 정 원 장', name: '총계정원장' },
  donors: { name: '봉헌자 조회' }, // 봉헌자별 1년 내역 (연말정산 준비)
};
let type = 'month';
let monthReport = null; // 달 하나의 통장별 내역 (세 서류 공용)

const isMonthly = (t) => t !== 'donors';
const currentValue = () => (isMonthly(type) ? $('month').value : $('year').value);
const monthEnd = (ym) => addDays(`${addDays(`${ym}-01`, 31).slice(0, 7)}-01`, -1);
const md = (d) => `${d.slice(5, 7)}.${d.slice(8, 10)}`;
const sumBy = (rows, key) => sumAmounts(rows.map((x) => x[key]));

/** 결산서 종류와 달(YYYY-MM) 또는 해(YYYY)를 정하고 불러온다 */
async function load(nextType, value) {
  type = nextType;
  document.querySelectorAll('#report-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  $('month').hidden = !isMonthly(type);
  $('year').hidden = isMonthly(type);
  $('now').textContent = isMonthly(type) ? '이번 달' : '올해';
  if (isMonthly(type)) {
    $('month').value = value;
  } else {
    if (![...$('year').options].some((o) => o.value === value)) $('year').append(new Option(`${value}년`, value));
    $('year').value = value;
  }
  history.replaceState(null, '', `?type=${type}&${isMonthly(type) ? 'month' : 'year'}=${value}`);

  if (type === 'donors') {
    const r = await api(`/api/reports/donors?year=${value}`);
    if (type === 'donors' && String(r.year) === currentValue()) {
      donorsReport = r;
      donorsView = 'list';
      renderDonors();
    }
  } else {
    if (monthReport?.month !== value) {
      const r = await api(`/api/reports/accounts?from=${value}-01&to=${monthEnd(value)}&doc=month`);
      monthReport = { ...r, month: value };
    }
    if (isMonthly(type) && monthReport.month === currentValue()) render();
  }
  fitPaper();
}

// 휴대폰: A4 용지를 화면 폭에 맞춰 줄여 한눈에 보이게 (손가락으로 벌리면 확대). 인쇄할 때는 원래 크기
function fitPaper() {
  const paper = $('paper');
  paper.style.zoom = '';
  const room = document.documentElement.clientWidth - 16;
  if (room < 720 && paper.offsetWidth > room) paper.style.zoom = String(room / paper.offsetWidth);
}
addEventListener('resize', fitPaper);
addEventListener('beforeprint', () => { $('paper').style.zoom = ''; });
addEventListener('afterprint', fitPaper);

/** 이전·다음 (한 달 / 한 해) */
function shift(dir) {
  const v = currentValue();
  if (isMonthly(type)) return addDays(`${v}-01`, dir > 0 ? 31 : -1).slice(0, 7);
  return String(Number(v) + dir);
}
const nowValue = () => (isMonthly(type) ? todayKST().slice(0, 7) : todayKST().slice(0, 4));

// ---------------------------------------------------------------- 월말결산서 · 금전출납부 · 총계정원장

/** 특별회계 통장만 (예전 일반회계 통장이 남아 있어도 빼고). 특별회계가 하나도 없으면 전부 */
function fundAccounts(r) {
  const special = r.accounts.filter((a) => a.fundCode === 'SPECIAL');
  return special.length ? special : r.accounts;
}

function render() {
  const r = monthReport;
  const closed = r.status === 'CLOSED';
  const [y, m] = r.month.split('-').map(Number);
  const info = TYPES[type];
  document.title = `${info.name} ${r.month} - 본당살림`;
  $('state').innerHTML = closed
    ? '<span class="pill closed">마감 완료</span> <span class="muted">이 달의 모든 날이 마감되었습니다.</span>'
    : `<span class="pill open">미마감 포함</span> <span class="muted">마감되지 않은 날이 있어 가결산으로 출력됩니다.
        (마지막 마감일: ${r.closedThrough ? formatKoreanDate(r.closedThrough) : '없음'})</span>`;
  $('warning').innerHTML = '';
  const body = { month: monthTable, cashbook: cashbookTable, gl: ledgerSections }[type](r);
  $('paper').innerHTML = `
    <article class="report ${closed ? '' : 'provisional'}">
      ${closed ? '' : '<div class="watermark" aria-hidden="true">가결산</div>'}
      ${reportHeadHtml(`
          <h1>특별회계 ${info.title}${closed ? '' : ' <small>(가결산)</small>'}</h1>
          <table class="r-meta">
            <tr><th>성 당</th><td>${esc(r.parishName)}</td></tr>
            <tr><th>기 간</th><td>${y}년 ${m}월 1일 ~ ${m}월 ${Number(r.to.slice(8))}일</td></tr>
            <tr><th>작성자</th><td>${esc(r.writerName)}<span class="seal">(인)</span></td></tr>
          </table>`, r.approvalSteps, 'month')}
      ${body}
    </article>`;
}

/** 월말결산서: 통장별 전월이월 · 수입 · 지출 · (이체) · 잔액 */
function monthTable(r) {
  const list = fundAccounts(r);
  const hasTransfer = list.some((a) => a.transferIn || a.transferOut);
  const t = Object.fromEntries(['prev', 'income', 'expense', 'end'].map((k) => [k, sumBy(list, k)]));
  const xfer = (a) => a.transferIn - a.transferOut;
  return `
      <table class="r-table">
        <thead><tr><th>통장</th><th>전월이월</th><th>수입</th><th>지출</th>${hasTransfer ? '<th>이체</th>' : ''}<th>잔액</th></tr></thead>
        <tbody>${list.map((a) => `
          <tr><td>${esc(a.name)}</td><td class="amt">${formatWon(a.prev)}</td><td class="amt">${formatWon(a.income)}</td>
            <td class="amt">${formatWon(a.expense)}</td>${hasTransfer ? `<td class="amt">${xfer(a) > 0 ? '+' : ''}${formatWon(xfer(a))}</td>` : ''}
            <td class="amt strong">${formatWon(a.end)}</td></tr>`).join('')
          || `<tr><td colspan="${hasTransfer ? 6 : 5}" class="empty">등록된 통장이 없습니다</td></tr>`}
        </tbody>
        <tfoot><tr><td>합 계</td><td class="amt">${formatWon(t.prev)}</td><td class="amt">${formatWon(t.income)}</td>
          <td class="amt">${formatWon(t.expense)}</td>${hasTransfer ? `<td class="amt">${formatWon(sumBy(list, 'transferIn') - sumBy(list, 'transferOut'))}</td>` : ''}
          <td class="amt">${formatWon(t.end)}</td></tr></tfoot>
      </table>
      ${hasTransfer ? '<p class="r-note">※ 이체는 통장끼리 옮긴 돈입니다 (+ 받음, − 보냄). 수입 · 지출에 넣지 않습니다.</p>' : ''}`;
}

/**
 * 금전출납부 한 줄씩: 모든 통장의 거래를 날짜순으로, 잔액은 특별회계 전체 잔액.
 * 특별회계 통장끼리의 이체는 한 줄(보낸 쪽)로만, 전체 잔액은 그대로.
 */
function cashbookRows(r) {
  const list = fundAccounts(r);
  const names = new Set(list.map((a) => a.name));
  const rows = list.flatMap((a) => a.rows.map((t) => ({ ...t, accountName: a.name })))
    .filter((t) => !(t.kind === 'TRANSFER' && t.direction === 'IN' && names.has(t.counterpartName)))
    .sort((p, q) => (p.date === q.date ? p.id - q.id : p.date < q.date ? -1 : 1));
  let balance = sumBy(list, 'prev');
  return rows.map((t) => {
    const inner = t.kind === 'TRANSFER' && names.has(t.counterpartName);
    if (!inner) balance = sumAmounts([balance, t.direction === 'IN' ? t.amount : -t.amount]);
    return { ...t, inner, total: balance };
  });
}

function cashbookTable(r) {
  const list = fundAccounts(r);
  const rows = cashbookRows(r);
  const prev = sumBy(list, 'prev');
  const end = sumBy(list, 'end');
  const what = (t) => {
    if (t.inner) return `이체: ${esc(t.accountName)} → ${esc(t.counterpartName)} ${formatWon(t.amount)}원${t.memo ? ` · ${esc(t.memo)}` : ''}`;
    if (t.kind === 'TRANSFER') return `이체 ${t.direction === 'OUT' ? '→' : '←'} ${esc(t.counterpartName ?? '')}${t.memo ? ` · ${esc(t.memo)}` : ''}`;
    return esc(t.memo ?? '');
  };
  const inSum = sumAmounts(rows.filter((t) => !t.inner && t.direction === 'IN').map((t) => t.amount));
  const outSum = sumAmounts(rows.filter((t) => !t.inner && t.direction === 'OUT').map((t) => t.amount));
  return `
      <table class="r-table fixed">
        <colgroup><col style="width:13mm"><col style="width:32mm"><col><col style="width:22mm">
          <col style="width:22mm"><col style="width:22mm"><col style="width:25mm"></colgroup>
        <thead><tr><th>날짜</th><th>통장</th><th>내용</th><th>봉헌자</th><th>수입</th><th>지출</th><th>잔액</th></tr></thead>
        <tbody>
          <tr class="carry"><td>${md(r.from)}</td><td></td><td>전월이월</td><td></td><td></td><td></td><td class="amt">${formatWon(prev)}</td></tr>
          ${rows.map((t) => `<tr><td>${md(t.date)}</td><td>${esc(t.accountName)}</td><td class="${t.kind === 'TRANSFER' ? 'xfer' : ''}">${what(t)}</td>
            <td>${esc(t.payer ?? '')}</td>
            <td class="amt">${!t.inner && t.direction === 'IN' ? formatWon(t.amount) : ''}</td>
            <td class="amt">${!t.inner && t.direction === 'OUT' ? formatWon(t.amount) : ''}</td>
            <td class="amt">${formatWon(t.total)}</td></tr>`).join('')}
          ${rows.length ? '' : '<tr><td colspan="7" class="empty">이 달에 거래가 없습니다</td></tr>'}
        </tbody>
        <tfoot><tr><td colspan="4">월 계 (${rows.length}건)</td><td class="amt">${formatWon(inSum)}</td>
          <td class="amt">${formatWon(outSum)}</td><td class="amt">${formatWon(end)}</td></tr></tfoot>
      </table>`;
}

/** 총계정원장: 통장마다 한 덩어리 (전월이월 → 거래 · 잔액 → 월계), 한 서류로 묶음 */
function ledgerSections(r) {
  return fundAccounts(r).map((a, i) => `
      <h2>${i + 1}. ${esc(a.name)}</h2>
      <table class="r-table fixed">
        <colgroup><col style="width:13mm"><col><col style="width:24mm"><col style="width:24mm"><col style="width:24mm"><col style="width:26mm"></colgroup>
        <thead><tr><th>날짜</th><th>내용</th><th>봉헌자</th><th>수입</th><th>지출</th><th>잔액</th></tr></thead>
        <tbody>
          <tr class="carry"><td>${md(r.from)}</td><td>전월이월</td><td></td><td></td><td></td><td class="amt">${formatWon(a.prev)}</td></tr>
          ${a.rows.map((t) => `<tr><td>${md(t.date)}</td>
            <td class="${t.kind === 'TRANSFER' ? 'xfer' : ''}">${t.kind === 'TRANSFER' ? `이체 ${t.direction === 'OUT' ? '→' : '←'} ${esc(t.counterpartName ?? '')}${t.memo ? ' · ' : ''}` : ''}${esc(t.memo ?? '')}</td>
            <td>${esc(t.payer ?? '')}</td>
            <td class="amt">${t.direction === 'IN' ? formatWon(t.amount) : ''}</td>
            <td class="amt">${t.direction === 'OUT' ? formatWon(t.amount) : ''}</td>
            <td class="amt">${formatWon(t.balance)}</td></tr>`).join('')}
        </tbody>
        <tfoot><tr><td colspan="3">월 계 (${a.rows.length}건)</td><td class="amt">${formatWon(a.in)}</td>
          <td class="amt">${formatWon(a.out)}</td><td class="amt">${formatWon(a.end)}</td></tr></tfoot>
      </table>`).join('') || '<p class="empty">등록된 통장이 없습니다</p>';
}

// ---------------------------------------------------------------- 봉헌자 조회 (특별회계 수입의 봉헌자별)

let donorsReport = null;
let donorsView = 'list'; // 'list' 사람별 목록 · 'all' 전체 내역서 · 그 밖은 봉헌자 이름 (그 사람 내역서)
const dotDate = (d) => `${d.slice(0, 4)}. ${Number(d.slice(5, 7))}. ${Number(d.slice(8, 10))}.`;

function donorHead(r, title, payer) {
  return reportHeadHtml(`
          <h1>${title}</h1>
          <table class="r-meta">
            <tr><th>성 당</th><td>${esc(r.parishName)}</td></tr>
            <tr><th>기 간</th><td>${formatKoreanDate(r.from)} ~ ${formatKoreanDate(r.to)} <span class="range">(특별회계)</span></td></tr>
            ${payer == null ? '' : `<tr><th>봉헌자</th><td><b>${esc(payer)}</b></td></tr>`}
          </table>`, r.approvalSteps, 'donors');
}

/** 한 사람 내역서: 날짜 · 통장 · 내용 · 금액, 통장별 합계와 합계 (주민등록번호 칸 없음) */
function donorSheet(r, p) {
  return `
    <article class="report donor-sheet">
      ${donorHead(r, '봉 헌 내 역', p.payer)}
      <h2>1. 봉헌 내역</h2>
      <table class="r-table fixed">
        <colgroup><col style="width:10mm"><col style="width:32mm"><col style="width:42mm"><col><col style="width:32mm"></colgroup>
        <thead><tr><th class="no">No</th><th>날짜</th><th>통장</th><th>내용</th><th>금액</th></tr></thead>
        <tbody>${p.rows.map((x, i) => `
          <tr><td class="no">${i + 1}</td><td>${dotDate(x.date)}</td><td>${esc(x.subjectName)}</td><td>${esc(x.memo ?? '')}</td>
            <td class="amt">${formatWon(x.amount)}</td></tr>`).join('')}</tbody>
      </table>
      <h2>2. 통장별 합계</h2>
      <table class="r-table fixed">
        <colgroup><col><col style="width:30mm"><col style="width:40mm"></colgroup>
        <thead><tr><th>통장</th><th>건수</th><th>금액</th></tr></thead>
        <tbody>${p.bySubject.map((s) => `<tr><td>${esc(s.name)}</td><td class="amt">${s.count}</td><td class="amt">${formatWon(s.total)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>합 계</td><td class="amt">${p.count}</td><td class="amt">${formatWon(p.total)}</td></tr></tfoot>
      </table>
    </article>`;
}

function renderDonors() {
  const r = donorsReport;
  const closed = r.status === 'CLOSED';
  document.title = `봉헌자 조회 ${r.year} - 본당살림`;
  $('state').innerHTML = (closed ? '<span class="pill closed">마감 완료</span>' : '<span class="pill open">미마감 포함</span>')
    + ' <span class="muted">이름을 치면 그 사람만 남습니다. [내역서]를 누르면 한 해 봉헌 내역이 나옵니다.</span>';
  $('warning').innerHTML = '';
  if (donorsView !== 'list') {
    const list = donorsView === 'all' ? r.people : r.people.filter((p) => p.payer === donorsView);
    $('paper').innerHTML = `
      <p class="no-print donor-back"><button type="button" class="secondary small" data-donor-view="list">← 봉헌자 목록</button>
        ${donorsView === 'all' ? `<span class="muted">${list.length}명 · 인쇄하면 한 사람에 한 장씩 나옵니다</span>` : ''}</p>
      ${list.map((p) => donorSheet(r, p)).join('') || '<p class="muted">내역이 없습니다.</p>'}`;
    return;
  }
  $('paper').innerHTML = `
    <article class="report">
      ${donorHead(r, '봉헌자별 현황', null)}
      <p class="no-print donor-tools">
        <input type="search" id="donor-find" placeholder="봉헌자 이름" aria-label="봉헌자 이름" value="${esc(donorQuery)}">
        <button type="button" class="secondary" data-donor-view="all" ${r.people.length ? '' : 'disabled'}>전체 내역서 (한 사람 한 장)</button>
      </p>
      <table class="r-table fixed donor-list">
        <colgroup><col style="width:10mm"><col><col style="width:22mm"><col style="width:36mm"><col class="no-print" style="width:58mm"></colgroup>
        <thead><tr><th class="no">No</th><th>봉헌자</th><th>건수</th><th>합계</th><th class="no-print"></th></tr></thead>
        <tbody>${r.people.map((p, i) => `
          <tr data-name="${esc(p.payer)}"><td class="no">${i + 1}</td><td>${esc(p.payer)}</td><td class="amt">${p.count}</td><td class="amt">${formatWon(p.total)}</td>
            <td class="no-print"><button type="button" class="secondary small" data-donor-view="${esc(p.payer)}">내역서</button>
              ${p.similar.length ? `<span class="similar">비슷한 이름: ${p.similar.map(esc).join(', ')}</span>` : ''}</td></tr>`).join('')
          || '<tr><td colspan="5" class="empty">봉헌자를 적은 수입이 없습니다</td></tr>'}</tbody>
        <tfoot><tr><td colspan="2">합 계 (${r.people.length}명)</td><td class="amt">${r.people.reduce((n, p) => n + p.count, 0)}</td><td class="amt">${formatWon(r.total)}</td><td class="no-print"></td></tr></tfoot>
      </table>
    </article>`;
  filterDonors();
  const find = $('donor-find');
  find.focus();
  find.setSelectionRange(find.value.length, find.value.length);
}

let donorQuery = '';
function filterDonors() {
  for (const tr of $('paper').querySelectorAll('.donor-list tbody tr[data-name]')) {
    tr.hidden = Boolean(donorQuery) && !tr.dataset.name.includes(donorQuery);
  }
}

/** 봉헌자 Excel: 사람별 합계 시트 + 모든 봉헌 내역 시트 (금액은 숫자) */
function donorsSheets() {
  const r = donorsReport;
  const b = (v) => ({ v, bold: true });
  const meta = [[b(`봉헌자별 내역 ${r.year}년 (특별회계)`)], ['성당', r.parishName], []];
  return [
    { name: '사람별 합계', widths: [6, 24, 8, 16],
      rows: [...meta, ['No', '봉헌자', '건수', '합계'].map(b), ...r.people.map((p, i) => [i + 1, p.payer, p.count, p.total]),
        [b('합계'), null, b(r.people.reduce((n, p) => n + p.count, 0)), b(r.total)]] },
    { name: '봉헌 내역', widths: [24, 12, 22, 24, 14],
      rows: [...meta, ['봉헌자', '날짜', '통장', '내용', '금액'].map(b),
        ...r.people.flatMap((p) => [...p.rows.map((x) => [p.payer, x.date, x.subjectName, x.memo ?? '', x.amount]),
          [b(`${p.payer} 합계`), null, null, null, b(p.total)]])] },
  ];
}

$('paper').addEventListener('click', (e) => {
  const b = e.target.closest('[data-donor-view]');
  if (!b || type !== 'donors') return;
  donorsView = b.dataset.donorView;
  renderDonors();
  window.scrollTo(0, 0);
});
$('paper').addEventListener('input', (e) => {
  if (e.target.id !== 'donor-find') return;
  donorQuery = e.target.value.trim();
  filterDonors();
});
// 이름을 치고 Enter: 한 사람만 남았으면 그 사람 내역서를 바로 연다
$('paper').addEventListener('keydown', (e) => {
  if (e.target.id !== 'donor-find' || e.key !== 'Enter' || e.isComposing) return;
  const shown = [...$('paper').querySelectorAll('.donor-list tbody tr[data-name]')].filter((tr) => !tr.hidden);
  if (shown.length === 1) {
    donorsView = shown[0].dataset.name;
    renderDonors();
  }
});

// ---------------------------------------------------------------- 이벤트

const run = (p) => p.catch((err) => toast(err.message, 'error'));
const valid = (v) => (isMonthly(type) ? /^\d{4}-\d{2}$/.test(v) : /^\d{4}$/.test(v));
const go = (v) => { if (valid(v)) run(load(type, v)); };

$('report-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b || b.dataset.type === type) return;
  const next = b.dataset.type;
  // 월 ↔ 해: 보던 달의 해, 보던 해가 올해면 이번 달 아니면 그 해 12월
  const v = currentValue();
  let value = v;
  if (isMonthly(type) && !isMonthly(next)) value = v.slice(0, 4);
  if (!isMonthly(type) && isMonthly(next)) value = todayKST().startsWith(v) ? todayKST().slice(0, 7) : `${v}-12`;
  run(load(next, value));
});
for (const id of ['month', 'year']) $(id).addEventListener('change', () => go(currentValue()));
$('prev').addEventListener('click', () => go(shift(-1)));
$('next').addEventListener('click', () => go(shift(1)));
$('now').addEventListener('click', () => go(nowValue()));
$('print').addEventListener('click', () => window.print());

// 보고 있는 결산서를 Excel 로 (표 내용 그대로, 금액은 숫자로)
$('excel').addEventListener('click', () => {
  if (!$('paper').querySelector('.report')) return;
  if (type === 'donors') {
    downloadXlsx(`본당살림 봉헌자별 내역 ${donorsReport.year}.xlsx`, donorsSheets());
    return;
  }
  const name = `특별회계 ${TYPES[type].name}`;
  downloadXlsx(`본당살림 ${name} ${currentValue()}.xlsx`, [reportSheet($('paper'), name)]);
});

// 인쇄할 때마다 종이 오른쪽 아래에 출력 일시를 찍는다 (Ctrl+P 로 인쇄해도 같음)
const printedAt = document.createElement('style');
document.head.append(printedAt);
window.addEventListener('beforeprint', () => {
  printedAt.textContent = `@page { @bottom-right { content: "출력 일시 ${formatDateTimeKST(new Date().toISOString())}"; font-size: 8pt; color: #555; } }`;
});
// 결재란을 고치면 다시 불러온다 (세 서류가 같은 결재란을 쓰므로)
document.addEventListener('approval-changed', (e) => {
  if (monthReport && e.detail.doc === 'month') monthReport.approvalSteps = e.detail.titles;
});

initPage('report').then(({ settings }) => {
  const thisYear = Number(todayKST().slice(0, 4));
  const firstYear = Number((settings.parish?.startDate ?? todayKST()).slice(0, 4));
  for (let y = thisYear; y >= Math.min(firstYear, thisYear); y--) $('year').append(new Option(`${y}년`, String(y)));
  const p = new URLSearchParams(location.search);
  type = TYPES[p.get('type')] ? p.get('type') : 'month';
  const v = p.get(isMonthly(type) ? 'month' : 'year');
  return load(type, v && valid(v) ? v : nowValue());
}).catch((err) => {
  $('paper').innerHTML = `<p class="error">${esc(err.message)}</p>`;
});
