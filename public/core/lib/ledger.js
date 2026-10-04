// 거래·잔액 조회 로직 (거래 입력 화면, 거래 조회 화면, 이후 결산서가 함께 사용)
import { ApiError } from './http.js';
import { BALANCES_SQL } from './db.js';
import { addDays } from '../../js/shared/dates.js';
import { assertInteger, sumAmounts } from '../../js/shared/money.js';

export const TX_SELECT = `
  SELECT t.id, t.tx_date, t.kind, t.direction, t.account_id, a.name AS account_name, f.code AS fund_code,
         t.subject_id, s.name AS subject_name, t.transfer_group,
         (SELECT p.account_id FROM transactions p
           WHERE p.transfer_group = t.transfer_group AND p.id <> t.id) AS counterpart_account_id,
         (SELECT pa.name FROM transactions p JOIN accounts pa ON pa.id = p.account_id
           WHERE p.transfer_group = t.transfer_group AND p.id <> t.id) AS counterpart_name,
         t.amount, t.memo, t.voucher_no, t.status, t.replaces_id,
         (SELECT r.id FROM transactions r WHERE r.replaces_id = t.id) AS replaced_by_id,
         t.void_reason, t.voided_at, t.voided_by, t.created_at, t.created_by
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  JOIN funds f ON f.id = a.fund_id
  LEFT JOIN budget_subjects s ON s.id = t.subject_id`;

export function mapTx(r) {
  return {
    id: r.id,
    date: r.tx_date,
    kind: r.kind,
    direction: r.direction,
    accountId: r.account_id,
    accountName: r.account_name,
    fundCode: r.fund_code,
    subjectId: r.subject_id,
    subjectName: r.subject_name,
    transferGroup: r.transfer_group,
    counterpartAccountId: r.counterpart_account_id,
    counterpartName: r.counterpart_name,
    amount: assertInteger(r.amount),
    memo: r.memo,
    voucherNo: r.voucher_no,
    status: r.status,
    replacesId: r.replaces_id,
    replacedById: r.replaced_by_id,
    voidReason: r.void_reason,
    voidedAt: r.voided_at,
    voidedBy: r.voided_by,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

const LOCKED_SQL = `SELECT EXISTS (SELECT 1 FROM daily_closings WHERE status = 'CLOSED' AND close_date >= ?) AS locked`;

export async function isDateLocked(db, date) {
  return (await db.prepare(LOCKED_SQL).bind(date).first('locked')) === 1;
}

/**
 * 기간 현황 (from ~ to): 통장별·회계별 기초잔액(prev) / 수입 / 지출 / 이체입금 / 이체출금 / 기말잔액(end).
 * 기초잔액 + 수입 − 지출 + 이체입금 − 이체출금 = 기말잔액 이 맞지 않으면 오류를 낸다.
 * 하루 현황은 from = to 인 기간이다.
 */
export async function computePeriod(db, from, to) {
  const [prev, end, sums] = await db.batch([
    db.prepare(BALANCES_SQL).bind(addDays(from, -1)),
    db.prepare(BALANCES_SQL).bind(to),
    db.prepare(
      `SELECT t.account_id,
              SUM(CASE WHEN t.kind = 'NORMAL'   AND t.direction = 'IN'  THEN t.amount ELSE 0 END) AS income,
              SUM(CASE WHEN t.kind = 'NORMAL'   AND t.direction = 'OUT' THEN t.amount ELSE 0 END) AS expense,
              SUM(CASE WHEN t.kind = 'TRANSFER' AND t.direction = 'IN'  THEN t.amount ELSE 0 END) AS transfer_in,
              SUM(CASE WHEN t.kind = 'TRANSFER' AND t.direction = 'OUT' THEN t.amount ELSE 0 END) AS transfer_out
       FROM transactions t
       WHERE t.tx_date BETWEEN ? AND ? AND t.status = 'POSTED'
       GROUP BY t.account_id`
    ).bind(from, to),
  ]);

  const prevById = new Map(prev.results.map((r) => [r.id, r.balance]));
  const sumById = new Map(sums.results.map((r) => [r.account_id, r]));
  const accounts = end.results.map((r) => {
    const sum = sumById.get(r.id) ?? {};
    const row = {
      id: r.id,
      fundCode: r.fund_code,
      name: r.name,
      isActive: r.is_active === 1,
      prev: assertInteger(prevById.get(r.id)),
      income: assertInteger(sum.income ?? 0),
      expense: assertInteger(sum.expense ?? 0),
      transferIn: assertInteger(sum.transfer_in ?? 0),
      transferOut: assertInteger(sum.transfer_out ?? 0),
      end: assertInteger(r.balance),
    };
    checkEquation(row, `통장 ${row.name}`);
    return row;
  }).filter((x) => x.isActive || x.prev !== 0 || x.end !== 0 || x.income || x.expense || x.transferIn || x.transferOut);

  const funds = [...new Map(end.results.map((r) => [r.fund_code, r.fund_name]))].map(([code, name]) => ({
    code, name, ...totals(accounts.filter((x) => x.fundCode === code)),
  }));
  funds.forEach((f) => checkEquation(f, f.name));
  const total = totals(accounts);
  checkEquation(total, '전체');
  return { from, to, accounts, funds, total };
}

/** 하루 현황 + 당일 거래 목록 + 잠김 여부 */
export async function computeDay(db, date) {
  const [period, txs, locked] = await Promise.all([
    computePeriod(db, date, date),
    db.prepare(`${TX_SELECT} WHERE t.tx_date = ? AND t.status = 'POSTED' ORDER BY t.id`).bind(date).all(),
    db.prepare(LOCKED_SQL).bind(date).first('locked'),
  ]);
  const { accounts, funds, total } = period;
  return { date, locked: locked === 1, accounts, funds, total, transactions: txs.results.map(mapTx) };
}

/**
 * 예산과목별 합계 (회계별로 나눠서). kind = INCOME | EXPENSE
 * @returns [{ subjectId, name, GENERAL, SPECIAL, total }]
 */
export async function subjectTotals(db, from, to, kind) {
  const { results } = await db.prepare(
    `SELECT s.id, s.name, s.sort_order, f.code AS fund_code, SUM(t.amount) AS amount
     FROM transactions t
     JOIN budget_subjects s ON s.id = t.subject_id
     JOIN accounts a ON a.id = t.account_id
     JOIN funds f ON f.id = a.fund_id
     WHERE t.tx_date BETWEEN ? AND ? AND t.status = 'POSTED' AND t.kind = 'NORMAL' AND s.kind = ?
     GROUP BY s.id, f.code
     ORDER BY s.sort_order, s.id`
  ).bind(from, to, kind).all();
  const bySubject = new Map();
  for (const r of results) {
    const row = bySubject.get(r.id) ?? { subjectId: r.id, name: r.name, GENERAL: 0, SPECIAL: 0, total: 0 };
    row[r.fund_code] = sumAmounts([row[r.fund_code], assertInteger(r.amount)]);
    row.total = sumAmounts([row.total, assertInteger(r.amount)]);
    bySubject.set(r.id, row);
  }
  return [...bySubject.values()];
}

/**
 * 기간 안의 날짜별(unit='day') 또는 월별(unit='month') 수입·지출과 그 시점 전체 잔액.
 * 거래가 있는 날(달)만 나온다. 이체는 전체 잔액을 바꾸지 않으므로 수입·지출만 본다.
 */
export async function periodBreakdown(db, from, to, unit, openingTotal) {
  const key = unit === 'month' ? 'substr(t.tx_date, 1, 7)' : 't.tx_date';
  const { results } = await db.prepare(
    `SELECT ${key} AS k,
            SUM(CASE WHEN t.kind = 'NORMAL' AND t.direction = 'IN'  THEN t.amount ELSE 0 END) AS income,
            SUM(CASE WHEN t.kind = 'NORMAL' AND t.direction = 'OUT' THEN t.amount ELSE 0 END) AS expense
     FROM transactions t
     WHERE t.tx_date BETWEEN ? AND ? AND t.status = 'POSTED'
     GROUP BY k ORDER BY k`
  ).bind(from, to).all();
  let running = assertInteger(openingTotal);
  return results
    .filter((r) => r.income || r.expense)
    .map((r) => {
      running = sumAmounts([running, assertInteger(r.income), -assertInteger(r.expense)]);
      return { key: r.k, income: r.income, expense: r.expense, balance: running };
    });
}

const FIELDS = ['prev', 'income', 'expense', 'transferIn', 'transferOut', 'end'];

function totals(rows) {
  return Object.fromEntries(FIELDS.map((k) => [k, sumAmounts(rows.map((r) => r[k]))]));
}

function checkEquation(r, label) {
  const computed = sumAmounts([r.prev, r.income, -r.expense, r.transferIn, -r.transferOut]);
  if (computed !== r.end) {
    throw new ApiError(500, 'INTEGRITY', `잔액 검증 실패(${label}): 계산 ${computed}, 실제 ${r.end}. 관리자에게 문의하세요.`);
  }
}

/**
 * 거래 검색. accountId 를 지정하면 기간 시작 전 잔액(openingBalance)과 거래별 잔액(balanceAfter)을 함께 준다.
 * @param {{from:string,to:string,accountId?:number,subjectId?:number,kind?:string,q?:string}} f
 */
export async function searchTransactions(db, f, limit = 2000) {
  const where = ['t.tx_date BETWEEN ? AND ?'];
  const binds = [f.from, f.to];
  if (f.accountId) { where.push('t.account_id = ?'); binds.push(f.accountId); }
  if (f.subjectId) { where.push('t.subject_id = ?'); binds.push(f.subjectId); }
  if (f.kind === 'IN' || f.kind === 'OUT') { where.push("t.kind = 'NORMAL' AND t.direction = ?"); binds.push(f.kind); }
  if (f.kind === 'TRANSFER') where.push("t.kind = 'TRANSFER'");
  where.push("t.status = 'POSTED'");
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(t.memo LIKE ? ESCAPE '\\' OR t.voucher_no LIKE ? ESCAPE '\\')");
    binds.push(like, like);
  }
  const { results } = await db.prepare(`${TX_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.tx_date, t.id LIMIT ?`)
    .bind(...binds, limit + 1).all();
  const truncated = results.length > limit;
  const rows = results.slice(0, limit).map(mapTx);

  let openingBalance = null;
  if (f.accountId) {
    openingBalance = assertInteger(await db.prepare(
      `SELECT a.opening_balance + COALESCE((
         SELECT SUM(CASE t.direction WHEN 'IN' THEN t.amount ELSE -t.amount END) FROM transactions t
         WHERE t.account_id = a.id AND t.status = 'POSTED' AND t.tx_date < ?), 0) AS balance
       FROM accounts a WHERE a.id = ?`
    ).bind(f.from, f.accountId).first('balance') ?? 0);
    // 검색어·과목·구분 필터가 있으면 일부 거래만 보이므로 거래별 잔액은 의미가 없다
    if (!f.subjectId && !f.kind && !f.q) {
      let running = openingBalance;
      for (const r of rows) {
        if (r.status !== 'POSTED') { r.balanceAfter = null; continue; }
        running = sumAmounts([running, r.direction === 'IN' ? r.amount : -r.amount]);
        r.balanceAfter = running;
      }
    }
  }

  const posted = rows.filter((r) => r.status === 'POSTED');
  return {
    rows,
    truncated,
    openingBalance,
    totals: {
      income: sumAmounts(posted.filter((r) => r.kind === 'NORMAL' && r.direction === 'IN').map((r) => r.amount)),
      expense: sumAmounts(posted.filter((r) => r.kind === 'NORMAL' && r.direction === 'OUT').map((r) => r.amount)),
      transferIn: sumAmounts(posted.filter((r) => r.kind === 'TRANSFER' && r.direction === 'IN').map((r) => r.amount)),
      transferOut: sumAmounts(posted.filter((r) => r.kind === 'TRANSFER' && r.direction === 'OUT').map((r) => r.amount)),
    },
  };
}

/**
 * 마감 스냅샷(통장별 잔액)과 현재 계산 잔액 비교.
 * @param {string} snapshotJson daily_closings.balance_snapshot
 * @returns {Promise<{ok:boolean, mismatches:Array}>}
 */
export async function verifySnapshot(db, date, snapshotJson) {
  const snapshot = JSON.parse(snapshotJson);
  const { results } = await db.prepare(BALANCES_SQL).bind(date).all();
  const current = new Map(results.map((r) => [r.id, assertInteger(r.balance)]));
  const mismatches = [];
  for (const s of snapshot) {
    if (current.get(s.id) !== s.balance) {
      mismatches.push({ accountId: s.id, name: s.name, snapshot: s.balance, current: current.get(s.id) ?? null });
    }
    current.delete(s.id);
  }
  for (const [id, balance] of current) {
    if (balance !== 0) mismatches.push({ accountId: id, name: results.find((r) => r.id === id).name, snapshot: null, current: balance });
  }
  return { ok: mismatches.length === 0, mismatches };
}
