// 결산서 (특별회계): 주간결산서 · 월말결산서 · 금전출납부 · 총계정원장 · 봉헌자 조회 A4 미리보기와 인쇄
// 과목이 없고 통장이 과목 역할. 월 서류 셋은 결재란 하나를 함께 쓰고(설정의 '결산서' 결재란), 첫 장에만 인쇄된다.
// 월말결산서는 통장마다 수입 · 지출 내역(= 거래의 내용) × 전월누계 · 금월액 · 누계 · 비고. 비고는 직접 적어 저장한다.
// 주간결산서(주일~토요일)는 결재란을 따로 둔다.
// 서류마다 따로 인쇄해서 따로 서명받는다.
import { api, esc } from './api.js';
import { initPage, toast, reportHeadHtml } from './ui.js';
import { formatWon, sumAmounts } from './shared/money.js';
import { addDays, formatDateTimeKST, formatKoreanDate, todayKST } from './shared/dates.js';
import { downloadXlsx, reportSheet } from './excel.js';

const $ = (id) => document.getElementById(id);

const TYPES = {
  week: { title: '주간결산서', name: '주간결산서' },
  month: { title: '월말결산서', name: '월말결산서' },
  cashbook: { title: '금전출납부', name: '금전출납부' },
  gl: { title: '총계정원장', name: '총계정원장' },
  donors: { name: '봉헌자 조회' }, // 봉헌자별 1년 내역 (연말정산 준비)
};
let type = 'month';
let monthReport = null; // 기간 하나의 통장별 내역 (금전출납부 · 총계정원장은 그 달, 주간결산서는 그 주, 월말결산서는 1월부터 그 달까지)
let accountOrder = [];  // 설정의 통장 순서 (통장 id)
let notesDirty = false; // 월말결산서 비고를 고치고 아직 저장하지 않음

// 고르는 단위: 주(주일 날짜) · 달(YYYY-MM) · 해(YYYY)
const unitOf = (t) => (t === 'donors' ? 'year' : t === 'week' ? 'week' : 'month');
const isMonthly = (t) => unitOf(t) === 'month';
const currentValue = () => $(unitOf(type)).value;
const sundayOf = (d) => addDays(d, -new Date(`${d}T00:00:00Z`).getUTCDay());
const monthEnd = (ym) => addDays(`${addDays(`${ym}-01`, 31).slice(0, 7)}-01`, -1);
const md = (d) => `${d.slice(5, 7)}.${d.slice(8, 10)}`;
const sumBy = (rows, key) => sumAmounts(rows.map((x) => x[key]));

/** 결산서 종류와 달(YYYY-MM) 또는 해(YYYY)를 정하고 불러온다 */
async function load(nextType, value) {
  type = nextType;
  document.querySelectorAll('#report-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  const unit = unitOf(type);
  for (const u of ['week', 'month', 'year']) $(u).hidden = u !== unit;
  $('now').textContent = { week: '이번 주', month: '이번 달', year: '올해' }[unit];
  if (unit === 'year' && ![...$('year').options].some((o) => o.value === value)) $('year').append(new Option(`${value}년`, value));
  $(unit).value = value;
  history.replaceState(null, '', `?type=${type}&${unit}=${value}`);

  if (type === 'donors') {
    const r = await api(`/api/reports/donors?year=${value}`);
    if (type === 'donors' && String(r.year) === currentValue()) {
      donorsReport = r;
      donorsView = 'list';
      renderDonors();
    }
  } else {
    const keyOf = (t, v) => `${t === 'month' ? 'ms' : unitOf(t)}:${v}`;
    const key = keyOf(type, value);
    if (monthReport?.key !== key) {
      const [from, to, doc] = unit === 'week' ? [value, addDays(value, 6), 'week']
        : type === 'month' ? [`${value.slice(0, 4)}-01-01`, monthEnd(value), 'month'] : [`${value}-01`, monthEnd(value), 'month'];
      const [r, n] = await Promise.all([api(`/api/reports/accounts?from=${from}&to=${to}&doc=${doc}`),
        type === 'month' ? api(`/api/reports/month-notes?month=${value}`) : null]);
      monthReport = { ...r, key, notes: n?.notes ?? [] };
      notesDirty = false;
    }
    if (monthReport.key === keyOf(type, currentValue())) render();
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

/** 이전·다음 (한 주 / 한 달 / 한 해) */
function shift(dir) {
  const v = currentValue();
  if (unitOf(type) === 'week') return addDays(v, dir * 7);
  if (isMonthly(type)) return addDays(`${v}-01`, dir > 0 ? 31 : -1).slice(0, 7);
  return String(Number(v) + dir);
}
const nowValue = () => ({ week: sundayOf(todayKST()), month: todayKST().slice(0, 7), year: todayKST().slice(0, 4) })[unitOf(type)];

// ---------------------------------------------------------------- 주간결산서 · 월말결산서 · 금전출납부 · 총계정원장

/** 특별회계 통장만 (예전 일반회계 통장이 남아 있어도 빼고). 특별회계가 하나도 없으면 전부 */
function fundAccounts(r) {
  const special = r.accounts.filter((a) => a.fundCode === 'SPECIAL');
  return special.length ? special : r.accounts;
}

function render() {
  $('save-notes').hidden = type !== 'month';
  if (type === 'month') return renderMonthSheet();
  const r = monthReport;
  const closed = r.status === 'CLOSED';
  const week = type === 'week';
  const info = TYPES[type];
  document.title = `${info.name} ${week ? r.from : r.from.slice(0, 7)} - 본당살림`;
  $('state').innerHTML = closed
    ? `<span class="pill closed">마감 완료</span> <span class="muted">이 ${week ? '주' : '달'}의 모든 날이 마감되었습니다.</span>`
    : `<span class="pill open">미마감 포함</span> <span class="muted">마감되지 않은 날이 있어 가결산으로 출력됩니다.
        (마지막 마감일: ${r.closedThrough ? formatKoreanDate(r.closedThrough) : '없음'})</span>`;
  $('warning').innerHTML = '';
  const body = week
    ? `${monthTable(r, '전주이월')}<h2>주간 거래내역</h2>${cashbookTable(r, { carry: '전주이월', foot: '주 계', none: '이 주에' })}`
    : { month: monthTable, cashbook: cashbookTable, gl: ledgerSections }[type](r);
  $('paper').innerHTML = `
    <article class="report ${closed ? '' : 'provisional'}">
      ${closed ? '' : '<div class="watermark" aria-hidden="true">가결산</div>'}
      ${reportHeadHtml(`
          <h1 class="one-line">특별회계 ${info.title}${closed ? '' : ' <small>(가결산)</small>'}</h1>
          <table class="r-meta">
            <tr><th>성 당</th><td>${esc(r.parishName)}</td></tr>
            <tr><th>기 간</th><td>${periodText(r.from, r.to, week)}</td></tr>
          </table>`, r.approvalSteps, week ? 'week' : 'month')}
      ${body}
    </article>`;
  fillPage();
}

// ---------------------------------------------------------------- 한 장에 꽉 차게
// 내용이 A4 한 장보다 적으면 마지막 표에 빈 줄을 넣어 쪽 끝까지 채운다 (종이 장부처럼, 합계 줄은 맨 아래).
// 주간결산서는 빈 줄 없이, 한 장을 넘으면 서류 전체를 줄여 A4 한 장에 맞춘다.
// 화면 용지와 인쇄의 본문 폭(180mm)이 같아서 화면에서 재면 인쇄와 같다. 월 서류는 한 장을 넘으면 그대로 둔다.
const PAGE_MM = 258; // A4 297mm - 위 15mm - 아래 17mm 여백, 조금 남김
const mm = (n) => (n * 96) / 25.4;

function fillPage() {
  if (type === 'month') return; // 월말결산서는 통장마다 표가 나뉘어 채우지 않는다
  const art = $('paper').querySelector('article.report');
  const table = art && [...art.querySelectorAll('table.r-table')].pop();
  if (!table?.tBodies[0]) return;
  const zoom = $('paper').style.zoom;
  $('paper').style.zoom = '';
  art.classList.add('measuring'); // 인쇄에 안 나오는 버튼은 빼고 잰다
  const cols = [...table.tHead.rows[0].cells].reduce((n, c) => n + c.colSpan, 0);
  const add = () => table.tBodies[0].insertAdjacentHTML('beforeend', `<tr class="blank">${'<td>&nbsp;</td>'.repeat(cols)}</tr>`);
  const height = () => art.getBoundingClientRect().height;
  const before = height();
  if (type === 'week') {
    if (before > mm(PAGE_MM)) art.style.zoom = String(Math.floor((mm(PAGE_MM) / before) * 1000) / 1000);
  } else if (before < mm(PAGE_MM)) {
    add();
    const rowH = height() - before;
    const more = rowH > 0 ? Math.floor((mm(PAGE_MM) - before) / rowH) - 1 : -1;
    if (more < 0) table.tBodies[0].lastElementChild.remove();
    for (let i = 0; i < more; i++) add();
  }
  art.classList.remove('measuring');
  $('paper').style.zoom = zoom;
}

// ---------------------------------------------------------------- 월말결산서 (특별회계 결산서 양식)
// 통장마다: 수입(전년도 이월금 + 내용별) → 수입계, 지출(내용별) → 지출계, 잔액.
// 내역 = 거래의 '내용' (같은 글자끼리 한 줄, 내용이 없으면 기타), 통장끼리 옮긴 돈은 '이체 받음' · '이체 보냄'. 줄은 누계가 큰 순.
// 전월누계 = 1월 1일부터 지난달 말까지, 금월액 = 이번 달, 누계 = 둘의 합.

// 인쇄할 통장: 체크한 순서대로 인쇄 (이 컴퓨터에 기억). 처음에는 모든 통장을 설정 순서대로
const PRINT_KEY = 'bondang.monthSheetPick';
/** 인쇄할 통장 id (인쇄 순서) — list 는 지금 있는 통장 (설정 순서) */
function pickedIds(list) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PRINT_KEY)); } catch { /* 저장 불가 환경 */ }
  const ids = new Set(list.map((a) => a.id));
  return Array.isArray(saved) ? saved.filter((id) => ids.has(id)) : [...ids];
}
function setPicked(ids) {
  try { localStorage.setItem(PRINT_KEY, JSON.stringify(ids)); } catch { /* 저장 불가 환경 */ }
}
let pickList = []; // 지금 화면의 통장 (설정 순서)

/** 통장 하나의 내역 줄: [{ name, side: 'IN'|'OUT', p: 전월누계, m: 금월액 }] (누계 큰 순) */
function sheetLines(a, monthStart) {
  const map = new Map();
  for (const t of a.rows) {
    const name = t.kind === 'TRANSFER' ? (t.direction === 'IN' ? '이체 받음' : '이체 보냄') : (t.memo ?? '').trim() || '기타';
    const k = `${t.direction}:${name}`;
    const line = map.get(k) ?? { name, side: t.direction, p: 0, m: 0 };
    if (t.date < monthStart) line.p = sumAmounts([line.p, t.amount]);
    else line.m = sumAmounts([line.m, t.amount]);
    map.set(k, line);
  }
  return [...map.values()].sort((x, y) => (y.p + y.m) - (x.p + x.m) || x.name.localeCompare(y.name, 'ko'));
}

const wonCell = (n) => (n ? `<td class="amt">${formatWon(n)}</td>` : '<td class="amt nil">·</td>');

function sheetSection(a, month, notes) {
  const monthStart = `${month}-01`;
  const lines = sheetLines(a, monthStart);
  const inc = lines.filter((x) => x.side === 'IN');
  const exp = lines.filter((x) => x.side === 'OUT');
  const tot = (xs, k) => sumAmounts(xs.map((x) => x[k]));
  const iP = sumAmounts([a.prev, tot(inc, 'p')]);
  const iM = tot(inc, 'm');
  const [eP, eM] = [tot(exp, 'p'), tot(exp, 'm')];
  if (sumAmounts([iP, iM, -eP, -eM]) !== a.end) throw new Error(`통장 ${a.name}: 결산서 합계와 잔액이 맞지 않습니다.`);
  const note = (key) => `<td class="memo"><input class="note" data-acc="${a.id}" data-key="${esc(key)}" maxlength="60"
    value="${esc(notes.get(`${a.id}|${key}`) ?? '')}" aria-label="비고"></td>`;
  const fixed = (text) => `<td class="memo fixed">${text}</td>`;
  const row = (x, first, label, n) => `<tr>${first ? `<td class="grp" rowspan="${n}">${label}</td>` : ''}
      <td class="item">${esc(x.name)}</td>${wonCell(x.p)}${wonCell(x.m)}${wonCell(sumAmounts([x.p, x.m]))}${note(`${x.side}:${x.name}`)}</tr>`;
  const sumRow = (first, label, n, title, p, m, key) => `<tr class="sum">${first ? `<td class="grp" rowspan="${n}">${label}</td>` : ''}
      <td class="item">${title}</td>${wonCell(p)}${wonCell(m)}${wonCell(sumAmounts([p, m]))}${note(key)}</tr>`;
  return `
      <div class="ms-sec">
        <h2>&lt;${esc(a.name)}&gt;</h2>
        <table class="r-table ms-table">
          <colgroup><col style="width:13mm"><col style="width:36mm"><col><col><col><col style="width:40mm"></colgroup>
          <thead><tr><th>구분</th><th>내 역</th><th>전월누계</th><th>금월액</th><th>누 계</th><th>비 고</th></tr></thead>
          <tbody>
            <tr class="carry"><td class="grp" rowspan="${inc.length + 2}">수입</td><td class="item">전년도 이월금</td>
              ${wonCell(a.prev)}<td class="amt nil">·</td>${wonCell(a.prev)}${fixed('전년도 12월 잔액')}</tr>
            ${inc.map((x) => row(x, false)).join('')}
            ${sumRow(false, '', 0, '수 입 계', iP, iM, 'IN_SUM')}
            ${exp.map((x, i) => row(x, i === 0, '지출', exp.length + 1)).join('')}
            ${sumRow(!exp.length, '지출', 1, '지 출 계', eP, eM, 'OUT_SUM')}
            <tr class="bal"><td colspan="2" class="item">잔 액</td>${wonCell(sumAmounts([iP, -eP]))}${wonCell(sumAmounts([iM, -eM]))}
              ${wonCell(a.end)}${fixed('차년도 이월금')}</tr>
          </tbody>
        </table>
      </div>`;
}

function renderMonthSheet() {
  const r = monthReport;
  const month = currentValue();
  const [y, m] = month.split('-').map(Number);
  const closed = r.status === 'CLOSED';
  document.title = `월말결산서 ${month} - 본당살림`;
  $('state').innerHTML = (closed
    ? '<span class="pill closed">마감 완료</span> <span class="muted">이 달까지 모든 날이 마감되었습니다.</span>'
    : `<span class="pill open">미마감 포함</span> <span class="muted">마감되지 않은 날이 있어 가결산으로 출력됩니다.
        (마지막 마감일: ${r.closedThrough ? formatKoreanDate(r.closedThrough) : '없음'})</span>`)
    + ' <span class="muted">· 노란 칸(비고)은 적고 [비고 저장]을 누르세요.</span>';
  const order = (a) => { const i = accountOrder.indexOf(a.id); return i < 0 ? 1e9 : i; };
  const list = [...fundAccounts(r)].sort((p, q) => order(p) - order(q));
  pickList = list;
  const picked = pickedIds(list);
  const no = (id) => picked.indexOf(id) + 1; // 몇 번째로 인쇄되는지
  $('warning').innerHTML = `<div class="ms-pick">인쇄할 통장:
    ${list.map((a) => `<label><input type="checkbox" data-pick="${a.id}" ${no(a.id) ? 'checked' : ''}> ${esc(a.name)}${no(a.id)
      ? ` <span class="pick-no">${no(a.id)}</span>` : ''}</label>`).join('')}
    ${picked.length === list.length
      ? '<button type="button" class="secondary small" data-pick-all="0">모두 해제</button>'
      : '<button type="button" class="secondary small" data-pick-all="1">모두 체크</button>'}
    <span class="muted">· 체크한 순서대로 인쇄됩니다 (번호)</span></div>`;
  const notes = new Map(r.notes.map((n) => [`${n.accountId}|${n.key}`, n.note]));
  const shown = picked.map((id) => list.find((a) => a.id === id));
  $('paper').innerHTML = `
    <article class="report ms ${closed ? '' : 'provisional'}">
      ${closed ? '' : '<div class="watermark" aria-hidden="true">가결산</div>'}
      <h1 class="ms-title">${y}년 ${m}월 특별회계 결산서${closed ? '' : ' <small>(가결산)</small>'}</h1>
      ${reportHeadHtml('', r.approvalSteps, 'month')}
      ${shown.map((a) => sheetSection(a, month, notes)).join('') || '<p class="empty">인쇄할 통장을 고르세요</p>'}
    </article>`;
}

/** 비고 저장 (그 달 비고를 통째로) */
async function saveNotes() {
  const month = currentValue();
  const inputs = [...$('paper').querySelectorAll('input.note')];
  // 화면에 없는(인쇄하지 않는) 통장의 비고는 그대로 둔다
  const shownIds = new Set(inputs.map((i) => Number(i.dataset.acc)));
  const kept = monthReport.notes.filter((n) => !shownIds.has(n.accountId));
  const notes = [...kept, ...inputs.map((i) => ({ accountId: Number(i.dataset.acc), key: i.dataset.key, note: i.value.trim() }))
    .filter((n) => n.note)];
  await api('/api/reports/month-notes', { method: 'PUT', body: { month, notes } });
  monthReport.notes = notes;
  notesDirty = false;
  $('save-notes').classList.add('secondary');
  toast('비고를 저장했습니다.');
}

const WEEKDAY = ['주일', '월', '화', '수', '목', '금', '토'];
const dayName = (d) => WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()];

/** 기간: 2026년 10월 1일 ~ 10월 31일, 주간은 2026년 10월 12일(주일) ~ 10월 18일(토) */
function periodText(from, to, week) {
  const [y, m, d] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  const tail = (x) => (week ? `(${dayName(x)})` : '');
  const toMonth = week && y2 === y && m2 === m ? '' : `${m2}월 `; // 주간: 같은 달이면 10월 11일(주일) ~ 17일(토)
  return `${y}년 ${m}월 ${d}일${tail(from)} ~ ${y2 !== y ? `${y2}년 ` : ''}${toMonth}${d2}일${tail(to)}`;
}

/** 월말결산서 (주간결산서 위쪽 표도): 통장별 전월이월 · 수입 · 지출 · (이체) · 잔액 */
function monthTable(r, carry = '전월이월') {
  const list = fundAccounts(r);
  const hasTransfer = list.some((a) => a.transferIn || a.transferOut);
  const t = Object.fromEntries(['prev', 'income', 'expense', 'end'].map((k) => [k, sumBy(list, k)]));
  const xfer = (a) => a.transferIn - a.transferOut;
  return `
      <table class="r-table">
        <thead><tr><th>통장</th><th>${carry}</th><th>수입</th><th>지출</th>${hasTransfer ? '<th>이체</th>' : ''}<th>잔액</th></tr></thead>
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

function cashbookTable(r, label = { carry: '전월이월', foot: '월 계', none: '이 달에' }) {
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
          <tr class="carry"><td>${md(r.from)}</td><td></td><td>${label.carry}</td><td></td><td></td><td></td><td class="amt">${formatWon(prev)}</td></tr>
          ${rows.map((t) => `<tr><td>${md(t.date)}</td><td>${esc(t.accountName)}</td><td class="${t.kind === 'TRANSFER' ? 'xfer' : ''}">${what(t)}</td>
            <td>${esc(t.payer ?? '')}</td>
            <td class="amt">${!t.inner && t.direction === 'IN' ? formatWon(t.amount) : ''}</td>
            <td class="amt">${!t.inner && t.direction === 'OUT' ? formatWon(t.amount) : ''}</td>
            <td class="amt">${formatWon(t.total)}</td></tr>`).join('')}
          ${rows.length ? '' : '<tr><td colspan="7" class="empty">${label.none} 거래가 없습니다</td></tr>'}
        </tbody>
        <tfoot><tr><td colspan="4">${label.foot} (${rows.length}건)</td><td class="amt">${formatWon(inSum)}</td>
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
const PATTERN = { week: /^\d{4}-\d{2}-\d{2}$/, month: /^\d{4}-\d{2}$/, year: /^\d{4}$/ };
const valid = (v) => PATTERN[unitOf(type)].test(v ?? '');
// 주는 아무 날을 골라도 그 주 주일로
const go = (v) => { if (valid(v)) run(load(type, unitOf(type) === 'week' ? sundayOf(v) : v)); };

$('report-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b || b.dataset.type === type) return;
  const next = b.dataset.type;
  // 단위가 바뀌면 이번 주 · 이번 달 · 올해로, 같은 단위(월 서류끼리)면 보던 달 그대로
  const same = unitOf(next) === unitOf(type);
  const value = same ? currentValue() : { week: sundayOf(todayKST()), month: todayKST().slice(0, 7), year: todayKST().slice(0, 4) }[unitOf(next)];
  run(load(next, value));
});
for (const id of ['week', 'month', 'year']) $(id).addEventListener('change', () => go(currentValue()));
$('prev').addEventListener('click', () => go(shift(-1)));
$('next').addEventListener('click', () => go(shift(1)));
$('now').addEventListener('click', () => go(nowValue()));
// 월말결산서: 저장하지 않은 비고가 있으면 저장하고 인쇄
$('print').addEventListener('click', () => run((async () => {
  if (type === 'month' && notesDirty) await saveNotes();
  window.print();
})()));
$('save-notes').addEventListener('click', () => run(saveNotes()));
$('paper').addEventListener('input', (e) => {
  if (!e.target.classList.contains('note')) return;
  notesDirty = true;
  $('save-notes').classList.remove('secondary');
});
// 인쇄할 통장 고르기: 체크하면 맨 뒤에 붙고, 풀면 빠진다 (이 컴퓨터에 기억). 적던 비고는 화면에 남긴다
function repick(change) {
  const keep = new Map([...$('paper').querySelectorAll('input.note')].map((i) => [`${i.dataset.acc}|${i.dataset.key}`, i.value]));
  setPicked(change(pickedIds(pickList)));
  renderMonthSheet();
  for (const i of $('paper').querySelectorAll('input.note')) {
    const v = keep.get(`${i.dataset.acc}|${i.dataset.key}`);
    if (v != null) i.value = v;
  }
}
$('warning').addEventListener('change', (e) => {
  const c = e.target.closest('[data-pick]');
  if (!c) return;
  const id = Number(c.dataset.pick);
  repick((ids) => (c.checked ? [...ids.filter((x) => x !== id), id] : ids.filter((x) => x !== id)));
});
// 버튼 하나: 모두 체크되어 있으면 [모두 해제], 아니면 [모두 체크] (체크해 둔 것 뒤에 나머지를 설정 순서대로)
$('warning').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pick-all]');
  if (!b) return;
  repick((ids) => (b.dataset.pickAll === '1' ? [...ids, ...pickList.map((a) => a.id).filter((id) => !ids.includes(id))] : []));
});
addEventListener('beforeunload', (e) => { if (notesDirty) e.preventDefault(); });

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
// 결재란을 고치면 기억해 둔 것도 바꾼다 (월 서류 셋이 같은 결재란을 쓰므로)
document.addEventListener('approval-changed', (e) => {
  if (monthReport && e.detail.doc === (monthReport.key.startsWith('week') ? 'week' : 'month')) {
    monthReport.approvalSteps = e.detail.titles;
    render(); // 결재란 높이가 바뀌면 빈 줄 수도 다시
    fitPaper();
  }
});

initPage('report').then(({ settings }) => {
  accountOrder = settings.accounts.map((a) => a.id);
  const thisYear = Number(todayKST().slice(0, 4));
  const firstYear = Number((settings.parish?.startDate ?? todayKST()).slice(0, 4));
  for (let y = thisYear; y >= Math.min(firstYear, thisYear); y--) $('year').append(new Option(`${y}년`, String(y)));
  const p = new URLSearchParams(location.search);
  type = TYPES[p.get('type')] ? p.get('type') : 'month';
  const v = p.get(unitOf(type));
  if (!valid(v)) return load(type, nowValue());
  return load(type, unitOf(type) === 'week' ? sundayOf(v) : v);
}).catch((err) => {
  $('paper').innerHTML = `<p class="error">${esc(err.message)}</p>`;
});
