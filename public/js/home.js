import { href, isInstalledApp, installApp } from './base.js';
import { api, esc } from './api.js';
import { initPage, approvalBoxHtml, toast } from './ui.js';
import { formatWon } from './shared/money.js';
import { formatKoreanDate } from './shared/dates.js';
import { backupStatusHtml, downloadBackup } from './backup.js';

const $ = (id) => document.getElementById(id);

async function main() {
  const { settings } = await initPage('home');
  const [balances, health, closings, backup] = await Promise.all([
    api('/api/balances'), api('/api/health'), api('/api/closings'), api('/api/backup/status')]);

  // 바탕화면 아이콘 안내 (이미 설치한 앱 창에서는 숨김)
  if (!isInstalledApp) {
    const box = $('parish-address');
    box.hidden = false;
    box.innerHTML = `<div class="install-row"><button type="button" class="small" id="install-app">바탕화면에 아이콘 만들기</button>
      <span class="muted">장부는 서버에 저장되어, 어느 컴퓨터에서든 로그인하면 같은 장부가 열립니다.</span></div>
      <p id="install-help" class="help" hidden>이 브라우저에서는 버튼으로 설치할 수 없습니다.
      <b>크롬</b>: 주소창 오른쪽의 설치 아이콘(⊕) 또는 메뉴(⋮) → 전송, 공유 및 전송 → <b>페이지를 앱으로 설치</b>.
      <b>엣지</b>: 메뉴(…) → 앱 → <b>이 사이트를 앱으로 설치</b>.
      이미 설치했다면 바탕화면이나 시작 메뉴에서 "본당살림"을 찾아보세요.</p>`;
    $('install-app').addEventListener('click', async () => {
      if (!(await installApp())) $('install-help').hidden = false;
    });
  }

  const b = backupStatusHtml(backup);
  $('backup-status').innerHTML = b.html + (b.needed
    ? ' <button type="button" class="small" id="backup-now">지금 백업</button>'
    : ` <a href="${href('/settings#backup')}">백업 관리</a>`);
  document.getElementById('backup-now')?.addEventListener('click', async () => {
    if (await downloadBackup()) location.reload();
  });

  const pending = closings.nextRequired && closings.nextRequired <= closings.today;
  $('closing-status').innerHTML = `마지막 마감일: <b>${closings.lastClosed ? formatKoreanDate(closings.lastClosed) : '없음'}</b>`
    + (pending ? ` · <span class="error">마감하지 않은 거래가 있습니다 (${formatKoreanDate(closings.nextRequired)}부터)</span> <a href="${href('/closing')}">마감하러 가기</a>` : '');

  $('as-of').textContent = `${formatKoreanDate(balances.date)} 기준`;

  const rows = [];
  for (const fund of balances.funds) {
    for (const a of balances.accounts.filter((x) => x.fundCode === fund.code)) {
      rows.push(`<tr><td>${esc(fund.name)}</td><td>${esc(a.name)}${a.isActive ? '' : ' <span class="muted">(사용중지)</span>'}</td>
        <td class="num">${formatWon(a.balance)}</td></tr>`);
    }
    rows.push(`<tr class="subtotal"><td colspan="2">${esc(fund.name)} 소계</td>
      <td class="num">${formatWon(fund.balance)}</td></tr>`);
  }
  rows.push(`<tr class="total"><td colspan="2">전체 합계</td><td class="num">${formatWon(balances.total)}</td></tr>`);
  $('balances').innerHTML = `<table class="grid"><thead><tr><th>회계</th><th>통장</th><th class="num">잔액(원)</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;

  $('approval').innerHTML = approvalBoxHtml(settings.approvalSteps.map((s) => s.title));
  $('status').textContent = `DB 연결 정상 · 스키마 ${health.migration ?? '-'}`;
}

main().catch((err) => {
  $('balances').textContent = '';
  $('status').textContent = `오류: ${err.message}`;
});
