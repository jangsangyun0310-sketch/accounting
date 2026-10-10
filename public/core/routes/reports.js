// 결산서 데이터
// 마감된 날은 마감 당시의 결재선·작성자를 쓰고, 잔액이 마감 스냅샷과 같은지 검증 결과를 함께 준다.
// 미마감 날은 현재 결재선·기본 작성자로 "가결산"을 만든다.
// 자동 마감된 날(거래가 없어 이후 날짜를 마감할 때 함께 잠긴 날)은 그 이후 마감 기록의 결재선·작성자로 정상 결산서를 만든다.
import { json } from '../lib/http.js';
import { TX_SELECT, computeDay, computePeriod, mapTx, periodBreakdown, subjectTotals, verifySnapshot } from '../lib/ledger.js';
import { bad } from '../lib/validate.js';
import { sumAmounts } from '../../js/shared/money.js';
import { addDays, isValidDate, todayKST } from '../../js/shared/dates.js';
import { dailyApprovalSteps } from './journal.js';

/** GET /api/reports/daily?date= */
export async function daily({ env, url }) {
  const date = url.searchParams.get('date') || todayKST();
  if (!isValidDate(date)) throw bad('날짜 형식이 올바르지 않습니다.', 'BAD_DATE');
  const db = env.DB;
  const [day, parish, closing, dailySteps] = await Promise.all([
    computeDay(db, date),
    db.prepare('SELECT parish_name, writer_name, start_date FROM parish_settings WHERE id = 1').first(),
    db.prepare(
      `SELECT status, approval_snapshot, balance_snapshot, writer_name, closed_at, closed_by
       FROM daily_closings WHERE close_date = ?`
    ).bind(date).first(),
    dailyApprovalSteps(db),
  ]);
  // 자동 마감: 이 날의 마감 기록은 없지만 이후 날짜가 마감되어 함께 잠긴 날 (마감 순서 규칙상 거래가 없는 날)
  const cover = closing?.status === 'CLOSED' || (parish && date < parish.start_date) ? null : await db.prepare(
    `SELECT close_date, approval_snapshot, writer_name, closed_at, closed_by
     FROM daily_closings WHERE status = 'CLOSED' AND close_date > ? ORDER BY close_date LIMIT 1`
  ).bind(date).first();
  const record = closing?.status === 'CLOSED' ? closing : cover;
  const closed = Boolean(record);

  const posted = day.transactions.filter((t) => t.status === 'POSTED');
  const pick = ({ id, accountName, fundCode, subjectName, memo, voucherNo, amount }) =>
    ({ id, accountName, fundCode, subjectName, memo, voucherNo, amount });
  const byFund = (a, b) => (a.fundCode === b.fundCode ? a.id - b.id : a.fundCode === 'GENERAL' ? -1 : 1);
  const income = posted.filter((t) => t.kind === 'NORMAL' && t.direction === 'IN').map(pick).sort(byFund);
  const expense = posted.filter((t) => t.kind === 'NORMAL' && t.direction === 'OUT').map(pick).sort(byFund);

  // 이체는 출금·입금 한 쌍을 한 줄로
  const transfers = posted
    .filter((t) => t.kind === 'TRANSFER' && t.direction === 'OUT')
    .map((out) => {
      const inn = posted.find((t) => t.transferGroup === out.transferGroup && t.direction === 'IN');
      return {
        id: out.id,
        fromName: out.accountName,
        fromFund: out.fundCode,
        toName: inn?.accountName ?? out.counterpartName,
        toFund: inn?.fundCode ?? null,
        memo: out.memo,
        voucherNo: out.voucherNo,
        amount: out.amount,
      };
    });

  return json({
    date,
    parishName: parish?.parish_name ?? '',
    writerName: (closed ? record.writer_name : parish?.writer_name) ?? '',
    approvalSteps: closed ? JSON.parse(record.approval_snapshot) : dailySteps,
    status: closed ? 'CLOSED' : 'PROVISIONAL',
    autoClosedBy: cover ? cover.close_date : null, // 자동 마감이면 함께 마감한 날짜
    closedAt: closed ? record.closed_at : null,
    closedBy: closed ? record.closed_by : null,
    // 잔액 검증은 그 날짜의 마감 스냅샷으로만 (자동 마감한 날은 거래가 없어 전날 잔액 그대로)
    verification: closing?.status === 'CLOSED' ? await verifySnapshot(db, date, closing.balance_snapshot) : null,
    beforeStart: parish ? date < parish.start_date : false,
    funds: day.funds,
    total: day.total,
    accounts: day.accounts,
    income: { rows: income, total: sumAmounts(income.map((r) => r.amount)) },
    expense: { rows: expense, total: sumAmounts(expense.map((r) => r.amount)) },
    transfers: { rows: transfers, total: sumAmounts(transfers.map((r) => r.amount)) },
  });
}

/**
 * GET /api/reports/period?type=month&month=YYYY-MM | type=year&year=YYYY : 월말·연말 결산
 * 기간 안의 모든 날이 마감되어 있으면 CLOSED, 아니면 PROVISIONAL(가결산).
 */
export async function period({ env, url }) {
  const p = url.searchParams;
  const type = p.get('type');
  let from;
  let to;
  if (type === 'month') {
    const m = p.get('month') || todayKST().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m) || !isValidDate(`${m}-01`)) throw bad('월 형식이 올바르지 않습니다.', 'BAD_DATE');
    from = `${m}-01`;
    to = addDays(`${addDays(from, 31).slice(0, 7)}-01`, -1);
  } else if (type === 'year') {
    const y = p.get('year') || todayKST().slice(0, 4);
    if (!/^\d{4}$/.test(y)) throw bad('연도 형식이 올바르지 않습니다.', 'BAD_DATE');
    from = `${y}-01-01`;
    to = `${y}-12-31`;
  } else {
    throw bad('결산 종류가 올바르지 않습니다.');
  }

  const db = env.DB;
  const [summary, income, expense, parish, steps, lastClosed] = await Promise.all([
    computePeriod(db, from, to),
    subjectTotals(db, from, to, 'INCOME'),
    subjectTotals(db, from, to, 'EXPENSE'),
    db.prepare('SELECT parish_name, writer_name FROM parish_settings WHERE id = 1').first(),
    db.prepare('SELECT title FROM approval_steps ORDER BY seq').all(),
    db.prepare(`SELECT MAX(close_date) AS d FROM daily_closings WHERE status = 'CLOSED'`).first('d'),
  ]);
  const breakdown = await periodBreakdown(db, from, to, type === 'year' ? 'month' : 'day', summary.total.prev);

  return json({
    type,
    from,
    to,
    parishName: parish?.parish_name ?? '',
    writerName: parish?.writer_name ?? '',
    approvalSteps: steps.results.map((s) => s.title),
    status: lastClosed && lastClosed >= to ? 'CLOSED' : 'PROVISIONAL',
    closedThrough: lastClosed ?? null,
    funds: summary.funds,
    total: summary.total,
    accounts: summary.accounts,
    income: { rows: income, total: sumAmounts(income.map((r) => r.total)) },
    expense: { rows: expense, total: sumAmounts(expense.map((r) => r.total)) },
    breakdown,
  });
}

/**
 * GET /api/reports/accounts?from=YYYY-MM-DD&to=YYYY-MM-DD : 통장별 입출금 내역
 * 통장마다 이월 잔액(prev)·입금·출금·기말 잔액과 기간 안의 거래(날짜순, 줄마다 잔액)를 준다. 이체도 입금·출금에 넣는다.
 */
export async function accounts({ env, url }) {
  const p = url.searchParams;
  const today = todayKST();
  const from = p.get('from') || `${today.slice(0, 7)}-01`;
  const to = p.get('to') || today;
  if (!isValidDate(from) || !isValidDate(to)) throw bad('날짜 형식이 올바르지 않습니다.', 'BAD_DATE');
  if (from > to) throw bad('시작일이 종료일보다 늦습니다.', 'BAD_RANGE');

  const db = env.DB;
  const [summary, txs, parish, lastClosed] = await Promise.all([
    computePeriod(db, from, to),
    db.prepare(`${TX_SELECT} WHERE t.tx_date BETWEEN ? AND ? AND t.status = 'POSTED' ORDER BY t.tx_date, t.id`).bind(from, to).all(),
    db.prepare('SELECT parish_name, writer_name FROM parish_settings WHERE id = 1').first(),
    db.prepare(`SELECT MAX(close_date) AS d FROM daily_closings WHERE status = 'CLOSED'`).first('d'),
  ]);
  const rows = txs.results.map(mapTx);

  const list = summary.accounts.map((a) => {
    let balance = a.prev;
    const items = rows.filter((t) => t.accountId === a.id).map((t) => {
      balance = sumAmounts([balance, t.direction === 'IN' ? t.amount : -t.amount]);
      return {
        id: t.id, date: t.date, kind: t.kind, direction: t.direction,
        subjectName: t.subjectName, counterpartName: t.counterpartName,
        memo: t.memo, voucherNo: t.voucherNo, amount: t.amount, balance,
      };
    });
    const inSum = sumAmounts([a.income, a.transferIn]);
    const outSum = sumAmounts([a.expense, a.transferOut]);
    if (balance !== a.end) throw new Error(`통장 ${a.name}: 거래 합계와 기말 잔액이 맞지 않습니다.`);
    return { id: a.id, name: a.name, fundCode: a.fundCode, prev: a.prev, in: inSum, out: outSum, end: a.end, rows: items };
  });
  const total = {
    prev: sumAmounts(list.map((a) => a.prev)),
    in: sumAmounts(list.map((a) => a.in)),
    out: sumAmounts(list.map((a) => a.out)),
    end: sumAmounts(list.map((a) => a.end)),
  };

  return json({
    from,
    to,
    parishName: parish?.parish_name ?? '',
    writerName: parish?.writer_name ?? '',
    status: lastClosed && lastClosed >= to ? 'CLOSED' : 'PROVISIONAL',
    closedThrough: lastClosed ?? null,
    funds: summary.funds.map(({ code, name }) => ({ code, name })),
    accounts: list,
    total,
  });
}
