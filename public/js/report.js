// 일일 결산서: A4 미리보기와 인쇄
import { api, esc } from './api.js';
import { initPage, toast, approvalBoxHtml, signedWon } from './ui.js';
import { formatWon } from './shared/money.js';
import { addDays, formatDateTimeKST, formatKoreanDate, isValidDate, todayKST } from './shared/dates.js';

const $ = (id) => document.getElementById(id);
const FUND_SHORT = { GENERAL: '일반', SPECIAL: '특별' };

async function load(date) {
  history.replaceState(null, '', `?date=${date}`);
  $('date').value = date;
  const r = await api(`/api/reports/daily?date=${date}`);
  if (r.date !== $('date').value) return;
  render(r);
}

function render(r) {
  const closed = r.status === 'CLOSED';
  document.title = `일일 결산서 ${r.date} - ${r.parishName}`;
  $('state').innerHTML = closed
    ? `<span class="pill closed">마감</span> <span class="muted">${formatDateTimeKST(r.closedAt)} · ${esc(r.closedBy)}</span>`
    : `<span class="pill open">미마감</span> <span class="muted">가결산으로 출력됩니다. <a href="/closing?date=${r.date}">마감하러 가기</a></span>`;
  $('warning').innerHTML = r.verification && !r.verification.ok
    ? `<p class="lock-banner">마감 시점 잔액과 현재 잔액이 다릅니다: ${r.verification.mismatches.map((m) => esc(m.name)).join(', ')}. 관리자에게 확인하세요.</p>`
    : '';

  const manySteps = r.approvalSteps.length > 5;
  $('paper').innerHTML = `
    <article class="report ${closed ? '' : 'provisional'}">
      ${closed ? '' : '<div class="watermark" aria-hidden="true">가결산</div>'}
      <div class="r-head ${manySteps ? 'stacked' : ''}">
        <div class="r-title">
          <h1>일 일 결 산 서${closed ? '' : ' <small>(가결산)</small>'}</h1>
          <table class="r-meta">
            <tr><th>성 당</th><td>${esc(r.parishName)}</td></tr>
            <tr><th>결산일</th><td>${formatKoreanDate(r.date)}</td></tr>
            <tr><th>작성자</th><td>${esc(r.writerName)}<span class="seal">(인)</span></td></tr>
          </table>
        </div>
        <div class="r-approval">${approvalBoxHtml(r.approvalSteps)}</div>
      </div>

      <h2>1. 회계별 현황</h2>
      <table class="r-table">
        <thead><tr><th>구분</th><th>전일잔액</th><th>당일수입</th><th>당일지출</th><th>이체(±)</th><th>당일잔액</th></tr></thead>
        <tbody>
          ${r.funds.map((f) => summaryRow(esc(f.name), f)).join('')}
        </tbody>
        <tfoot>${summaryRow('합 계', r.total)}</tfoot>
      </table>

      <h2>2. 당일 수입 내역</h2>
      ${detailTable(r.income, '수입')}

      <h2>3. 당일 지출 내역</h2>
      ${detailTable(r.expense, '지출')}

      ${r.transfers.rows.length ? `
        <h2>4. 통장 간 이체 내역</h2>
        <table class="r-table fixed">
          <colgroup><col style="width:8mm"><col style="width:37mm"><col style="width:37mm"><col><col style="width:22mm"><col style="width:25mm"></colgroup>
          <thead><tr><th class="no">No</th><th>출금 통장</th><th>입금 통장</th><th>적요</th><th>증빙번호</th><th>금액</th></tr></thead>
          <tbody>${r.transfers.rows.map((t, i) => `
            <tr><td class="no">${i + 1}</td>
              <td>${esc(t.fromName)} <span class="fund">${FUND_SHORT[t.fromFund]}</span></td>
              <td>${esc(t.toName)} <span class="fund">${FUND_SHORT[t.toFund] ?? ''}</span></td>
              <td>${esc(t.memo)}</td><td>${esc(t.voucherNo)}</td><td class="amt">${formatWon(t.amount)}</td></tr>`).join('')}
          </tbody>
          <tfoot><tr><td colspan="5">이체 합계 (${r.transfers.rows.length}건)</td><td class="amt">${formatWon(r.transfers.total)}</td></tr></tfoot>
        </table>` : ''}

      <h2>${r.transfers.rows.length ? 5 : 4}. 통장별 현재잔액</h2>
      <div class="r-cols">
        ${r.funds.map((f) => `
          <table class="r-table">
            <thead><tr><th>${esc(f.name)} 통장</th><th>전일잔액</th><th>현재잔액</th></tr></thead>
            <tbody>${r.accounts.filter((a) => a.fundCode === f.code).map((a) => `
              <tr><td>${esc(a.name)}</td><td class="amt">${formatWon(a.prev)}</td>
                <td class="amt strong">${formatWon(a.end)}</td></tr>`).join('')}
            </tbody>
            <tfoot><tr><td>소계</td><td class="amt">${formatWon(f.prev)}</td><td class="amt">${formatWon(f.end)}</td></tr></tfoot>
          </table>`).join('')}
      </div>
      <table class="r-table r-grand">
        <tr><td>전체 합계</td><td class="amt">전일잔액 ${formatWon(r.total.prev)}</td>
          <td class="amt strong">현재잔액 ${formatWon(r.total.end)}</td></tr>
      </table>

      <footer class="r-foot">
        <span>${closed ? `마감 ${formatDateTimeKST(r.closedAt)} (${esc(r.closedBy)})` : '미마감 상태에서 출력한 가결산입니다.'}</span>
        ${r.voidedCount ? `<span>취소된 거래 ${r.voidedCount}건은 제외</span>` : ''}
        <span>출력 ${formatDateTimeKST(new Date().toISOString())}</span>
      </footer>
    </article>`;
}

function summaryRow(label, r) {
  return `<tr><td class="label">${label}</td>${amountCells(r)}</tr>`;
}

function amountCells(r) {
  return `<td class="amt">${formatWon(r.prev)}</td><td class="amt">${formatWon(r.income)}</td>
    <td class="amt">${formatWon(r.expense)}</td><td class="amt">${signedWon(r.transferIn - r.transferOut)}</td>
    <td class="amt strong">${formatWon(r.end)}</td>`;
}

function detailTable(section, label) {
  return `
    <table class="r-table fixed">
      <colgroup><col style="width:8mm"><col style="width:10mm"><col style="width:34mm"><col style="width:26mm"><col><col style="width:22mm"><col style="width:25mm"></colgroup>
      <thead><tr><th class="no">No</th><th>회계</th><th>통장</th><th>예산과목</th><th>적요</th><th>증빙번호</th><th>금액</th></tr></thead>
      <tbody>${section.rows.length ? section.rows.map((t, i) => `
        <tr><td class="no">${i + 1}</td><td class="fund-col">${FUND_SHORT[t.fundCode]}</td><td>${esc(t.accountName)}</td>
          <td>${esc(t.subjectName)}</td><td>${esc(t.memo)}</td><td>${esc(t.voucherNo)}</td>
          <td class="amt">${formatWon(t.amount)}</td></tr>`).join('')
        : `<tr><td colspan="7" class="empty">${label} 내역 없음</td></tr>`}
      </tbody>
      <tfoot><tr><td colspan="6">${label} 합계 (${section.rows.length}건)</td><td class="amt">${formatWon(section.total)}</td></tr></tfoot>
    </table>`;
}

const go = (date) => { if (isValidDate(date)) load(date).catch((err) => toast(err.message, 'error')); };

$('date').addEventListener('change', () => go($('date').value));
$('prev-day').addEventListener('click', () => go(addDays($('date').value, -1)));
$('next-day').addEventListener('click', () => go(addDays($('date').value, 1)));
$('today').addEventListener('click', () => go(todayKST()));
$('print').addEventListener('click', () => window.print());

initPage('report').then(() => {
  const p = new URLSearchParams(location.search).get('date');
  return load(isValidDate(p) ? p : todayKST());
}).catch((err) => {
  $('paper').innerHTML = `<p class="error">${esc(err.message)}</p>`;
});
