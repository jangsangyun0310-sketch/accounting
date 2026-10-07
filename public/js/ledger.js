// 거래 조회 화면: 기간·통장·과목·구분·검색어로 거래를 찾고, 통장 선택 시 잔액 흐름을 보여준다.
import { api, esc } from './api.js';
import { initPage, toast, typeLabel, FUND_LABEL } from './ui.js';
import { formatWon } from './shared/money.js';
import { addDays, monthStart, todayKST } from './shared/dates.js';

const $ = (id) => document.getElementById(id);
let settings = null;

function fillFilters() {
  $('account').innerHTML = '<option value="">전체</option>' + ['GENERAL', 'SPECIAL'].map((fund) => {
    const list = settings.accounts.filter((a) => a.fundCode === fund);
    return list.length ? `<optgroup label="${FUND_LABEL[fund]}">${list.map((a) =>
      `<option value="${a.id}">${esc(a.name)}${a.isActive ? '' : ' (사용중지)'}</option>`).join('')}</optgroup>` : '';
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

function render(data, byAccount) {
  const showBalance = byAccount && data.rows.some((r) => r.balanceAfter != null);
  const cols = showBalance ? 10 : 9;
  const rows = data.rows.map((r) => {
    const isIn = r.direction === 'IN';
    const target = r.kind === 'TRANSFER' ? `${isIn ? '←' : '→'} ${esc(r.counterpartName ?? '')}` : esc(r.subjectName ?? '');
    return `
      <tr>
        <td>${esc(r.date)}</td>
        <td><span class="badge ${r.kind === 'TRANSFER' ? 'transfer' : isIn ? 'in' : 'out'}">${typeLabel(r)}</span></td>
        <td>${esc(r.accountName)} <span class="muted small">${FUND_LABEL[r.fundCode]}</span></td>
        <td>${target}</td>
        <td>${esc(r.memo)}</td>
        <td>${esc(r.voucherNo)}</td>
        <td class="num">${isIn ? formatWon(r.amount) : ''}</td>
        <td class="num">${!isIn ? formatWon(r.amount) : ''}</td>
        ${showBalance ? `<td class="num">${r.balanceAfter == null ? '' : formatWon(r.balanceAfter)}</td>` : ''}
        <td class="small muted">${esc(r.createdBy)}</td>
      </tr>`;
  }).join('');
  const t = data.totals;
  $('result').innerHTML = `
    ${data.truncated ? '<p class="notice">결과가 너무 많아 앞쪽 2,000건만 표시합니다. 기간을 줄여 조회하세요.</p>' : ''}
    <p class="totals">
      수입 <b class="in">${formatWon(t.income)}</b> ·
      지출 <b class="out">${formatWon(t.expense)}</b> ·
      이체입금 <b>${formatWon(t.transferIn)}</b> ·
      이체출금 <b>${formatWon(t.transferOut)}</b>
      <span class="muted">(${data.rows.length}건)</span>
    </p>
    <table class="grid tx-list">
      <thead><tr><th>날짜</th><th>구분</th><th>통장</th><th>과목·상대통장</th><th>적요</th><th>증빙</th>
        <th class="num">입금</th><th class="num">출금</th>${showBalance ? '<th class="num">잔액</th>' : ''}<th>입력자</th></tr></thead>
      <tbody>
        ${data.openingBalance == null ? '' : showBalance
          ? `<tr class="subtotal"><td colspan="8">이월 잔액 (${esc($('from').value)} 이전)</td>
              <td class="num">${formatWon(data.openingBalance)}</td><td></td></tr>`
          : `<tr class="subtotal"><td colspan="${cols}">이월 잔액 (${esc($('from').value)} 이전): ${formatWon(data.openingBalance)}원</td></tr>`}
        ${rows || `<tr><td colspan="${cols}" class="muted">조건에 맞는 거래가 없습니다.</td></tr>`}
      </tbody>
    </table>`;
}

$('filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]');
  if (b) { setRange(b.dataset.range); search(); }
});
$('search').addEventListener('click', search);
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
