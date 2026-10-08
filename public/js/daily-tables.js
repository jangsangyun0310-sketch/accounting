// 일일결산서와 사목일지가 함께 쓰는 하루 회계 표 (/api/reports/daily 응답으로 그린다)
import { esc } from './api.js';
import { signedWon } from './ui.js';
import { formatWon } from './shared/money.js';

export const FUND_SHORT = { GENERAL: '일반', SPECIAL: '특별' };

/** 회계별 현황 (전일잔액 · 당일수입 · 당일지출 · 이체 · 당일잔액) */
export function fundSummaryTable(r) {
  return `
    <table class="r-table">
      <thead><tr><th>구분</th><th>전일잔액</th><th>당일수입</th><th>당일지출</th><th>이체(±)</th><th>당일잔액</th></tr></thead>
      <tbody>${r.funds.map((f) => summaryRow(esc(f.name), f)).join('')}</tbody>
      <tfoot>${summaryRow('합 계', r.total)}</tfoot>
    </table>`;
}

export function summaryRow(label, r) {
  return `<tr><td class="label">${label}</td><td class="amt">${formatWon(r.prev)}</td><td class="amt">${formatWon(r.income)}</td>
    <td class="amt">${formatWon(r.expense)}</td><td class="amt">${signedWon(r.transferIn - r.transferOut)}</td>
    <td class="amt strong">${formatWon(r.end)}</td></tr>`;
}

/** 수입 · 지출 내역. voucher: 증빙번호 칸 */
export function detailTable(section, label, { voucher = true } = {}) {
  const cols = voucher ? 7 : 6;
  return `
    <table class="r-table fixed">
      <colgroup><col style="width:8mm"><col style="width:10mm"><col style="width:${voucher ? 34 : 38}mm"><col style="width:${voucher ? 26 : 30}mm"><col>${voucher ? '<col style="width:22mm">' : ''}<col style="width:${voucher ? 25 : 27}mm"></colgroup>
      <thead><tr><th class="no">No</th><th>회계</th><th>통장</th><th>예산과목</th><th>적요</th>${voucher ? '<th>증빙번호</th>' : ''}<th>금액</th></tr></thead>
      <tbody>${section.rows.length ? section.rows.map((t, i) => `
        <tr><td class="no">${i + 1}</td><td class="fund-col">${FUND_SHORT[t.fundCode]}</td><td>${esc(t.accountName)}</td>
          <td>${esc(t.subjectName)}</td><td>${esc(t.memo)}</td>${voucher ? `<td>${esc(t.voucherNo)}</td>` : ''}
          <td class="amt">${formatWon(t.amount)}</td></tr>`).join('')
        : `<tr><td colspan="${cols}" class="empty">${label} 내역 없음</td></tr>`}
      </tbody>
      <tfoot><tr><td colspan="${cols - 1}">${label} 합계 (${section.rows.length}건)</td><td class="amt">${formatWon(section.total)}</td></tr></tfoot>
    </table>`;
}

/** 통장 간 이체 내역 (이체가 없으면 빈 글자) */
export function transferTable(r, { voucher = true } = {}) {
  if (!r.transfers.rows.length) return '';
  return `
    <table class="r-table fixed">
      <colgroup><col style="width:8mm"><col style="width:37mm"><col style="width:37mm"><col>${voucher ? '<col style="width:22mm">' : ''}<col style="width:25mm"></colgroup>
      <thead><tr><th class="no">No</th><th>출금 통장</th><th>입금 통장</th><th>적요</th>${voucher ? '<th>증빙번호</th>' : ''}<th>금액</th></tr></thead>
      <tbody>${r.transfers.rows.map((t, i) => `
        <tr><td class="no">${i + 1}</td>
          <td>${esc(t.fromName)} <span class="fund">${FUND_SHORT[t.fromFund]}</span></td>
          <td>${esc(t.toName)} <span class="fund">${FUND_SHORT[t.toFund] ?? ''}</span></td>
          <td>${esc(t.memo)}</td>${voucher ? `<td>${esc(t.voucherNo)}</td>` : ''}<td class="amt">${formatWon(t.amount)}</td></tr>`).join('')}
      </tbody>
      <tfoot><tr><td colspan="${voucher ? 5 : 4}">이체 합계 (${r.transfers.rows.length}건)</td><td class="amt">${formatWon(r.transfers.total)}</td></tr></tfoot>
    </table>`;
}

/** 통장별 현재잔액 (등록된 통장 모두, 회계별로 나란히) + 전체 합계 */
export function accountBalances(r) {
  return `
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
    </table>`;
}
