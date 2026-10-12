// 거래 조회 화면: 기간·통장·과목·구분·검색어로 거래를 찾고, 통장 선택 시 잔액 흐름을 보여준다.
// 보기: 기본 / 날짜별(날짜마다 소계) / 수입 · 지출별(표를 따로) — 고른 보기는 이 브라우저에 기억한다
import { href } from './base.js';
import { api, esc } from './api.js';
import { initPage, personName, toast, typeLabel, FUND_LABEL } from './ui.js';
import { formatWon } from './shared/money.js';
import { addDays, monthStart, todayKST } from './shared/dates.js';
import { downloadXlsx } from './excel.js';

const $ = (id) => document.getElementById(id);
let settings = null;

function fillFilters() {
  $('account').innerHTML = '<option value="">전체</option>' + ['GENERAL', 'SPECIAL'].map((fund) => {
    const list = settings.accounts.filter((a) => a.fundCode === fund);
    return list.length ? `<optgroup label="${FUND_LABEL[fund]}">${list.map((a) =>
      `<option value="${a.id}" ${a.isCash ? 'class="cash-opt"' : ''}>${esc(a.name)}${a.isCash && !a.name.includes('현금') ? ' (현금)' : ''}${a.isActive ? '' : ' (사용중지)'}</option>`).join('')}</optgroup>` : '';
  }).join('');
  $('subject').innerHTML = '<option value="">전체</option>' + [['INCOME', '수입'], ['EXPENSE', '지출']].map(([k, label]) =>
    `<optgroup label="${label}">${settings.subjects.filter((s) => s.kind === k).map((s) =>
      `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</optgroup>`).join('');
}

function setRange(range) {
  const today = todayKST();
  if (range === 'today') { $('from').value = today; $('to').value = today; }
  if (range === 'month') { $('from').value = monthStart(today); $('to').value = today; }
  if (range === 'last-month') {
    const lastDay = addDays(monthStart(today), -1);
    $('from').value = monthStart(lastDay);
    $('to').value = lastDay;
  }
}

async function search() {
  const params = new URLSearchParams({ from: $('from').value, to: $('to').value });
  for (const [key, id] of [['accountId', 'account'], ['subjectId', 'subject'], ['kind', 'kind'], ['q', 'q']]) {
    if ($(id).value.trim()) params.set(key, $(id).value.trim());
  }
  history.replaceState(null, '', `?${params}`);
  try {
    render(await api(`/api/transactions?${params}`), params.has('accountId'));
  } catch (err) {
    toast(err.message, 'error');
  }
}

let last = null; // Excel 로 내려받을 마지막 조회 결과

/** 특별회계 수입이면 납부자 + [이름 고치기] (마감한 날도 이름만은 고칠 수 있다) */
const canHavePayer = (r) => r.kind === 'NORMAL' && r.direction === 'IN' && r.fundCode === 'SPECIAL';
function payerCell(r) {
  if (!canHavePayer(r)) return '';
  return `<div class="payer-row" data-id="${r.id}">
    ${r.payer ? `<span class="payer-name" title="납부자">${esc(r.payer)}</span>` : '<span class="muted small">납부자 없음</span>'}
    <button type="button" class="link-btn payer-edit">이름 고치기</button></div>`;
}

// 보기: 기본(list) / 날짜별(date: 날짜마다 묶고 소계) / 수입·지출별(kind: 수입 · 지출 · 이체 표를 따로, 표마다 합계)
const VIEWS = [['list', '기본'], ['date', '날짜별'], ['kind', '수입 · 지출별']];
let view = 'list';
try { view = localStorage.getItem('ledger-view') || 'list'; } catch { /* 저장소를 못 쓰면 기본 */ }
if (!VIEWS.some(([k]) => k === view)) view = 'list';

const isDeposit = (r) => r.direction === 'IN';
/** 입금 칸 금액 (수입 차감은 마이너스), 출금 칸 금액 */
const inAmount = (r) => (isDeposit(r) ? r.amount : r.deduction ? -r.amount : 0);
const outAmount = (r) => (!isDeposit(r) && !r.deduction ? r.amount : 0);
/** 수입 · 지출별 보기의 나눔: 수입(차감 포함) · 지출 · 이체 */
const kindGroup = (r) => (r.kind === 'TRANSFER' ? 'TRANSFER' : isDeposit(r) || r.deduction ? 'IN' : 'OUT');
const KIND_GROUPS = [['IN', '수입'], ['OUT', '지출'], ['TRANSFER', '이체']];

/** 날짜 → "10월 4일 (일)" */
function dayLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${m}월 ${d}일 (${'일월화수목금토'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
}
const sum = (rows, f) => rows.reduce((n, r) => n + f(r), 0);

/** 날짜별 소계는 수입 · 지출만 (이체는 통장끼리 옮긴 돈이라 빼고, 빠졌다고 적는다) */
const dayLabelSub = (date, rows) => `${dayLabel(date)} 소계${rows.some((r) => r.kind === 'TRANSFER') ? ' (이체 제외)' : ''}`;
const normalOnly = (rows) => rows.filter((r) => r.kind === 'NORMAL');

function txRow(r, showBalance) {
  const isIn = isDeposit(r);
  const target = r.kind === 'TRANSFER' ? `${isIn ? '←' : '→'} ${esc(r.counterpartName ?? '')}` : esc(r.subjectName ?? '');
  return `
      <tr>
        <td>${esc(r.date)}</td>
        <td><span class="badge ${r.kind === 'TRANSFER' ? 'transfer' : r.deduction ? 'deduct' : isIn ? 'in' : 'out'}">${typeLabel(r)}</span></td>
        <td>${esc(r.accountName)} <span class="muted small">${FUND_LABEL[r.fundCode]}</span></td>
        <td>${target}</td>
        <td>${esc(r.memo)}${payerCell(r)}</td>
        <td class="num ${r.deduction ? 'minus' : ''}">${inAmount(r) ? formatWon(inAmount(r)) : ''}</td>
        <td class="num">${outAmount(r) ? formatWon(outAmount(r)) : ''}</td>
        ${showBalance ? `<td class="num">${r.balanceAfter == null ? '' : formatWon(r.balanceAfter)}</td>` : ''}
        <td class="small muted" title="${esc(r.createdBy)}">${esc(personName(r.createdBy))}</td>
      </tr>`;
}

const tableHead = (showBalance) => `<thead><tr><th>날짜</th><th>구분</th><th>통장</th><th>과목·상대통장</th><th>적요</th>
        <th class="num">입금</th><th class="num">출금</th>${showBalance ? '<th class="num">잔액</th>' : ''}<th>입력자</th></tr></thead>`;

function render(data, byAccount) {
  last = { data, byAccount };
  const showBalance = byAccount && data.rows.some((r) => r.balanceAfter != null);
  const cols = showBalance ? 9 : 8;
  const opening = data.openingBalance == null ? '' : showBalance
    ? `<tr class="subtotal"><td colspan="7">이월 잔액 (${esc($('from').value)} 이전)</td>
        <td class="num">${formatWon(data.openingBalance)}</td><td></td></tr>`
    : `<tr class="subtotal"><td colspan="${cols}">이월 잔액 (${esc($('from').value)} 이전): ${formatWon(data.openingBalance)}원</td></tr>`;
  const empty = `<tr><td colspan="${cols}" class="muted">조건에 맞는 거래가 없습니다.</td></tr>`;
  // 소계 줄: 입금 · 출금 칸에 합계 (0원은 가운데 점, show 로 한쪽만), 앞 칸에 설명
  const money = (n) => (n ? `<td class="num">${formatWon(n)}</td>` : '<td class="num nil">·</td>');
  const subRow = (label, rows, cls = 'subtotal', show = 'both') => `<tr class="${cls}"><td colspan="5">${label}</td>
      ${show === 'out' ? '<td></td>' : money(sum(rows, inAmount))}${show === 'in' ? '<td></td>' : money(sum(rows, outAmount))}
      ${showBalance ? '<td></td>' : ''}<td></td></tr>`;

  let tables;
  if (view === 'date') {
    const days = groupBy(data.rows, (r) => r.date);
    tables = `<table class="grid tx-list">${tableHead(showBalance)}<tbody>${opening}
      ${days.length ? days.map(([date, rows]) => `
        <tr class="group-head"><td colspan="${cols}">${dayLabel(date)} <span class="muted small">${rows.length}건</span></td></tr>
        ${rows.map((r) => txRow(r, showBalance)).join('')}
        ${subRow(dayLabelSub(date, rows), normalOnly(rows))}`).join('') : empty}
      </tbody></table>`;
  } else if (view === 'kind') {
    const groups = KIND_GROUPS.map(([k, label]) => [k, label, data.rows.filter((r) => kindGroup(r) === k)]).filter(([, , rows]) => rows.length);
    // 표마다 칸 너비를 같게 (위아래 표의 금액 칸이 줄 맞게)
    const colgroup = `<colgroup><col style="width:100px"><col style="width:90px"><col style="width:170px"><col style="width:120px"><col>
      <col style="width:105px"><col style="width:105px">${showBalance ? '<col style="width:115px">' : ''}<col style="width:165px"></colgroup>`;
    tables = groups.length ? groups.map(([k, label, rows]) => `
      <h3 class="group-title ${label === '수입' ? 'in' : label === '지출' ? 'out' : ''}">${label} <span class="muted small">${rows.length}건</span></h3>
      <table class="grid tx-list fixed-cols">${colgroup}${tableHead(showBalance)}<tbody>
        ${rows.map((r) => txRow(r, showBalance)).join('')}
        ${subRow(`${label} 합계`, rows, 'subtotal total', { IN: 'in', OUT: 'out', TRANSFER: 'both' }[k])}
      </tbody></table>`).join('') : `<table class="grid tx-list">${tableHead(showBalance)}<tbody>${empty}</tbody></table>`;
  } else {
    tables = `<table class="grid tx-list">${tableHead(showBalance)}<tbody>${opening}
      ${data.rows.map((r) => txRow(r, showBalance)).join('') || empty}</tbody></table>`;
  }

  const t = data.totals;
  $('result').innerHTML = `
    ${data.truncated ? '<p class="notice">결과가 너무 많아 앞쪽 2,000건만 표시합니다. 기간을 줄여 조회하세요.</p>' : ''}
    <p class="totals">
      수입 <b class="in">${formatWon(t.income)}</b> ·
      지출 <b class="out">${formatWon(t.expense)}</b> ·
      이체입금 <b>${formatWon(t.transferIn)}</b> ·
      이체출금 <b>${formatWon(t.transferOut)}</b>
      <span class="muted">(${data.rows.length}건)</span>
      <span class="totals-tools">
        ${byAccount ? `<a class="button secondary" href="${href(`/report?type=accounts&from=${$('from').value}&to=${$('to').value}&account=${$('account').value}`)}">이 통장 내역 인쇄 (A4)</a>` : ''}
        ${data.rows.length ? '<button type="button" class="secondary" id="excel">Excel로 내려받기</button>' : ''}
      </span>
    </p>
    <div class="view-switch" role="group" aria-label="보기">보기
      ${VIEWS.map(([k, label]) => `<button type="button" class="${k === view ? 'active' : ''}" data-view="${k}" aria-pressed="${k === view}">${label}</button>`).join('')}
    </div>
    ${tables}`;
}

/** 순서를 지키며 묶기 → [[키, 행들]] */
function groupBy(rows, key) {
  const map = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return [...map];
}

$('result').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (!b || !last) return;
  view = b.dataset.view;
  try { localStorage.setItem('ledger-view', view); } catch { /* 기억 못 해도 괜찮다 */ }
  render(last.data, last.byAccount);
});

$('filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]');
  if (b) { setRange(b.dataset.range); search(); }
});
$('search').addEventListener('click', search);

// 납부자 이름 고치기: 그 자리에서 입력칸으로 바꿔 저장
$('result').addEventListener('click', async (e) => {
  const box = e.target.closest('.payer-row');
  if (!box) return;
  const row = last?.data.rows.find((r) => r.id === Number(box.dataset.id));
  if (e.target.closest('.payer-edit')) {
    box.innerHTML = `<input class="payer-input" maxlength="30" list="payer-list" value="${esc(row?.payer ?? '')}" aria-label="납부자">
      <button type="button" class="small payer-save">저장</button><button type="button" class="secondary small payer-cancel">취소</button>`;
    box.querySelector('input').focus();
    if (!$('payer-list')) {
      const list = Object.assign(document.createElement('datalist'), { id: 'payer-list' });
      document.body.append(list);
      api('/api/payers').then(({ payers }) => { list.innerHTML = payers.map((p) => `<option value="${esc(p)}">`).join(''); }).catch(() => {});
    }
    return;
  }
  if (e.target.closest('.payer-cancel')) { box.outerHTML = payerCell(row); return; }
  if (e.target.closest('.payer-save')) {
    const payer = box.querySelector('input').value.trim();
    try {
      await api(`/api/transactions/${row.id}/payer`, { method: 'PUT', body: { payer } });
      row.payer = payer;
      box.outerHTML = payerCell(row);
      toast('납부자를 고쳤습니다.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }
});
$('result').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('payer-input') && !e.isComposing) {
    e.preventDefault();
    e.target.closest('.payer-row').querySelector('.payer-save').click();
  }
});

// 조회 결과를 Excel 로 (고른 보기 그대로): 날짜·구분·통장·회계·과목·적요·납부자·입금·출금·(잔액)·입력자
//   기본 · 날짜별 → 시트 한 장 (날짜별은 날짜마다 소계 줄), 수입 · 지출별 → 수입 · 지출 · 이체 시트
$('result').addEventListener('click', (e) => {
  if (!e.target.closest('#excel') || !last) return;
  const { data, byAccount } = last;
  const showBalance = byAccount && data.rows.some((r) => r.balanceAfter != null);
  const head = ['날짜', '구분', '통장', '회계', '과목·상대통장', '적요', '납부자', '입금', '출금', ...(showBalance ? ['잔액'] : []), '입력자'];
  const widths = [12, 10, 16, 10, 18, 30, 16, 13, 13, ...(showBalance ? [14] : []), 24];
  const line = (r) => [
    r.date, typeLabel(r), r.accountName, FUND_LABEL[r.fundCode],
    r.kind === 'TRANSFER' ? `${isDeposit(r) ? '←' : '→'} ${r.counterpartName ?? ''}` : (r.subjectName ?? ''),
    r.memo ?? '', r.payer ?? '', inAmount(r) || null, outAmount(r) || null,
    ...(showBalance ? [r.balanceAfter] : []), personName(r.createdBy),
  ];
  const b = (v) => ({ v, bold: true });
  const subLine = (label, rows) => [b(label), null, null, null, null, null, null, b(sum(rows, inAmount)), b(sum(rows, outAmount))];
  const openingLine = () => (showBalance
    ? [`이월 잔액 (${$('from').value} 이전)`, null, null, null, null, null, null, null, null, data.openingBalance]
    : [`이월 잔액 (${$('from').value} 이전): ${formatWon(data.openingBalance)}원`]);
  const t = data.totals;
  const totalLine = [b('합계'), null, null, null, null,
    b(`수입 ${formatWon(t.income)} · 지출 ${formatWon(t.expense)} · 이체입금 ${formatWon(t.transferIn)} · 이체출금 ${formatWon(t.transferOut)}`)];

  let sheets;
  if (view === 'kind') {
    sheets = KIND_GROUPS.map(([k, label]) => [label, data.rows.filter((r) => kindGroup(r) === k)]).filter(([, rows]) => rows.length)
      .map(([label, rows]) => ({ name: label, header: 1, widths, rows: [head, ...rows.map(line), [], subLine(`${label} 합계 (${rows.length}건)`, rows)] }));
  } else {
    const rows = [head];
    if (data.openingBalance != null) rows.push(openingLine());
    if (view === 'date') {
      for (const [date, list] of groupBy(data.rows, (r) => r.date)) {
        rows.push(...list.map(line), subLine(dayLabelSub(date, list), normalOnly(list)), []);
      }
    } else {
      rows.push(...data.rows.map(line), []);
    }
    rows.push(totalLine);
    sheets = [{ name: '거래 조회', header: 1, widths, rows }];
  }
  const viewName = { list: '', date: ' 날짜별', kind: ' 수입지출별' }[view];
  downloadXlsx(`본당살림 거래조회${viewName} ${$('from').value}~${$('to').value}.xlsx`, sheets);
});
$('filters').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); search(); }
});

// 시작일을 고르면 종료일도 같은 날로 (하루치를 바로 볼 수 있게. 기간은 종료일을 다시 고르면 됨)
$('from').addEventListener('change', () => {
  if ($('from').value) $('to').value = $('from').value;
});

initPage('ledger').then(({ settings: s }) => {
  settings = s;
  fillFilters();
  const p = new URLSearchParams(location.search);
  setRange('month');
  if (p.get('from')) $('from').value = p.get('from');
  if (p.get('to')) $('to').value = p.get('to');
  $('account').value = p.get('accountId') ?? '';
  $('subject').value = p.get('subjectId') ?? '';
  $('kind').value = p.get('kind') ?? '';
  $('q').value = p.get('q') ?? '';
  search();
}).catch((err) => {
  $('result').innerHTML = `<p class="error">${esc(err.message)}</p>`;
});
