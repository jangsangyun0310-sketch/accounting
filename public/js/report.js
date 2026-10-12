// 결산서: 월말결산 · 연말결산 · 예산 대비 집행 · 통장별 입출금 내역 · 개인별 납부 A4 미리보기와 인쇄
// (날짜별 회계는 사목일지 2쪽에 나온다 — 예전 일일결산 주소로 오면 사목일지로 보낸다)
import { href } from './base.js';
import { api, esc } from './api.js';
import { initPage, toast, approvalAreaHtml, FUND_LABEL } from './ui.js';
import { formatWon, sumAmounts } from './shared/money.js';
import { addDays, formatDateTimeKST, formatKoreanDate, isValidDate, monthStart, todayKST } from './shared/dates.js';
import { downloadXlsx, reportSheet } from './excel.js';
import { summaryRow } from './daily-tables.js';

const $ = (id) => document.getElementById(id);

const TYPES = {
  month: { now: '이번 달' },
  year: { now: '올해' },
  budget: { now: '올해' }, // 예산 대비 집행 (연도 고르기는 연말결산과 같은 칸)
  accounts: { now: '이번 달' }, // 통장별 입출금 내역 (시작일~종료일)
  donors: { now: '올해' }, // 개인별 납부 (특별회계 납부자별, 연말정산 준비)
};
let type = 'month';

function currentValue() {
  if (type === 'accounts') return `${$('from').value}~${$('to').value}`;
  return { month: $('month').value, year: $('year').value, budget: $('year').value, donors: $('year').value }[type];
}

/** 결산 종류와 날짜(일: YYYY-MM-DD, 월: YYYY-MM, 연: YYYY, 통장별: { from, to })를 정하고 결산서를 불러온다 */
async function load(nextType, value) {
  type = nextType;
  document.querySelectorAll('#report-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  document.querySelector('.date-nav').hidden = type === 'accounts';
  $('range-nav').hidden = type !== 'accounts';
  if (type === 'accounts') {
    $('from').value = value.from;
    $('to').value = value.to;
    const account = $('account').value;
    history.replaceState(null, '', `?type=accounts&from=${value.from}&to=${value.to}${account ? `&account=${account}` : ''}`);
    const seq = ++accountsSeq;
    const r = await api(`/api/reports/accounts?from=${value.from}&to=${value.to}`);
    if (type === 'accounts' && seq === accountsSeq) { // 늦게 온 예전 조회 결과는 버린다
      accountsReport = { ...r, accountId: Number(account) || null };
      renderAccounts();
    }
    fitPaper();
    return;
  }
  $('month').hidden = type !== 'month';
  $('year').hidden = type !== 'year' && type !== 'budget' && type !== 'donors';
  $('now').textContent = TYPES[type].now;
  if (type === 'month') $('month').value = value;
  if (type === 'year' || type === 'budget' || type === 'donors') {
    if (![...$('year').options].some((o) => o.value === value)) $('year').append(new Option(`${value}년`, value));
    $('year').value = value;
  }
  history.replaceState(null, '', `?type=${type}&${type}=${value}`);

  if (type === 'donors') {
    const r = await api(`/api/reports/donors?year=${value}`);
    if (type === 'donors' && String(r.year) === currentValue()) {
      donorsReport = r;
      donorsView = 'list';
      renderDonors();
    }
  } else if (type === 'budget') {
    const r = await api(`/api/budgets?year=${value}`);
    if (type === 'budget' && String(r.year) === currentValue()) renderBudget(r);
  } else {
    const r = await api(`/api/reports/period?type=${type}&${type}=${value}`);
    if (r.type === type && value === currentValue()) renderPeriod(r);
  }
  fitPaper();
}

// 휴대폰: A4 용지를 화면 폭에 맞춰 줄여 한눈에 보이게 (손가락으로 벌리면 확대). 인쇄할 때는 원래 크기
function fitPaper() {
  const paper = $('paper');
  paper.style.zoom = '';
  const room = document.documentElement.clientWidth - 16;
  if (room < 720 && paper.offsetWidth > room) paper.style.zoom = String(room / paper.offsetWidth);
}
addEventListener('resize', fitPaper);
addEventListener('beforeprint', () => { $('paper').style.zoom = ''; });
addEventListener('afterprint', fitPaper);

/** 이전·다음 (하루 / 한 달 / 한 해) */
function shift(dir) {
  const v = currentValue();
  if (type === 'month') return addDays(`${v}-01`, dir > 0 ? 31 : -1).slice(0, 7);
  return String(Number(v) + dir);
}

function nowValue() {
  const t = todayKST();
  return { month: t.slice(0, 7), year: t.slice(0, 4), budget: t.slice(0, 4), donors: t.slice(0, 4) }[type];
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
  const cashRows = r.accounts.filter((a) => a.isCash); // 사무실 현금은 통장과 따로
  document.title = `${isMonth ? '월말결산' : '연말결산'} ${periodText} - 본당살림`;
  $('state').innerHTML = closed
    ? '<span class="pill closed">마감 완료</span> <span class="muted">기간 안의 모든 날이 마감되었습니다.</span>'
    : `<span class="pill open">미마감 포함</span> <span class="muted">마감되지 않은 날이 있어 가결산으로 출력됩니다.
        (마지막 마감일: ${r.closedThrough ? formatKoreanDate(r.closedThrough) : '없음'})</span>`;
  $('warning').innerHTML = '';

  $('paper').innerHTML = `
    <article class="report ${closed ? '' : 'provisional'}">
      ${closed ? '' : '<div class="watermark" aria-hidden="true">가결산</div>'}
      <div class="r-head ${r.approvalSteps.length > 4 ? 'stacked' : ''}">
        <div class="r-title">
          <h1>${isMonth ? '월 말 결 산 서' : '연 말 결 산 서'}${closed ? '' : ' <small>(가결산)</small>'}</h1>
          <table class="r-meta">
            <tr><th>성 당</th><td>${esc(r.parishName)}</td></tr>
            <tr><th>결산기간</th><td>${periodText} <span class="range">(${monthDay(r.from)} ~ ${monthDay(r.to)})</span></td></tr>
            <tr><th>작성자</th><td>${esc(r.writerName)}<span class="seal">(인)</span></td></tr>
          </table>
        </div>
        ${approvalAreaHtml(r.approvalSteps, 'main')}
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

      ${cashRows.length ? `<h2>5. 보유 현금</h2>
      <table class="r-table cash-table">
        <thead><tr><th>현금</th><th>${prevLabel}</th><th>입금</th><th>출금</th><th>${endLabel}</th></tr></thead>
        <tbody>${cashRows.map((a) => `
          <tr><td>${esc(a.name)}</td><td class="amt">${formatWon(a.prev)}</td><td class="amt">${formatWon(a.income + a.transferIn)}</td>
            <td class="amt">${formatWon(a.expense + a.transferOut)}</td><td class="amt strong">${formatWon(a.end)}</td></tr>`).join('')}</tbody>
        ${cashRows.length > 1 ? `<tfoot><tr><td>보유 현금 합계</td><td class="amt">${formatWon(sumBy(cashRows, 'prev'))}</td>
          <td class="amt">${formatWon(cashRows.reduce((n, a) => n + a.income + a.transferIn, 0))}</td>
          <td class="amt">${formatWon(cashRows.reduce((n, a) => n + a.expense + a.transferOut, 0))}</td>
          <td class="amt">${formatWon(sumBy(cashRows, 'end'))}</td></tr></tfoot>` : ''}
      </table>` : ''}

      <h2>${cashRows.length ? 6 : 5}. 통장별 잔액</h2>
      <div class="r-cols">
        ${r.funds.map((f) => {
          const list = r.accounts.filter((a) => a.fundCode === f.code && !a.isCash);
          return `
          <table class="r-table">
            <thead><tr><th>${esc(f.name)} 통장</th><th>${prevLabel}</th><th>${endLabel}</th></tr></thead>
            <tbody>${list.map((a) => `
              <tr><td>${esc(a.name)}</td><td class="amt">${formatWon(a.prev)}</td><td class="amt strong">${formatWon(a.end)}</td></tr>`).join('')}
            </tbody>
            <tfoot><tr><td>소계</td><td class="amt">${formatWon(sumBy(list, 'prev'))}</td><td class="amt">${formatWon(sumBy(list, 'end'))}</td></tr></tfoot>
          </table>`;
        }).join('')}
      </div>
      <table class="r-table r-grand">
        <tr><td>전체 합계${cashRows.length ? ' (현금 + 통장)' : ''}</td><td class="amt">${prevLabel} ${formatWon(r.total.prev)}</td>
          <td class="amt strong">${endLabel} ${formatWon(r.total.end)}</td></tr>
      </table>
    </article>`;
}

// ---------------------------------------------------------------- 예산 대비 집행

const pct = (rate) => (rate == null ? '-' : `${rate.toFixed(1)}%`);

function budgetTable(group, label, kind) {
  const over = (x) => kind === 'EXPENSE' && x.budget > 0 && x.actual > x.budget; // 지출이 예산을 넘음
  return `
    <table class="r-table fixed">
      <colgroup><col style="width:8mm"><col><col style="width:28mm"><col style="width:28mm"><col style="width:28mm"><col style="width:18mm"></colgroup>
      <thead><tr><th class="no">No</th><th>예산과목</th><th>예산액</th><th>${kind === 'INCOME' ? '수입액' : '집행액'}</th><th>잔액</th><th>${kind === 'INCOME' ? '달성률' : '집행률'}</th></tr></thead>
      <tbody>${group.items.length ? group.items.map((x, i) => `
        <tr class="${over(x) ? 'over' : ''}"><td class="no">${i + 1}</td><td>${esc(x.name)}${x.isActive ? '' : ' <span class="muted">(사용중지)</span>'}</td>
          <td class="amt">${formatWon(x.budget)}</td><td class="amt">${formatWon(x.actual)}</td>
          <td class="amt">${formatWon(x.remaining)}</td><td class="amt strong">${pct(x.rate)}</td></tr>`).join('')
        : `<tr><td colspan="6" class="empty">${label} 과목 없음</td></tr>`}</tbody>
      <tfoot><tr><td colspan="2">${label} 합계</td><td class="amt">${formatWon(group.budget)}</td><td class="amt">${formatWon(group.actual)}</td>
        <td class="amt">${formatWon(group.remaining)}</td><td class="amt">${pct(group.rate)}</td></tr></tfoot>
    </table>`;
}

function renderBudget(r) {
  document.title = `예산 대비 집행 ${r.year}년 - 본당살림`;
  const noBudget = r.income.budget === 0 && r.expense.budget === 0;
  $('state').innerHTML = noBudget
    ? `<span class="pill open">예산 없음</span> <span class="muted">${r.year}년 예산을 아직 넣지 않았습니다. <a href="${href('/settings#budget')}">설정 → 연 예산</a>에서 넣으세요.</span>`
    : `<span class="muted">${formatKoreanDate(r.through)}까지 집행 기준</span> · <a href="${href('/settings#budget')}">예산 고치기</a>`;
  $('warning').innerHTML = '';
  $('paper').innerHTML = `
    <article class="report">
      <div class="r-head ${r.approvalSteps.length > 4 ? 'stacked' : ''}">
        <div class="r-title">
          <h1>예 산 대 비 집 행</h1>
          <table class="r-meta">
            <tr><th>성 당</th><td>${esc(r.parishName)}</td></tr>
            <tr><th>회계연도</th><td>${r.year}년 <span class="range">(${monthDay(`${r.year}-01-01`)} ~ ${monthDay(r.through)})</span></td></tr>
            <tr><th>작성자</th><td>${esc(r.writerName)}<span class="seal">(인)</span></td></tr>
          </table>
        </div>
        ${approvalAreaHtml(r.approvalSteps, 'main')}
      </div>
      <h2>1. 수입</h2>
      ${budgetTable(r.income, '수입', 'INCOME')}
      <h2>2. 지출</h2>
      ${budgetTable(r.expense, '지출', 'EXPENSE')}
      <p class="r-note">※ 집행액은 확정된 수입·지출 거래의 합계입니다 (통장 간 이체는 넣지 않음). 잔액 = 예산액 − 집행액. 빨간 줄은 예산을 넘은 지출입니다.</p>
    </article>`;
}

// ---------------------------------------------------------------- 통장별 입출금 내역

let accountsReport = null;
let accountsSeq = 0;

const monthEnd = (d) => addDays(`${addDays(monthStart(d), 31).slice(0, 7)}-01`, -1);

/** 빠른 기간: 이번 달(1일~오늘) · 지난달 · 올해(1월 1일~오늘) */
function quickRange(range) {
  const today = todayKST();
  if (range === 'last') {
    const end = addDays(monthStart(today), -1);
    return { from: monthStart(end), to: end };
  }
  return { from: range === 'year' ? `${today.slice(0, 4)}-01-01` : monthStart(today), to: today };
}

/** 거래 한 줄: 이체는 상대 통장을 화살표로 (→ 보냄, ← 받음) */
function accountRowCells(t) {
  if (t.kind === 'TRANSFER') {
    return { kind: '이체', what: `${t.direction === 'OUT' ? '→' : '←'} ${t.counterpartName ?? ''}` };
  }
  if (t.deduction) return { kind: '차감', what: t.subjectName ?? '' };
  return { kind: t.direction === 'IN' ? '수입' : '지출', what: t.subjectName ?? '' };
}

/** 조회할 때 고른 통장만 (통장 전체면 모두) + 그 합계 */
function selectedAccounts(r) {
  const list = r.accountId ? r.accounts.filter((a) => a.id === r.accountId) : r.accounts;
  const total = Object.fromEntries(['prev', 'in', 'out', 'end'].map((k) => [k, sumBy(list, k)]));
  return { list, total };
}

function renderAccounts() {
  const r = accountsReport;
  const closed = r.status === 'CLOSED';
  const { list, total } = selectedAccounts(r);
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
  const day = (d) => (sameYear ? '' : `${d.slice(2, 4)}.`) + `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  document.title = `통장별 입출금 ${r.from}~${r.to} - 본당살림`;
  $('state').innerHTML = closed
    ? '<span class="pill closed">마감 완료</span> <span class="muted">기간 안의 모든 날이 마감되었습니다.</span>'
    : `<span class="pill open">미마감 포함</span> <span class="muted">마감되지 않은 날이 있어 가결산으로 출력됩니다.
        (마지막 마감일: ${r.closedThrough ? formatKoreanDate(r.closedThrough) : '없음'})</span>`;
  $('warning').innerHTML = '';

  const sections = list.map((a, i) => `
      <h2 class="${a.isCash ? 'cash' : ''}">${i + 2}. ${esc(a.name)}<span class="fund-tag">${FUND_LABEL[a.fundCode]}${a.isCash ? ' · 현금' : ''}</span></h2>
      <table class="r-table fixed">
        <colgroup><col style="width:15mm"><col style="width:11mm"><col style="width:36mm"><col>
          <col style="width:24mm"><col style="width:24mm"><col style="width:26mm"></colgroup>
        <thead><tr><th>날짜</th><th>구분</th><th>과목·상대통장</th><th>적요</th><th>입금</th><th>출금</th><th>잔액</th></tr></thead>
        <tbody>
          <tr class="carry"><td colspan="6">이월 잔액 (${monthDay(r.from)} 이전)</td><td class="amt">${formatWon(a.prev)}</td></tr>
          ${a.rows.length ? a.rows.map((t) => {
            const c = accountRowCells(t);
            return `<tr><td>${day(t.date)}</td><td>${c.kind}</td><td class="${t.kind === 'TRANSFER' ? 'xfer' : ''}">${esc(c.what)}</td>
              <td>${esc(t.memo ?? '')}</td><td class="amt">${t.direction === 'IN' ? formatWon(t.amount) : t.deduction ? formatWon(-t.amount) : ''}</td>
              <td class="amt">${t.direction === 'OUT' && !t.deduction ? formatWon(t.amount) : ''}</td><td class="amt">${formatWon(t.balance)}</td></tr>`;
          }).join('') : '<tr><td colspan="7" class="empty">기간 안에 입출금 없음</td></tr>'}
        </tbody>
        <tfoot><tr><td colspan="4">소계 (${a.rows.length}건)</td><td class="amt">${formatWon(a.in)}</td>
          <td class="amt">${formatWon(a.out)}</td><td class="amt">${formatWon(a.end)}</td></tr></tfoot>
      </table>`).join('');

  $('paper').innerHTML = `
    <article class="report ${closed ? '' : 'provisional'}">
      ${closed ? '' : '<div class="watermark" aria-hidden="true">가결산</div>'}
      <div class="r-head">
        <div class="r-title">
          <h1>통장별 입출금 내역${closed ? '' : ' <small>(가결산)</small>'}</h1>
          <table class="r-meta">
            <tr><th>성 당</th><td>${esc(r.parishName)}</td></tr>
            <tr><th>기 간</th><td>${formatKoreanDate(r.from)} ~ ${formatKoreanDate(r.to)}</td></tr>
            <tr><th>작성자</th><td>${esc(r.writerName)}<span class="seal">(인)</span></td></tr>
          </table>
        </div>
      </div>

      <h2>1. 통장별 요약</h2>
      <table class="r-table">
        <thead><tr><th>통장</th><th>회계</th><th>이월 잔액</th><th>입금</th><th>출금</th><th>기말 잔액</th></tr></thead>
        <tbody>${list.map((a) => `
          <tr class="${a.isCash ? 'cash' : ''}"><td>${esc(a.name)}</td><td>${FUND_LABEL[a.fundCode]}${a.isCash ? ' · 현금' : ''}</td><td class="amt">${formatWon(a.prev)}</td>
            <td class="amt">${formatWon(a.in)}</td><td class="amt">${formatWon(a.out)}</td><td class="amt strong">${formatWon(a.end)}</td></tr>`).join('')}
        </tbody>
        <tfoot><tr><td colspan="2">합 계</td><td class="amt">${formatWon(total.prev)}</td><td class="amt">${formatWon(total.in)}</td>
          <td class="amt">${formatWon(total.out)}</td><td class="amt">${formatWon(total.end)}</td></tr></tfoot>
      </table>
      ${sections}
      <p class="r-note">※ 입금·출금에는 통장 간 이체도 들어갑니다 (→ 보낸 통장, ← 받은 통장).</p>
    </article>`;
}

/** 통장별 내역 Excel: 요약 시트 + 통장마다 시트 하나 (금액은 숫자) */
function accountsSheets() {
  const r = accountsReport;
  const { list, total } = selectedAccounts(r);
  const b = (v) => ({ v, bold: true });
  const title = `통장별 입출금 내역${r.status === 'CLOSED' ? '' : ' (가결산)'}`;
  const meta = [[b(title)], ['성당', r.parishName], ['기간', `${r.from} ~ ${r.to}`], []];
  const summary = {
    name: '통장별 요약',
    widths: [24, 10, 16, 16, 16, 16],
    rows: [...meta,
      ['통장', '회계', '이월 잔액', '입금', '출금', '기말 잔액'].map(b),
      ...list.map((a) => [a.name, FUND_LABEL[a.fundCode], a.prev, a.in, a.out, a.end]),
      [b('합계'), null, b(total.prev), b(total.in), b(total.out), b(total.end)]],
  };
  const sheets = list.map((a) => ({
    name: a.name,
    widths: [12, 6, 22, 30, 14, 14, 16],
    rows: [[b(`${a.name} (${FUND_LABEL[a.fundCode]})`)], ['기간', `${r.from} ~ ${r.to}`], [],
      ['날짜', '구분', '과목·상대통장', '적요', '입금', '출금', '잔액'].map(b),
      [`이월 잔액 (${r.from} 이전)`, null, null, null, null, null, a.prev],
      ...a.rows.map((t) => {
        const c = accountRowCells(t);
        return [t.date, c.kind, c.what, t.memo ?? '', t.direction === 'IN' ? t.amount : t.deduction ? -t.amount : null,
          t.direction === 'OUT' && !t.deduction ? t.amount : null, t.balance];
      }),
      [b(`소계 (${a.rows.length}건)`), null, null, null, b(a.in), b(a.out), b(a.end)]],
  }));
  return [summary, ...sheets];
}

// ---------------------------------------------------------------- 개인별 납부 (특별회계 납부자별)

let donorsReport = null;
let donorsView = 'list'; // 'list' 사람별 목록 · 'all' 전체 내역서 · 그 밖은 납부자 이름 (그 사람 내역서)
const dotDate = (d) => `${d.slice(0, 4)}. ${Number(d.slice(5, 7))}. ${Number(d.slice(8, 10))}.`;

function donorHead(r, title, payer) {
  return `
      <div class="r-head">
        <div class="r-title">
          <h1>${title}</h1>
          <table class="r-meta">
            <tr><th>성 당</th><td>${esc(r.parishName)}</td></tr>
            <tr><th>기 간</th><td>${formatKoreanDate(r.from)} ~ ${formatKoreanDate(r.to)} <span class="range">(특별회계)</span></td></tr>
            ${payer == null ? '' : `<tr><th>납부자</th><td><b>${esc(payer)}</b></td></tr>`}
          </table>
        </div>
      </div>`;
}

/** 한 사람 내역서: 납입 날짜 · 헌금 종류 · 금액, 종류별 합계와 합계 (주민등록번호 칸 없음) */
function donorSheet(r, p) {
  return `
    <article class="report donor-sheet">
      ${donorHead(r, '개 인 별 납 부 내 역', p.payer)}
      <h2>1. 납부 내역</h2>
      <table class="r-table fixed">
        <colgroup><col style="width:10mm"><col style="width:40mm"><col><col style="width:40mm"></colgroup>
        <thead><tr><th class="no">No</th><th>납입 날짜</th><th>헌금 종류</th><th>금액</th></tr></thead>
        <tbody>${p.rows.map((x, i) => `
          <tr><td class="no">${i + 1}</td><td>${dotDate(x.date)}</td><td>${esc(x.subjectName)}</td><td class="amt">${formatWon(x.amount)}</td></tr>`).join('')}</tbody>
      </table>
      <h2>2. 헌금 종류별 합계</h2>
      <table class="r-table fixed">
        <colgroup><col><col style="width:30mm"><col style="width:40mm"></colgroup>
        <thead><tr><th>헌금 종류</th><th>건수</th><th>금액</th></tr></thead>
        <tbody>${p.bySubject.map((s) => `<tr><td>${esc(s.name)}</td><td class="amt">${s.count}</td><td class="amt">${formatWon(s.total)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>합 계</td><td class="amt">${p.count}</td><td class="amt">${formatWon(p.total)}</td></tr></tfoot>
      </table>
    </article>`;
}

function renderDonors() {
  const r = donorsReport;
  const closed = r.status === 'CLOSED';
  document.title = `개인별 납부 ${r.year} - 본당살림`;
  $('state').innerHTML = (closed ? '<span class="pill closed">마감 완료</span>' : '<span class="pill open">미마감 포함</span>')
    + ' <span class="muted">특별회계 수입 중 납부자를 적은 것만 모읍니다. 이름은 [거래 조회]에서 고칠 수 있습니다 (마감한 날도).</span>';
  $('warning').innerHTML = '';
  if (donorsView !== 'list') {
    const list = donorsView === 'all' ? r.people : r.people.filter((p) => p.payer === donorsView);
    $('paper').innerHTML = `
      <p class="no-print donor-back"><button type="button" class="secondary small" data-donor-view="list">← 사람별 목록</button>
        ${donorsView === 'all' ? `<span class="muted">${list.length}명 · 인쇄하면 한 사람에 한 장씩 나옵니다</span>` : ''}</p>
      ${list.map((p) => donorSheet(r, p)).join('') || '<p class="muted">내역이 없습니다.</p>'}`;
    return;
  }
  $('paper').innerHTML = `
    <article class="report">
      ${donorHead(r, '개인별 납부 현황', null)}
      <p class="no-print donor-tools">
        <button type="button" data-donor-view="all" ${r.people.length ? '' : 'disabled'}>전체 내역서 보기 (한 사람 한 장)</button>
        <input type="search" id="donor-find" placeholder="이름 찾기" aria-label="이름 찾기">
      </p>
      <table class="r-table fixed donor-list">
        <colgroup><col style="width:10mm"><col><col style="width:22mm"><col style="width:36mm"><col class="no-print" style="width:58mm"></colgroup>
        <thead><tr><th class="no">No</th><th>납부자</th><th>건수</th><th>합계</th><th class="no-print"></th></tr></thead>
        <tbody>${r.people.map((p, i) => `
          <tr data-name="${esc(p.payer)}"><td class="no">${i + 1}</td><td>${esc(p.payer)}</td><td class="amt">${p.count}</td><td class="amt">${formatWon(p.total)}</td>
            <td class="no-print"><button type="button" class="secondary small" data-donor-view="${esc(p.payer)}">내역서</button>
              ${p.similar.length ? `<span class="similar">비슷한 이름: ${p.similar.map(esc).join(', ')}</span>` : ''}</td></tr>`).join('')
          || '<tr><td colspan="5" class="empty">납부자를 적은 특별회계 수입이 없습니다</td></tr>'}</tbody>
        <tfoot><tr><td colspan="2">합 계 (${r.people.length}명)</td><td class="amt">${r.people.reduce((n, p) => n + p.count, 0)}</td><td class="amt">${formatWon(r.total)}</td><td class="no-print"></td></tr></tfoot>
      </table>
    </article>`;
}

/** 개인별 납부 Excel: 사람별 합계 시트 + 모든 납부 내역 시트 (금액은 숫자) */
function donorsSheets() {
  const r = donorsReport;
  const b = (v) => ({ v, bold: true });
  const meta = [[b(`개인별 납부 ${r.year}년 (특별회계)`)], ['성당', r.parishName], []];
  return [
    { name: '사람별 합계', widths: [6, 24, 8, 16],
      rows: [...meta, ['No', '납부자', '건수', '합계'].map(b), ...r.people.map((p, i) => [i + 1, p.payer, p.count, p.total]),
        [b('합계'), null, b(r.people.reduce((n, p) => n + p.count, 0)), b(r.total)]] },
    { name: '납부 내역', widths: [24, 12, 20, 14],
      rows: [...meta, ['납부자', '납입 날짜', '헌금 종류', '금액'].map(b),
        ...r.people.flatMap((p) => [...p.rows.map((x) => [p.payer, x.date, x.subjectName, x.amount]), [b(`${p.payer} 합계`), null, null, b(p.total)]])] },
  ];
}

$('paper').addEventListener('click', (e) => {
  const b = e.target.closest('[data-donor-view]');
  if (!b || type !== 'donors') return;
  donorsView = b.dataset.donorView;
  renderDonors();
  window.scrollTo(0, 0);
});
$('paper').addEventListener('input', (e) => {
  if (e.target.id !== 'donor-find') return;
  const q = e.target.value.trim();
  for (const tr of $('paper').querySelectorAll('.donor-list tbody tr[data-name]')) tr.hidden = Boolean(q) && !tr.dataset.name.includes(q);
});

// ---------------------------------------------------------------- 이벤트

const run = (p) => p.catch((err) => toast(err.message, 'error'));
const valid = (v) => (type === 'month' ? /^\d{4}-\d{2}$/.test(v) : /^\d{4}$/.test(v));
const go = (v) => { if (valid(v)) run(load(type, v)); };

$('report-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b || b.dataset.type === type) return;
  // 지금 보던 날짜가 속한 달·해를 연다. 보던 달·해가 오늘을 포함하면 오늘 기준으로.
  // 통장별 내역에서 넘어가면 종료일 기준, 통장별 내역으로 가면 그 달(이번 달이면 1일~오늘)
  const prefix = type === 'accounts' ? $('to').value : currentValue();
  const today = todayKST();
  const base = today.startsWith(prefix) ? today
    : type === 'accounts' ? prefix : type === 'month' ? `${prefix}-01` : `${prefix}-01-01`;
  const accounts = { from: monthStart(base), to: base.slice(0, 7) === today.slice(0, 7) ? today : monthEnd(base) };
  run(load(b.dataset.type, { month: base.slice(0, 7), year: base.slice(0, 4), budget: base.slice(0, 4), donors: base.slice(0, 4), accounts }[b.dataset.type]));
});
// 통장별 내역: 기간·통장을 고르고 [조회] (Enter 도 됨). 빠른 기간 버튼은 바로 조회
function searchAccounts() {
  const [from, to] = [$('from').value, $('to').value];
  if (!isValidDate(from) || !isValidDate(to)) return toast('시작일과 종료일을 고르세요.', 'error');
  if (from > to) return toast('시작일이 종료일보다 늦습니다.', 'error');
  run(load('accounts', { from, to }));
}
$('search-accounts').addEventListener('click', searchAccounts);
$('range-nav').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); searchAccounts(); }
});
$('range-nav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]');
  if (b) run(load('accounts', quickRange(b.dataset.range)));
});
for (const id of ['month', 'year']) $(id).addEventListener('change', () => go(currentValue()));
$('prev').addEventListener('click', () => go(shift(-1)));
$('next').addEventListener('click', () => go(shift(1)));
$('now').addEventListener('click', () => go(nowValue()));
$('print').addEventListener('click', () => window.print());

// 보고 있는 결산서를 Excel 로 (표 내용 그대로, 금액은 숫자로)
const SHEET_NAME = { month: '월말결산', year: '연말결산', budget: '예산 대비 집행' };
$('excel').addEventListener('click', () => {
  if (!$('paper').querySelector('.report')) return;
  if (type === 'accounts') {
    downloadXlsx(`본당살림 통장별 입출금 ${accountsReport.from}~${accountsReport.to}.xlsx`, accountsSheets());
    return;
  }
  if (type === 'donors') {
    downloadXlsx(`본당살림 개인별 납부 ${donorsReport.year}.xlsx`, donorsSheets());
    return;
  }
  downloadXlsx(`본당살림 ${SHEET_NAME[type]} ${currentValue()}.xlsx`, [reportSheet($('paper'), SHEET_NAME[type])]);
});

// 인쇄할 때마다 종이 오른쪽 아래에 출력 일시를 찍는다 (Ctrl+P 로 인쇄해도 같음)
const printedAt = document.createElement('style');
document.head.append(printedAt);
window.addEventListener('beforeprint', () => {
  printedAt.textContent = `@page { @bottom-right { content: "출력 일시 ${formatDateTimeKST(new Date().toISOString())}"; font-size: 8pt; color: #555; } }`;
});

initPage('report').then(({ settings }) => {
  const thisYear = Number(todayKST().slice(0, 4));
  const firstYear = Number((settings.parish?.startDate ?? todayKST()).slice(0, 4));
  for (let y = thisYear; y >= Math.min(firstYear, thisYear); y--) $('year').append(new Option(`${y}년`, String(y)));
  $('account').innerHTML = '<option value="">통장 전체</option>' + ['GENERAL', 'SPECIAL'].map((fund) => {
    const list = settings.accounts.filter((a) => a.fundCode === fund);
    return list.length ? `<optgroup label="${FUND_LABEL[fund]}">${list.map((a) =>
      `<option value="${a.id}" ${a.isCash ? 'class="cash-opt"' : ''}>${esc(a.name)}${a.isCash && !a.name.includes('현금') ? ' (현금)' : ''}${a.isActive ? '' : ' (사용중지)'}</option>`).join('')}</optgroup>` : '';
  }).join('');
  const p = new URLSearchParams(location.search);
  // 예전 일일결산 주소 (?date= 또는 ?type=day) → 그날 사목일지 (2쪽이 회계)
  if (p.get('type') === 'day' || (!p.get('type') && isValidDate(p.get('date')))) {
    location.replace(href(`/journal?date=${isValidDate(p.get('date')) ? p.get('date') : todayKST()}`));
    return null;
  }
  type = TYPES[p.get('type')] ? p.get('type') : 'month';
  if (type === 'accounts') {
    $('account').value = p.get('account') ?? '';
    const [from, to] = [p.get('from'), p.get('to')];
    return load(type, isValidDate(from) && isValidDate(to) && from <= to ? { from, to } : quickRange('month'));
  }
  const v = p.get(type);
  return load(type, v && valid(v) ? v : nowValue());
}).catch((err) => {
  $('paper').innerHTML = `<p class="error">${esc(err.message)}</p>`;
});
