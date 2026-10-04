// 결산서 데이터
// 마감된 날은 마감 당시의 결재선·작성자를 쓰고, 잔액이 마감 스냅샷과 같은지 검증 결과를 함께 준다.
// 미마감 날은 현재 결재선·기본 작성자로 "가결산"을 만든다.
import { json } from '../lib/http.js';
import { computeDay, verifySnapshot } from '../lib/ledger.js';
import { bad } from '../lib/validate.js';
import { sumAmounts } from '../../public/js/shared/money.js';
import { isValidDate, todayKST } from '../../public/js/shared/dates.js';

/** GET /api/reports/daily?date= */
export async function daily({ env, url }) {
  const date = url.searchParams.get('date') || todayKST();
  if (!isValidDate(date)) throw bad('날짜 형식이 올바르지 않습니다.', 'BAD_DATE');
  const db = env.DB;
  const [day, parish, closing, steps] = await Promise.all([
    computeDay(db, date),
    db.prepare('SELECT parish_name, writer_name, start_date FROM parish_settings WHERE id = 1').first(),
    db.prepare(
      `SELECT status, approval_snapshot, balance_snapshot, writer_name, closed_at, closed_by
       FROM daily_closings WHERE close_date = ?`
    ).bind(date).first(),
    db.prepare('SELECT title FROM approval_steps ORDER BY seq').all(),
  ]);
  const closed = closing?.status === 'CLOSED';

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
    writerName: (closed ? closing.writer_name : parish?.writer_name) ?? '',
    approvalSteps: closed ? JSON.parse(closing.approval_snapshot) : steps.results.map((s) => s.title),
    status: closed ? 'CLOSED' : 'PROVISIONAL',
    closedAt: closed ? closing.closed_at : null,
    closedBy: closed ? closing.closed_by : null,
    verification: closed ? await verifySnapshot(db, date, closing.balance_snapshot) : null,
    beforeStart: parish ? date < parish.start_date : false,
    funds: day.funds,
    total: day.total,
    accounts: day.accounts,
    income: { rows: income, total: sumAmounts(income.map((r) => r.amount)) },
    expense: { rows: expense, total: sumAmounts(expense.map((r) => r.amount)) },
    transfers: { rows: transfers, total: sumAmounts(transfers.map((r) => r.amount)) },
  });
}
