// 결산서: 일일결산 · 월말결산 · 연말결산 A4 미리보기와 인쇄
import { href } from './base.js';
import { api, esc } from './api.js';
import { initPage, toast, approvalBoxHtml, signedWon } from './ui.js';
import { formatWon, sumAmounts } from './shared/money.js';
import { addDays, formatDateTimeKST, formatKoreanDate, isValidDate, todayKST } from './shared/dates.js';

const $ = (id) => document.getElementById(id);
const FUND_SHORT = { GENERAL: '일반', SPECIAL: '특별' };

const TYPES = {
  day: { now: '오늘' },
  month: { now: '이번 달' },
  year: { now: '올해' },
};
let type = 'day';

function currentValue() {
  return { day: $('date').value, month: $('month').value, year: $('year').value }[type];
}

/** 결산 종류와 날짜(일: YYYY-MM-DD, 월: YYYY-MM, 연: YYYY)를 정하고 결산서를 불러온다 */
async function load(nextType, value) {
  type = nextType;
  document.querySelectorAll('#report-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  $('date').hidden = type !== 'day';
  $('month').hidden = type !== 'month';
  $('year').hidden = type !== 'year';
  $('now').textContent = TYPES[type].now;
  if (type === 'day') $('date').value = value;
  if (type === 'month') $('month').value = value;
  if (type === 'year') {
    if (![...$('year').options].some((o) => o.value === value)) $('year').append(new Option(`${value}년`, value));
    $('year').value = value;
  }
  history.replaceState(null, '', `?type=${type}&${type === 'day' ? 'date' : type}=${value}`);

  if (type === 'day') {
    const r = await api(`/api/reports/daily?date=${value}`);
    if (type === 'day' && r.date === $('date').value) render(r);
  } else {
    const r = await api(`/api/reports/period?type=${type}&${type}=${value}`);
    if (r.type === type && value === currentValue()) renderPeriod(r);
  }
}

/** 이전·다음 (하루 / 한 달 / 한 해) */
function shift(dir) {
  const v = currentValue();
  if (type === 'day') return addDays(v, dir);
  if (type === 'month') return addDays(`${v}-01`, dir > 0 ? 31 : -1).slice(0, 7);
  return String(Number(v) + dir);
}

function nowValue() {
  const t = todayKST();
  return { day: t, month: t.slice(0, 7), year: t.slice(0, 4) }[type];
}

function render(r) {
  const closed = r.status === 'CLOSED';
  document.title = `일일결산 ${r.date} - 본당살림`;
  $('state').innerHTML = closed
    ? `<span class="pill closed">마감</span> <span class="muted">${formatDateTimeKST(r.closedAt)} · ${esc(r.closedBy)}</span>`
    : `<span class="pill open">미마감</span> <span class="muted">가결산으로 출력됩니다. <a href="${href(`/closing?date=${r.date}`)}">마감하러 가기</a></span>`;
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

// ---------------------------------------------------------------- 월말·연말결산

const koreanMonth = (ym) => `${Number(ym.slice(5, 7))}월`;
const shortDate = (d) => formatKoreanDate(d).replace(/^\d+년 /, '');
const monthDay = (d) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;
const sumBy = (rows, key) => sumAmounts(rows.map((x) => x[key]));

function subjectTable(section, label) {
  return `
    <table class="r-table fixed">
      <colgroup><col style="width:8mm"><col><col style="width:30mm"><col style="width:30mm"><col style="width:32mm"></colgroup>
      <thead><tr><th class="no">No</th><th>예산과목</th><th>일반회계</th><th>특별회계</th><th>합계</th></tr></thead>
      <tbody>${section.rows.length ? section.rows.map((x, i) => `
        <tr><td class="no">${i + 1}</td><td>${esc(x.name)}</td><td class="amt">${formatWon(x.GENERAL)}</td>
          <td class="amt">${formatWon(x.SPECIAL)}</td><td class="amt strong">${formatWon(x.total)}</td></tr>`).join('')
        : `<tr><td colspan="5" class="empty">${label} 내역 없음</td></tr>`}</tbody>
      <tfoot><tr><td colspan="2">${label} 합계</td>
        <td class="amt">${formatWon(sumBy(section.rows, 'GENERAL'))}</td><td class="amt">${formatWon(sumBy(section.rows, 'SPECIAL'))}</td>
        <td class="amt">${formatWon(section.total)}</td></tr></tfoot>
    </table>`;
}

function renderPeriod(r) {
  const closed = r.status === 'CLOSED';
  const isMonth = r.type === 'month';
  const periodText = isMonth ? `${r.from.slice(0, 4)}년 ${koreanMonth(r.from)}` : `${r.from.slice(0, 4)}년`;
  const prevLabel = isMonth ? '전월이월' : '전년이월';
  const endLabel = isMonth ? '월말잔액' : '연말잔액';
  document.title = `${isMonth ? '월말결산' : '연말결산'} ${periodText} - 본당살림`;
  $('state').innerHTML = closed
    ? '<span class="pill closed">마감 완료</span> <span class="muted">기간 안의 모든 날이 마감되었습니다.</span>'
    : `<span class="pill open">미마감 포함</span> <span class="muted">마감되지 않은 날이 있어 가결산으로 출력됩니다.
        (마지막 마감일: ${r.closedThrough ? formatKoreanDate(r.closedThrough) : '없음'})</span>`;
  $('warning').innerHTML = '';

  $('paper').innerHTML = `
    <article class="report ${closed ? '' : 'provisional'}">
      ${closed ? '' : '<div class="watermark" aria-hidden="true">가결산</div>'}
      <div class="r-head ${r.approvalSteps.length > 5 ? 'stacked' : ''}">
        <div class="r-title">
          <h1>${isMonth ? '월 말 결 산 서' : '연 말 결 산 서'}${closed ? '' : ' <small>(가결산)</small>'}</h1>
          <table class="r-meta">
            <tr><th>성 당</th><td>${esc(r.parishName)}</td></tr>
            <tr><th>결산기간</th><td>${periodText} <span class="range">(${monthDay(r.from)} ~ ${monthDay(r.to)})</span></td></tr>
            <tr><th>작성자</th><td>${esc(r.writerName)}<span class="seal">(인)</span></td></tr>
          </table>
        </div>
        <div class="r-approval">${approvalBoxHtml(r.approvalSteps)}</div>
      </div>

      <h2>1. 회계별 현황</h2>
      <table class="r-table">
        <thead><tr><th>구분</th><th>${prevLabel}</th><th>수입</th><th>지출</th><th>이체(±)</th><th>${endLabel}</th></tr></thead>
        <tbody>${r.funds.map((f) => summaryRow(esc(f.name), f)).join('')}</tbody>
        <tfoot>${summaryRow('합 계', r.total)}</tfoot>
      </table>

      <h2>2. 수입 과목별 합계</h2>
      ${subjectTable(r.income, '수입')}

      <h2>3. 지출 과목별 합계</h2>
      ${subjectTable(r.expense, '지출')}

      <h2>4. ${isMonth ? '일자별' : '월별'} 현황</h2>
      <table class="r-table fixed">
        <colgroup><col><col style="width:38mm"><col style="width:38mm"><col style="width:42mm"></colgroup>
        <thead><tr><th>${isMonth ? '날짜' : '월'}</th><th>수입</th><th>지출</th><th>전체 잔액</th></tr></thead>
        <tbody>${r.breakdown.length ? r.breakdown.map((x) => `
          <tr><td>${isMonth ? shortDate(x.key) : koreanMonth(x.key)}</td><td class="amt">${formatWon(x.income)}</td>
            <td class="amt">${formatWon(x.expense)}</td><td class="amt strong">${formatWon(x.balance)}</td></tr>`).join('')
          : '<tr><td colspan="4" class="empty">수입·지출 내역 없음</td></tr>'}</tbody>
        <tfoot><tr><td>합계</td><td class="amt">${formatWon(r.total.income)}</td><td class="amt">${formatWon(r.total.expense)}</td>
          <td class="amt">${formatWon(r.total.end)}</td></tr></tfoot>
      </table>

      <h2>5. 통장별 잔액</h2>
      <div class="r-cols">
        ${r.funds.map((f) => `
          <table class="r-table">
            <thead><tr><th>${esc(f.name)} 통장</th><th>${prevLabel}</th><th>${endLabel}</th></tr></thead>
            <tbody>${r.accounts.filter((a) => a.fundCode === f.code).map((a) => `
              <tr><td>${esc(a.name)}</td><td class="amt">${formatWon(a.prev)}</td><td class="amt strong">${formatWon(a.end)}</td></tr>`).join('')}
            </tbody>
            <tfoot><tr><td>소계</td><td class="amt">${formatWon(f.prev)}</td><td class="amt">${formatWon(f.end)}</td></tr></tfoot>
          </table>`).join('')}
      </div>
      <table class="r-table r-grand">
        <tr><td>전체 합계</td><td class="amt">${prevLabel} ${formatWon(r.total.prev)}</td>
          <td class="amt strong">${endLabel} ${formatWon(r.total.end)}</td></tr>
      </table>
    </article>`;
}

// ---------------------------------------------------------------- 이벤트

const run = (p) => p.catch((err) => toast(err.message, 'error'));
const valid = (v) => (type === 'day' ? isValidDate(v) : type === 'month' ? /^\d{4}-\d{2}$/.test(v) : /^\d{4}$/.test(v));
const go = (v) => { if (valid(v)) run(load(type, v)); };

$('report-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b || b.dataset.type === type) return;
  // 지금 보던 날짜가 속한 달·해를 연다. 보던 달·해가 오늘을 포함하면 오늘 기준으로.
  const prefix = currentValue();
  const today = todayKST();
  const base = today.startsWith(prefix) ? today
    : type === 'day' ? prefix : type === 'month' ? `${prefix}-01` : `${prefix}-01-01`;
  run(load(b.dataset.type, { day: base, month: base.slice(0, 7), year: base.slice(0, 4) }[b.dataset.type]));
});
for (const id of ['date', 'month', 'year']) $(id).addEventListener('change', () => go(currentValue()));
$('prev').addEventListener('click', () => go(shift(-1)));
$('next').addEventListener('click', () => go(shift(1)));
$('now').addEventListener('click', () => go(nowValue()));
$('print').addEventListener('click', () => window.print());

initPage('report').then(({ settings }) => {
  const thisYear = Number(todayKST().slice(0, 4));
  const firstYear = Number((settings.parish?.startDate ?? todayKST()).slice(0, 4));
  for (let y = thisYear; y >= Math.min(firstYear, thisYear); y--) $('year').append(new Option(`${y}년`, String(y)));
  const p = new URLSearchParams(location.search);
  type = TYPES[p.get('type')] ? p.get('type') : 'day';
  const v = p.get(type === 'day' ? 'date' : type);
  return load(type, v && valid(v) ? v : nowValue());
}).catch((err) => {
  $('paper').innerHTML = `<p class="error">${esc(err.message)}</p>`;
});
