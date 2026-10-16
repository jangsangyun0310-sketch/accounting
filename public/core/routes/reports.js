// 결산서 데이터
// 마감된 날은 마감 당시의 결재선·작성자를 쓰고, 잔액이 마감 스냅샷과 같은지 검증 결과를 함께 준다.
// 미마감 날은 현재 결재선·기본 작성자로 "가결산"을 만든다.
// 자동 마감된 날(거래가 없어 이후 날짜를 마감할 때 함께 잠긴 날)은 그 이후 마감 기록의 결재선·작성자로 정상 결산서를 만든다.
import { json } from '../lib/http.js';
import { TX_SELECT, computeDay, computePeriod, mapTx, periodBreakdown, subjectTotals, verifySnapshot } from '../lib/ledger.js';
import { bad } from '../lib/validate.js';
import { sumAmounts } from '../../js/shared/money.js';
import { addDays, isValidDate, todayKST } from '../../js/shared/dates.js';
import { approvalOf } from '../lib/approvals.js';

/** GET /api/reports/daily?date= */
export async function daily({ env, url }) {
  const date = url.searchParams.get('date') || todayKST();
  if (!isValidDate(date)) throw bad('날짜 형식이 올바르지 않습니다.', 'BAD_DATE');
  return json(await dailyData(env.DB, date));
}

/** 하루 회계 (사목일지 2쪽 · 날짜별 사목일지 Excel 공용) */
export async function dailyData(db, date) {
  const [day, parish, closing, dailySteps] = await Promise.all([
    computeDay(db, date),
    db.prepare('SELECT parish_name, writer_name, start_date FROM parish_settings WHERE id = 1').first(),
    db.prepare(
      `SELECT status, approval_snapshot, balance_snapshot, writer_name, closed_at, closed_by
       FROM daily_closings WHERE close_date = ?`
    ).bind(date).first(),
    approvalOf(db, 'daily'),
  ]);
  // 자동 마감: 이 날의 마감 기록은 없지만 이후 날짜가 마감되어 함께 잠긴 날 (마감 순서 규칙상 거래가 없는 날)
  const cover = closing?.status === 'CLOSED' || (parish && date < parish.start_date) ? null : await db.prepare(
    `SELECT close_date, approval_snapshot, writer_name, closed_at, closed_by
     FROM daily_closings WHERE status = 'CLOSED' AND close_date > ? ORDER BY close_date LIMIT 1`
  ).bind(date).first();
  const record = closing?.status === 'CLOSED' ? closing : cover;
  const closed = Boolean(record);

  const posted = day.transactions.filter((t) => t.status === 'POSTED');
  const pick = ({ id, accountName, accountIsCash, fundCode, subjectName, memo, voucherNo, amount, deduction }) =>
    ({ id, accountName, accountIsCash, fundCode, subjectName, memo, voucherNo, amount: deduction ? -amount : amount, deduction });
  const byFund = (a, b) => (a.fundCode === b.fundCode ? a.id - b.id : a.fundCode === 'GENERAL' ? -1 : 1);
  // 수입 내역에는 수입 차감(봉헌권 등)이 마이너스 금액으로 함께 나온다
  const income = posted.filter((t) => t.kind === 'NORMAL' && (t.direction === 'IN' || t.deduction)).map(pick).sort(byFund);
  const expense = posted.filter((t) => t.kind === 'NORMAL' && t.direction === 'OUT' && !t.deduction).map(pick).sort(byFund);

  // 이체는 출금·입금 한 쌍을 한 줄로
  const transfers = posted
    .filter((t) => t.kind === 'TRANSFER' && t.direction === 'OUT')
    .map((out) => {
      const inn = posted.find((t) => t.transferGroup === out.transferGroup && t.direction === 'IN');
      return {
        id: out.id,
        fromName: out.accountName,
        fromIsCash: out.accountIsCash,
        fromFund: out.fundCode,
        toName: inn?.accountName ?? out.counterpartName,
        toIsCash: inn?.accountIsCash ?? out.counterpartIsCash,
        toFund: inn?.fundCode ?? null,
        memo: out.memo,
        voucherNo: out.voucherNo,
        amount: out.amount,
      };
    });

  return {
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
  };
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
    approvalOf(db, type),
    db.prepare(`SELECT MAX(close_date) AS d FROM daily_closings WHERE status = 'CLOSED'`).first('d'),
  ]);
  const breakdown = await periodBreakdown(db, from, to, type === 'year' ? 'month' : 'day', summary.total.prev);

  return json({
    type,
    from,
    to,
    parishName: parish?.parish_name ?? '',
    writerName: parish?.writer_name ?? '',
    approvalSteps: steps,
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
  // 결재란: doc=month 이면 결산서(월말결산서 · 금전출납부 · 총계정원장 공용), 아니면 통장별 내역
  const doc = p.get('doc') === 'month' ? 'month' : 'accounts';
  const [summary, txs, parish, lastClosed, steps] = await Promise.all([
    computePeriod(db, from, to),
    db.prepare(`${TX_SELECT} WHERE t.tx_date BETWEEN ? AND ? AND t.status = 'POSTED' ORDER BY t.tx_date, t.id`).bind(from, to).all(),
    db.prepare('SELECT parish_name, writer_name FROM parish_settings WHERE id = 1').first(),
    db.prepare(`SELECT MAX(close_date) AS d FROM daily_closings WHERE status = 'CLOSED'`).first('d'),
    approvalOf(db, doc),
  ]);
  const rows = txs.results.map(mapTx);

  const list = summary.accounts.map((a) => {
    let balance = a.prev;
    const items = rows.filter((t) => t.accountId === a.id).map((t) => {
      balance = sumAmounts([balance, t.direction === 'IN' ? t.amount : -t.amount]);
      return {
        id: t.id, date: t.date, kind: t.kind, direction: t.direction, deduction: t.deduction,
        subjectName: t.subjectName, counterpartName: t.counterpartName, payer: t.payer,
        memo: t.memo, voucherNo: t.voucherNo, amount: t.amount, balance,
      };
    });
    const inSum = sumAmounts([a.income, a.transferIn]);
    const outSum = sumAmounts([a.expense, a.transferOut]);
    if (balance !== a.end) throw new Error(`통장 ${a.name}: 거래 합계와 기말 잔액이 맞지 않습니다.`);
    return {
      id: a.id, name: a.name, fundCode: a.fundCode, isCash: a.isCash, prev: a.prev, in: inSum, out: outSum, end: a.end,
      // 이체를 뺀 수입 · 지출과 이체 (월말결산서 · 금전출납부용)
      income: a.income, expense: a.expense, transferIn: a.transferIn, transferOut: a.transferOut,
      rows: items,
    };
  }).sort((a, b) => b.isCash - a.isCash); // 사무실 현금을 맨 위에
  const total = Object.fromEntries(['prev', 'in', 'out', 'end', 'income', 'expense', 'transferIn', 'transferOut']
    .map((k) => [k, sumAmounts(list.map((a) => a[k]))]));

  return json({
    from,
    to,
    parishName: parish?.parish_name ?? '',
    writerName: parish?.writer_name ?? '',
    approvalSteps: steps,
    status: lastClosed && lastClosed >= to ? 'CLOSED' : 'PROVISIONAL',
    closedThrough: lastClosed ?? null,
    funds: summary.funds.map(({ code, name }) => ({ code, name })),
    accounts: list,
    total,
  });
}

/**
 * GET /api/reports/donors?year=YYYY : 개인별 납부 (특별회계 수입 중 납부자를 적은 것)
 * 사람마다 납입 날짜 · 헌금 종류(과목) · 금액, 종류별 합계, 합계. 연말정산 기부금 영수증 준비용.
 * similar: 괄호·띄어쓰기를 빼면 같은 이름 (예: 홍길동 / 홍길동(베드로)) — 따로 잡혔는지 확인하라는 표시
 */
export async function donors({ env, url }) {
  const year = url.searchParams.get('year') || todayKST().slice(0, 4);
  if (!/^\d{4}$/.test(year)) throw bad('연도 형식이 올바르지 않습니다.', 'BAD_DATE');
  const db = env.DB;
  const [rows, parish, lastClosed, steps] = await Promise.all([
    db.prepare(
      `SELECT p.payer, t.id, t.tx_date, a.name AS subject_name, t.memo, t.amount
       FROM tx_payers p
       JOIN transactions t ON t.id = p.tx_id
       JOIN accounts a ON a.id = t.account_id
       JOIN funds f ON f.id = a.fund_id
       WHERE t.status = 'POSTED' AND t.kind = 'NORMAL' AND t.direction = 'IN' AND f.code = 'SPECIAL'
         AND t.tx_date BETWEEN ? AND ?
       ORDER BY p.payer, t.tx_date, t.id`
    ).bind(`${year}-01-01`, `${year}-12-31`).all(),
    db.prepare('SELECT parish_name, writer_name FROM parish_settings WHERE id = 1').first(),
    db.prepare(`SELECT MAX(close_date) AS d FROM daily_closings WHERE status = 'CLOSED'`).first('d'),
    approvalOf(db, 'donors'),
  ]);

  const byPayer = new Map();
  for (const r of rows.results) {
    if (!byPayer.has(r.payer)) byPayer.set(r.payer, []);
    // 헌금 종류 = 통장 (특별회계는 통장이 과목 역할)
    byPayer.get(r.payer).push({ id: r.id, date: r.tx_date, subjectName: r.subject_name ?? '', memo: r.memo ?? '', amount: r.amount });
  }
  const base = (name) => name.replace(/\([^)]*\)|\s/g, '');
  const groups = new Map();
  for (const name of byPayer.keys()) groups.set(base(name), [...(groups.get(base(name)) ?? []), name]);

  const people = [...byPayer].map(([payer, items]) => {
    const subjects = new Map();
    for (const it of items) {
      const s = subjects.get(it.subjectName) ?? { name: it.subjectName, count: 0, amounts: [] };
      s.count += 1;
      s.amounts.push(it.amount);
      subjects.set(it.subjectName, s);
    }
    return {
      payer,
      count: items.length,
      total: sumAmounts(items.map((x) => x.amount)),
      rows: items,
      bySubject: [...subjects.values()].map((s) => ({ name: s.name, count: s.count, total: sumAmounts(s.amounts) })),
      similar: groups.get(base(payer)).filter((n) => n !== payer),
    };
  }).sort((a, b) => a.payer.localeCompare(b.payer, 'ko'));

  return json({
    year: Number(year),
    from: `${year}-01-01`,
    to: `${year}-12-31`,
    parishName: parish?.parish_name ?? '',
    writerName: parish?.writer_name ?? '',
    approvalSteps: steps,
    status: lastClosed && lastClosed >= `${year}-12-31` ? 'CLOSED' : 'PROVISIONAL',
    people,
    total: sumAmounts(people.map((p) => p.total)),
  });
}
