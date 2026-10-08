// 사목일지: A4 종이 위 노란 칸에 바로 입력하고 [저장], 인쇄하면 입력한 글자만 나온다.
//   1. 신자 현황 (세대·인원: 전입 · 전출 · 현재 총원 — 총원은 전날 총원 + 전입 − 전출, 직접 고칠 수 있음)
//   2. 미사 (저장 전에는 설정의 요일별 기본 미사로 채움)  3. 성사  4. 특이사항
//   5. 회계 (그날 일 마감을 해야 불러온다)
import { href } from './base.js';
import { api, esc } from './api.js';
import { initPage, toast, approvalBoxHtml } from './ui.js';
import { formatWon } from './shared/money.js';
import { addDays, formatDateTimeKST, formatKoreanDate, isValidDate, todayKST } from './shared/dates.js';
import { accountBalances, detailTable, fundSummaryTable, transferTable } from './daily-tables.js';

const $ = (id) => document.getElementById(id);
const paper = $('paper');

const MASS_KIND = { SUNDAY: '주일', WEEKDAY: '평일', WEDDING: '혼배', FUNERAL: '장례', SPECIAL: '특별' };
const SACRAMENTS = [['baptism', '세례'], ['confirmation', '견진'], ['anointing', '병자'], ['marriage', '혼인'], ['funeral', '장례'], ['communion', '봉성체']];

let journal = null; // 불러온 사목일지
let dirty = false;  // 저장하지 않은 입력이 있음

const num = (v) => Number(String(v ?? '').replace(/[^0-9]/g, '')) || 0;
const numText = (n) => (n ? formatWon(n) : '');
const numInput = (cls, value, label, attrs = '') =>
  `<input class="cell num ${cls}" ${attrs} inputmode="numeric" autocomplete="off" value="${numText(value)}" placeholder="0" aria-label="${label}">`;

async function load(date) {
  const [j, day] = await Promise.all([api(`/api/journal?date=${date}`), api(`/api/reports/daily?date=${date}`)]);
  if (j.date !== $('date').value) return; // 그사이 다른 날짜로 넘어감
  journal = j;
  dirty = false;
  render(j, day);
  history.replaceState(null, '', `?date=${date}`);
}

function render(j, day) {
  document.title = `사목일지 ${j.date} - 본당살림`;
  setState();
  paper.innerHTML = `
    <article class="report journal">
      <div class="r-head ${j.approvalSteps.length > 4 ? 'stacked' : ''}">
        <div class="r-title">
          <h1>사 목 일 지</h1>
          <table class="r-meta">
            <tr><th>성 당</th><td>${esc(j.parishName)}</td></tr>
            <tr><th>날 짜</th><td>${formatKoreanDate(j.date)}</td></tr>
            <tr><th>작성자</th><td>${esc(j.writerName)}<span class="seal">(인)</span></td></tr>
          </table>
        </div>
        <div class="r-approval">${approvalBoxHtml(j.approvalSteps)}</div>
      </div>

      <h2>1. 신자 현황</h2>
      <table class="r-table fixed" id="members">
        <colgroup><col style="width:26mm"><col><col><col></colgroup>
        <thead><tr><th>구분</th><th>전입 (+)</th><th>전출 (−)</th><th>현재 총원</th></tr></thead>
        <tbody>
          ${totalRow('households', '세대', j.households)}
          ${totalRow('members', '인원 (명)', j.members)}
        </tbody>
      </table>

      <h2>2. 미사</h2>
      <table class="r-table fixed" id="masses">
        <colgroup><col style="width:18mm"><col><col style="width:20mm"><col style="width:26mm"><col style="width:26mm"><col class="no-print" style="width:7mm"></colgroup>
        <thead><tr><th>시간</th><th>미사</th><th>구분</th><th>참석 인원</th><th>고해성사</th><th class="no-print"></th></tr></thead>
        <tbody>${j.masses.map(massRow).join('')}</tbody>
        <tfoot><tr><td colspan="3">합 계</td><td class="amt" id="sum-attendance"></td><td class="amt" id="sum-confessions"></td><td class="no-print"></td></tr></tfoot>
      </table>
      <button type="button" class="secondary row-add no-print" id="add-mass">+ 미사 추가</button>

      <h2>3. 성사</h2>
      <table class="r-table fixed sacraments">
        <thead><tr>${SACRAMENTS.map(([, label]) => `<th>${label}</th>`).join('')}</tr></thead>
        <tbody><tr>${SACRAMENTS.map(([key, label]) =>
          `<td class="inp">${numInput('sac', j.sacraments[key], label, `data-key="${key}"`)}</td>`).join('')}</tr></tbody>
      </table>

      <h2>4. 특이사항</h2>
      <textarea class="cell notes no-print" id="notes" maxlength="5000" placeholder="그날 있었던 일을 자유롭게 적습니다">${esc(j.notes)}</textarea>
      <div class="notes-print" id="notes-print"></div>

      <h2>5. 회계</h2>
      ${accountingHtml(day)}
    </article>`;
  for (const t of paper.querySelectorAll('#members tbody tr')) updateTotal(t);
  sumMasses();
  syncNotes();
  fitNotes();
}

function totalRow(key, label, t) {
  const manual = t.total != null;
  return `<tr data-key="${key}" data-prev="${t.prev}" ${manual ? 'data-manual="1"' : ''}>
    <td class="label">${label}</td>
    <td class="inp">${numInput('in', t.in, `${label} 전입`)}</td>
    <td class="inp">${numInput('out', t.out, `${label} 전출`)}</td>
    <td class="inp total-cell">${numInput('total', manual ? t.total : 0, `${label} 현재 총원`)}
      <button type="button" class="link-btn no-print auto-btn" title="전날 총원 + 전입 − 전출로 되돌리기">자동</button></td></tr>`;
}

/** 현재 총원: 직접 고치지 않았으면 전날 총원 + 전입 − 전출 */
function updateTotal(tr) {
  const input = tr.querySelector('.total');
  if (!tr.dataset.manual) {
    const auto = Math.max(0, num(tr.dataset.prev) + num(tr.querySelector('.in').value) - num(tr.querySelector('.out').value));
    input.value = formatWon(auto);
  }
  tr.classList.toggle('manual', Boolean(tr.dataset.manual));
}

function massRow(m = { time: '', name: '', kind: 'WEEKDAY', attendance: 0, confessions: 0 }) {
  return `<tr>
    <td class="inp"><input class="cell m-time" value="${esc(m.time)}" placeholder="00:00" maxlength="5" inputmode="numeric" aria-label="미사 시간"></td>
    <td class="inp"><input class="cell m-name" value="${esc(m.name)}" placeholder="미사 이름" maxlength="30" aria-label="미사 이름"></td>
    <td class="inp"><select class="cell m-kind" aria-label="미사 구분">${Object.entries(MASS_KIND).map(([k, v]) =>
      `<option value="${k}" ${k === m.kind ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
    <td class="inp">${numInput('m-att', m.attendance, '참석 인원')}</td>
    <td class="inp">${numInput('m-conf', m.confessions, '고해성사')}</td>
    <td class="no-print"><button type="button" class="row-del" title="이 미사 지우기" aria-label="이 미사 지우기">✕</button></td></tr>`;
}

function sumMasses() {
  const sum = (cls) => [...paper.querySelectorAll(`#masses .${cls}`)].reduce((a, i) => a + num(i.value), 0);
  $('sum-attendance').textContent = formatWon(sum('m-att'));
  $('sum-confessions').textContent = formatWon(sum('m-conf'));
}

// 인쇄용 특이사항: 입력칸은 글이 길면 스크롤이 생겨 잘리므로, 인쇄할 때는 같은 글을 상자로 보여 준다
function syncNotes() { $('notes-print').textContent = $('notes').value; }
function fitNotes() {
  const t = $('notes');
  t.style.height = 'auto';
  t.style.height = `${Math.max(t.scrollHeight + 2, 100)}px`;
}

function accountingHtml(day) {
  if (day.status !== 'CLOSED') {
    return `<div class="wait">이 날짜는 아직 일 마감 전입니다. <b>일 마감</b>을 하면 그날 회계 내용이 여기에 나옵니다.
      <a class="no-print" href="${href(`/closing?date=${day.date}`)}">마감하러 가기</a></div>`;
  }
  const warn = day.verification && !day.verification.ok
    ? `<p class="lock-banner no-print">마감 시점 잔액과 현재 잔액이 다릅니다: ${day.verification.mismatches.map((m) => esc(m.name)).join(', ')}. 관리자에게 확인하세요.</p>` : '';
  return `${warn}
    <div class="sub-h">회계별 현황</div>${fundSummaryTable(day)}
    <div class="sub-h">수입 내역</div>${detailTable(day.income, '수입', { voucher: false })}
    <div class="sub-h">지출 내역</div>${detailTable(day.expense, '지출', { voucher: false })}
    ${day.transfers.rows.length ? `<div class="sub-h">통장 간 이체</div>${transferTable(day, { voucher: false })}` : ''}
    <div class="sub-h">통장별 현재잔액</div>${accountBalances(day)}`;
}

function setState(message) {
  $('state').innerHTML = message ?? (dirty
    ? '<span class="pill open">저장 안 됨</span> <span class="muted">입력한 내용을 [저장]하세요.</span>'
    : journal.saved
      ? `<span class="pill closed">저장됨</span> <span class="muted">${formatDateTimeKST(journal.updatedAt)}</span>`
      : '<span class="pill open">새 일지</span> <span class="muted">요일별 기본 미사가 채워져 있습니다. 입력하고 [저장]하세요.</span>');
}

function markDirty() {
  if (!dirty) { dirty = true; setState(); }
}

/** 화면의 입력 → 저장할 내용 */
function collect() {
  const totals = (key) => {
    const tr = paper.querySelector(`#members tr[data-key="${key}"]`);
    return { in: num(tr.querySelector('.in').value), out: num(tr.querySelector('.out').value),
      total: tr.dataset.manual ? num(tr.querySelector('.total').value) : null };
  };
  return {
    date: journal.date,
    households: totals('households'),
    members: totals('members'),
    masses: [...paper.querySelectorAll('#masses tbody tr')].map((tr) => ({
      time: tr.querySelector('.m-time').value.trim(),
      name: tr.querySelector('.m-name').value,
      kind: tr.querySelector('.m-kind').value,
      attendance: num(tr.querySelector('.m-att').value),
      confessions: num(tr.querySelector('.m-conf').value),
    })),
    sacraments: Object.fromEntries([...paper.querySelectorAll('.sac')].map((i) => [i.dataset.key, num(i.value)])),
    notes: $('notes').value,
  };
}

let saving = false;
async function save() {
  if (!journal || saving) return false;
  saving = true;
  $('save').disabled = true;
  try {
    const body = collect();
    const r = await api('/api/journal', { method: 'PUT', body });
    journal = { ...journal, saved: true, updatedAt: r.updatedAt };
    dirty = false;
    setState();
    toast('사목일지를 저장했습니다.');
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  } finally {
    saving = false;
    $('save').disabled = false;
  }
}

/** 다른 날짜로 갈 때 저장하지 않은 내용이 있으면 묻는다 */
async function go(date) {
  if (!isValidDate(date)) return;
  if (dirty && journal && date !== journal.date) {
    if (confirm('저장하지 않은 내용이 있습니다. 저장하고 넘어갈까요?\n([취소]를 누르면 저장하지 않고 넘어갑니다)')) {
      if (!(await save())) { $('date').value = journal.date; return; }
    }
  }
  $('date').value = date;
  load(date).catch((err) => toast(err.message, 'error'));
}

// ---------------------------------------------------------------- 이벤트

paper.addEventListener('input', (e) => {
  const t = e.target;
  if (t.classList.contains('num')) {
    const caretFromEnd = t.value.length - (t.selectionStart ?? t.value.length);
    const d = t.value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '').slice(0, 7);
    t.value = d ? formatWon(Number(d)) : '';
    const pos = Math.max(0, t.value.length - caretFromEnd);
    t.setSelectionRange(pos, pos);
  }
  if (t.classList.contains('m-time')) t.value = t.value.replace(/[^0-9:]/g, '');
  const tr = t.closest('#members tr');
  if (tr) {
    if (t.classList.contains('total')) tr.dataset.manual = '1';
    updateTotal(tr);
  }
  if (t.closest('#masses')) sumMasses();
  if (t.id === 'notes') { syncNotes(); fitNotes(); }
  markDirty();
});
paper.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') markDirty(); });

// 시간: 0600 → 06:00, 6:0 → 06:00
paper.addEventListener('focusout', (e) => {
  const t = e.target;
  if (!t.classList?.contains('m-time') || !t.value) return;
  const m = /^(\d{1,2}):?(\d{2})$/.exec(t.value.replace(/^(\d):/, '0$1:')) ?? /^(\d{1,2})$/.exec(t.value);
  if (m) t.value = `${m[1].padStart(2, '0')}:${(m[2] ?? '00').padStart(2, '0')}`;
});

paper.addEventListener('click', (e) => {
  if (e.target.id === 'add-mass') {
    paper.querySelector('#masses tbody').insertAdjacentHTML('beforeend', massRow());
    paper.querySelector('#masses tbody tr:last-child .m-time').focus();
    markDirty();
  }
  const del = e.target.closest('.row-del');
  if (del) { del.closest('tr').remove(); sumMasses(); markDirty(); }
  const auto = e.target.closest('.auto-btn');
  if (auto) {
    const tr = auto.closest('tr');
    delete tr.dataset.manual;
    updateTotal(tr);
    markDirty();
  }
});

// Enter: 다음 칸으로 (특이사항 글에서는 줄바꿈)
paper.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  e.preventDefault();
  const inputs = [...paper.querySelectorAll('input, select, textarea')];
  inputs[inputs.indexOf(e.target) + 1]?.focus();
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
});
window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

$('save').addEventListener('click', save);
$('print').addEventListener('click', () => window.print());
$('date').addEventListener('change', () => go($('date').value));
$('prev').addEventListener('click', () => go(addDays($('date').value, -1)));
$('next').addEventListener('click', () => go(addDays($('date').value, 1)));
$('now').addEventListener('click', () => go(todayKST()));

// 인쇄할 때마다 종이 오른쪽 아래에 출력 일시
const printedAt = document.createElement('style');
document.head.append(printedAt);
window.addEventListener('beforeprint', () => {
  printedAt.textContent = `@page { @bottom-right { content: "출력 일시 ${formatDateTimeKST(new Date().toISOString())}"; font-size: 8pt; color: #555; } }`;
});

initPage('journal').then(() => {
  const d = new URLSearchParams(location.search).get('date');
  $('date').value = d && isValidDate(d) ? d : todayKST();
  return load($('date').value);
}).catch((err) => {
  paper.innerHTML = `<p class="error">${esc(err.message)}</p>`;
});
