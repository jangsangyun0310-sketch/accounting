import { api, esc } from './api.js';
import { formatWon } from './shared/money.js';
import { formatKoreanDate } from './shared/dates.js';

const $ = (id) => document.getElementById(id);

async function main() {
  const [me, settings, balances, health] = await Promise.all([
    api('/api/me'), api('/api/settings'), api('/api/balances'), api('/api/health'),
  ]);

  $('user').textContent = me.email;
  $('parish-name').textContent = settings.parish?.parishName ?? '(최초 설정 전)';
  $('as-of').textContent = `${formatKoreanDate(balances.date)} 기준`;

  const rows = [];
  for (const fund of balances.funds) {
    for (const a of balances.accounts.filter((x) => x.fundCode === fund.code)) {
      rows.push(`<tr><td>${esc(fund.name)}</td><td>${esc(a.name)}${a.isActive ? '' : ' (사용중지)'}</td>
        <td class="num">${formatWon(a.balance)}</td></tr>`);
    }
    rows.push(`<tr class="subtotal"><td colspan="2">${esc(fund.name)} 소계</td>
      <td class="num">${formatWon(fund.balance)}</td></tr>`);
  }
  rows.push(`<tr class="total"><td colspan="2">전체 합계</td><td class="num">${formatWon(balances.total)}</td></tr>`);
  $('balances').innerHTML = `<table class="grid"><thead><tr><th>회계</th><th>통장</th><th class="num">잔액(원)</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;

  $('approval').textContent = settings.approvalSteps.map((s) => s.title).join(' → ') || '(미설정)';
  $('status').textContent = `DB 연결 정상 · 스키마 ${health.migration ?? '-'}`;
}

main().catch((err) => {
  $('balances').textContent = '';
  $('status').textContent = `오류: ${err.message}`;
});
