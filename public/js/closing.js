// 일 마감 화면: 마감 달력, 날짜별 현황·마감 정보, 마감/마감취소, 기록
import { href } from './base.js';
import { api, esc } from './api.js';
import { initPage, toast, approvalBoxHtml, signedWon } from './ui.js';
import { formatWon } from './shared/money.js';
import { addDays, formatDateTimeKST, formatKoreanDate, isValidDate, todayKST } from './shared/dates.js';

const $ = (id) => document.getElementById(id);
const STATUS_LABEL = {
  closed: '마감', locked: '잠김', reopened: '마감취소됨', open: '', future: '', 'before-start': '',
};
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

let month = todayKST().slice(0, 7);
let selected = null;
let calendar = null;

// ---------------------------------------------------------------- 상단 상태

function renderStatus() {
  const c = calendar;
  const next = c.closableUntil;
  const needs = c.nextRequired && c.nextRequired <= c.today;
  $('status').innerHTML = `
    <div class="status-item"><span class="muted">마지막 마감일</span>
      <b>${c.lastClosed ? formatKoreanDate(c.lastClosed) : '없음'}</b></div>
    <div class="status-item"><span class="muted">다음 마감할 날</span>
      <b>${needs ? formatKoreanDate(c.nextRequired) : '<span class="muted">미마감 거래 없음</span>'}</b></div>
    ${needs ? `<button type="button" id="quick-close" data-date="${next}">${formatKoreanDate(next)} 마감하기</button>` : ''}`;
}

// ---------------------------------------------------------------- 달력

async function loadCalendar() {
  calendar = await api(`/api/closings?month=${month}`);
  renderStatus();
  const [y, m] = month.split('-').map(Number);
  $('month-label').textContent = `${y}년 ${m}월`;
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const cells = Array.from({ length: firstWeekday }, () => '<div class="cell empty"></div>');
  for (const d of calendar.days) {
    const hasTx = d.posted + d.voided > 0;
    const cls = [
      'cell', d.status,
      d.status === 'open' && hasTx ? 'pending' : '',
      d.date === calendar.today ? 'today' : '',
      d.date === selected ? 'selected' : '',
    ].join(' ');
    const label = d.status === 'open' && hasTx ? '미마감' : STATUS_LABEL[d.status];
    cells.push(`
      <button type="button" class="${cls}" data-date="${d.date}">
        <span class="day">${Number(d.date.slice(8))}</span>
        ${label ? `<span class="tag">${label}</span>` : ''}
        ${d.posted ? `<span class="count">${d.posted}건</span>` : ''}
      </button>`);
  }
  $('calendar').innerHTML = WEEKDAYS.map((w) => `<div class="wd">${w}</div>`).join('') + cells.join('');
}

// ---------------------------------------------------------------- 날짜 상세

async function loadDetail(date) {
  selected = date;
  history.replaceState(null, '', `?date=${date}`);
  document.querySelectorAll('.calendar .cell').forEach((c) => c.classList.toggle('selected', c.dataset.date === date));
  const [info, day] = await Promise.all([api(`/api/closings/${date}`), api(`/api/day?date=${date}`)]);
  const c = info.closing;
  const closed = c?.status === 'CLOSED';
  const covered = !closed && info.lastClosed && date <= info.lastClosed;
  const postedCount = day.transactions.filter((t) => t.status === 'POSTED').length;

  const statusText = closed ? '<span class="pill closed">마감</span>'
    : covered ? '<span class="pill locked">잠김 (이후 날짜 마감으로 함께 잠김)</span>'
    : c?.status === 'REOPENED' ? '<span class="pill reopened">마감취소됨</span>'
    : '<span class="pill open">미마감</span>';

  const sumRow = (label, r, cls = '') => `<tr class="${cls}"><td>${label}</td><td class="num">${formatWon(r.prev)}</td>
    <td class="num in">${formatWon(r.income)}</td><td class="num out">${formatWon(r.expense)}</td>
    <td class="num">${signedWon(r.transferIn - r.transferOut)}</td><td class="num"><b>${formatWon(r.end)}</b></td></tr>`;

  $('detail').innerHTML = `
    <div class="detail-head">
      <h2>${formatKoreanDate(date)}</h2> ${statusText}
    </div>
    <table class="grid summary">
      <thead><tr><th>구분</th><th class="num">전일잔액</th><th class="num">수입</th><th class="num">지출</th>
        <th class="num">이체</th><th class="num">당일잔액</th></tr></thead>
      <tbody>${day.funds.map((f) => sumRow(esc(f.name), f)).join('')}${sumRow('합계', day.total, 'total')}</tbody>
    </table>
    <p class="muted">거래 ${postedCount}건${day.transactions.length > postedCount ? ` (취소 ${day.transactions.length - postedCount}건 별도)` : ''}
      · <a href="${href(`/entry?date=${date}`)}">거래 내역 보기</a></p>

    ${closed ? `
      <dl class="summary">
        <dt>마감 처리</dt><dd>${formatDateTimeKST(c.closedAt)} · ${esc(c.closedBy)}</dd>
        <dt>결산서 작성자</dt><dd>${esc(c.writerName) || '-'}</dd>
        <dt>잔액 검증</dt><dd>${info.verification.ok
          ? '<span class="in">✔ 마감 시점 잔액과 현재 계산 잔액이 일치합니다.</span>'
          : `<span class="error">✖ 마감 시점과 잔액이 다릅니다: ${info.verification.mismatches.map((m) =>
            `${esc(m.name)} (마감 ${m.snapshot == null ? '-' : formatWon(m.snapshot)} / 현재 ${m.current == null ? '-' : formatWon(m.current)})`).join(', ')}</span>`}</dd>
      </dl>
      <h4>마감 당시 결재선</h4>
      ${approvalBoxHtml(c.approvalSteps)}` : ''}

    <div class="detail-actions">
      <a class="button secondary" href="${href(`/report?date=${date}`)}">결산서 보기·인쇄</a>
      ${info.canClose ? `<button type="button" data-close-date="${date}">이 날짜 마감하기</button>` : ''}
      ${info.canReopen ? `<button type="button" class="danger" data-reopen="${date}">마감취소</button>` : ''}
      ${!info.canClose && !closed && !covered && date <= info.today && date >= info.startDate
        ? `<p class="help">앞 날짜(${formatKoreanDate(info.nextRequired)})에 마감되지 않은 거래가 있습니다. 그 날부터 순서대로 마감하세요.</p>` : ''}
      ${closed && !info.canReopen ? '<p class="help">마감취소는 가장 마지막 마감일부터 순서대로만 할 수 있습니다.</p>' : ''}
      ${date > info.today ? '<p class="help">미래 날짜는 마감할 수 없습니다.</p>' : ''}
    </div>
`;
}

// ---------------------------------------------------------------- 마감 / 마감취소

async function openCloseDialog(date) {
  const [day, settings] = await Promise.all([api(`/api/day?date=${date}`), api('/api/settings')]);
  const dlg = $('action-dialog');
  dlg.innerHTML = `
    <h3>${formatKoreanDate(date)} 마감</h3>
    <p>마감하면 이 날짜와 그 이전 날짜의 거래를 <b>입력·수정·취소할 수 없습니다.</b><br>
      고쳐야 할 때는 마감취소를 먼저 하면 됩니다.</p>
    <table class="grid summary">
      <thead><tr><th>구분</th><th class="num">전일잔액</th><th class="num">수입</th><th class="num">지출</th>
        <th class="num">이체</th><th class="num">당일잔액</th></tr></thead>
      <tbody>${[...day.funds, { ...day.total, name: '합계' }].map((f) => `<tr>
        <td>${esc(f.name)}</td><td class="num">${formatWon(f.prev)}</td><td class="num">${formatWon(f.income)}</td>
        <td class="num">${formatWon(f.expense)}</td><td class="num">${signedWon(f.transferIn - f.transferOut)}</td>
        <td class="num"><b>${formatWon(f.end)}</b></td></tr>`).join('')}</tbody>
    </table>
    <label>결산서 작성자 <input id="writer" maxlength="20" value="${esc(settings.parish.writerName)}"></label>
    <div class="dialog-foot">
      <button type="button" class="secondary" data-cancel>닫기</button>
      <button type="button" id="confirm-close">마감</button>
    </div>`;
  dlg.showModal();
  $('confirm-close').focus();
  $('confirm-close').addEventListener('click', async () => {
    $('confirm-close').disabled = true;
    try {
      await api(`/api/closings/${date}/close`, { method: 'POST', body: { writerName: $('writer').value } });
      dlg.close();
      toast(`${formatKoreanDate(date)} 마감했습니다.`);
      await refresh(date);
    } catch (err) {
      toast(err.message, 'error');
      $('confirm-close').disabled = false;
    }
  });
}

function openReopenDialog(date) {
  const dlg = $('action-dialog');
  dlg.innerHTML = `
    <h3>${formatKoreanDate(date)} 마감취소</h3>
    <p>마감을 취소하면 이 날짜의 거래를 다시 수정할 수 있습니다.</p>
    <label>메모 (선택) <textarea id="reopen-reason" rows="3" maxlength="200" placeholder="예) 교무금 금액 오기 정정"></textarea></label>
    <div class="dialog-foot">
      <button type="button" class="secondary" data-cancel>닫기</button>
      <button type="button" class="danger" id="confirm-reopen">마감취소</button>
    </div>`;
  dlg.showModal();
  $('reopen-reason').focus();
  $('confirm-reopen').addEventListener('click', async () => {
    const reason = $('reopen-reason').value.trim();
    $('confirm-reopen').disabled = true;
    try {
      await api(`/api/closings/${date}/reopen`, { method: 'POST', body: { reason } });
      dlg.close();
      toast(`${formatKoreanDate(date)} 마감을 취소했습니다.`);
      await refresh(date);
    } catch (err) {
      toast(err.message, 'error');
      $('confirm-reopen').disabled = false;
    }
  });
}

async function refresh(date = selected) {
  await loadCalendar();
  if (date) await loadDetail(date);
}

// ---------------------------------------------------------------- 이벤트

async function goto(date) {
  if (date.slice(0, 7) !== month) {
    month = date.slice(0, 7);
    await loadCalendar();
  }
  await loadDetail(date);
}

const run = (p) => p.catch((err) => toast(err.message, 'error'));

$('calendar').addEventListener('click', (e) => {
  const cell = e.target.closest('[data-date]');
  if (cell) run(loadDetail(cell.dataset.date));
});
$('prev-month').addEventListener('click', () => {
  month = addDays(`${month}-01`, -1).slice(0, 7);
  run(loadCalendar());
});
$('next-month').addEventListener('click', () => {
  month = addDays(`${month}-01`, 31).slice(0, 7);
  run(loadCalendar());
});
document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close-date], #quick-close');
  if (close) { run(goto(close.dataset.date ?? close.dataset.closeDate).then(() => openCloseDialog(close.dataset.date ?? close.dataset.closeDate))); return; }
  const reopen = e.target.closest('[data-reopen]');
  if (reopen) { openReopenDialog(reopen.dataset.reopen); return; }
  if (e.target.closest('[data-cancel]') || e.target === $('action-dialog')) $('action-dialog').close();
});

initPage('closing').then(async () => {
  const p = new URLSearchParams(location.search).get('date');
  const start = isValidDate(p) ? p : null;
  if (start) month = start.slice(0, 7);
  await loadCalendar();
  await loadDetail(start ?? (calendar.nextRequired && calendar.nextRequired <= calendar.today
    ? calendar.nextRequired : calendar.today));
  if (selected && selected.slice(0, 7) !== month) { month = selected.slice(0, 7); await loadCalendar(); }
}).catch((err) => {
  $('status').innerHTML = `<p class="error">${esc(err.message)}</p>`;
});
