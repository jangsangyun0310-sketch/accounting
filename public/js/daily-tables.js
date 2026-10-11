// 사목일지 2쪽(회계)의 하루 회계 표 (/api/reports/daily 응답으로 그린다)
import { esc } from './api.js';
import { signedWon } from './ui.js';
import { formatWon } from './shared/money.js';

export const FUND_SHORT = { GENERAL: '일반', SPECIAL: '특별' };

/** 금액 칸: 0 이면 가운데 점 (내용 없는 칸) */
const amt = (n, { cls = '', signed = false } = {}) => (n
  ? `<td class="amt ${cls}">${signed ? signedWon(n) : formatWon(n)}</td>`
  : '<td class="amt nil">·</td>');
/** 글자 칸: 비어 있으면 가운데 점 */
const txt = (v) => (v ? `<td>${esc(v)}</td>` : '<td class="nil">·</td>');

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
  return `<tr><td class="label">${label}</td>${amt(r.prev)}${amt(r.income)}
    ${amt(r.expense)}${amt(r.transferIn - r.transferOut, { signed: true })}
    ${amt(r.end, { cls: 'strong' })}</tr>`;
}

/** 수입 · 지출 내역 */
export function detailTable(section, label) {
  const cols = 6;
  return `
    <table class="r-table fixed">
      <colgroup><col style="width:8mm"><col style="width:10mm"><col style="width:38mm"><col style="width:30mm"><col><col style="width:27mm"></colgroup>
      <thead><tr><th class="no">No</th><th>회계</th><th>통장</th><th>예산과목</th><th>적요</th><th>금액</th></tr></thead>
      <tbody>${section.rows.length ? section.rows.map((t, i) => `
        <tr><td class="no">${i + 1}</td><td class="fund-col">${FUND_SHORT[t.fundCode]}</td>${txt(t.accountName)}
          ${txt(t.subjectName)}${txt(t.memo)}
          ${amt(t.amount)}</tr>`).join('')
        : `<tr><td colspan="${cols}" class="empty">${label} 내역 없음</td></tr>`}
      </tbody>
      <tfoot><tr><td colspan="${cols - 1}">${label} 합계 (${section.rows.length}건)</td>${amt(section.total)}</tr></tfoot>
    </table>`;
}

/** 통장 간 이체 내역 (이체가 없으면 빈 글자) */
export function transferTable(r) {
  if (!r.transfers.rows.length) return '';
  return `
    <table class="r-table fixed">
      <colgroup><col style="width:8mm"><col style="width:37mm"><col style="width:37mm"><col><col style="width:25mm"></colgroup>
      <thead><tr><th class="no">No</th><th>출금 통장</th><th>입금 통장</th><th>적요</th><th>금액</th></tr></thead>
      <tbody>${r.transfers.rows.map((t, i) => `
        <tr><td class="no">${i + 1}</td>
          <td>${esc(t.fromName)} <span class="fund">${FUND_SHORT[t.fromFund]}</span></td>
          <td>${esc(t.toName)} <span class="fund">${FUND_SHORT[t.toFund] ?? ''}</span></td>
          ${txt(t.memo)}${amt(t.amount)}</tr>`).join('')}
      </tbody>
      <tfoot><tr><td colspan="4">이체 합계 (${r.transfers.rows.length}건)</td>${amt(r.transfers.total)}</tr></tfoot>
    </table>`;
}

/** 현금이 등록되어 있나 (보유 현금 표를 따로 보여 줄지) */
export const hasCash = (r) => r.accounts.some((a) => a.isCash);

/** 보유 현금 (사무실 현금마다 전일잔액 · 당일 입금 · 당일 출금 · 현재잔액). 입금·출금에는 이체도 들어간다. 현금이 없으면 빈 글자 */
export function cashTable(r) {
  const rows = r.accounts.filter((a) => a.isCash);
  if (!rows.length) return '';
  const line = (a) => ({ prev: a.prev, in: a.income + a.transferIn, out: a.expense + a.transferOut, end: a.end });
  const lines = rows.map(line);
  const sum = (k) => lines.reduce((s, x) => s + x[k], 0);
  return `
    <table class="r-table cash-table">
      <thead><tr><th>현금</th><th>전일잔액</th><th>당일 입금</th><th>당일 출금</th><th>현재잔액</th></tr></thead>
      <tbody>${rows.map((a, i) => `
        <tr><td>${esc(a.name)}</td>${amt(lines[i].prev)}${amt(lines[i].in)}${amt(lines[i].out)}${amt(lines[i].end, { cls: 'strong' })}</tr>`).join('')}</tbody>
      ${rows.length > 1 ? `<tfoot><tr><td>보유 현금 합계</td>${amt(sum('prev'))}${amt(sum('in'))}${amt(sum('out'))}${amt(sum('end'))}</tr></tfoot>` : ''}
    </table>`;
}

/** 통장별 현재잔액 (등록된 통장 모두, 회계별로 나란히 — 현금은 보유 현금 표에 따로) + 전체 합계 */
export function accountBalances(r) {
  const cash = hasCash(r);
  const banks = r.accounts.filter((a) => !a.isCash);
  const sub = (list, k) => list.reduce((n, a) => n + a[k], 0);
  return `
    <div class="r-cols">
      ${r.funds.map((f) => {
        const list = banks.filter((a) => a.fundCode === f.code);
        return `
        <table class="r-table">
          <thead><tr><th>${esc(f.name)} 통장</th><th>전일잔액</th><th>현재잔액</th></tr></thead>
          <tbody>${list.map((a) => `
            <tr><td>${esc(a.name)}</td>${amt(a.prev)}
              ${amt(a.end, { cls: 'strong' })}</tr>`).join('')}
          </tbody>
          <tfoot><tr><td>소계</td>${amt(sub(list, 'prev'))}${amt(sub(list, 'end'))}</tr></tfoot>
        </table>`;
      }).join('')}
    </div>
    <table class="r-table r-grand">
      <tr><td>전체 합계${cash ? ' (현금 + 통장)' : ''}</td><td class="amt">전일잔액 ${formatWon(r.total.prev)}</td>
        <td class="amt strong">현재잔액 ${formatWon(r.total.end)}</td></tr>
    </table>`;
}
