// 인수인계용 전체 자료: 화면이 이것으로 Excel 한 파일(시트 여러 장)을 만든다.
//   GET /api/export/all : 운영 개시일 ~ 오늘의 거래 · 월별 결산 · 연도별 과목 합계 · 통장 · 사목일지 · 개인별 납부 · 설정
// 사무장이 바뀌거나 프로그램을 더 쓰지 않게 되어도 Excel 만으로 기록을 이어 볼 수 있게 하려는 것.
import { json } from '../lib/http.js';
import { computePeriod, searchTransactions, subjectTotals } from '../lib/ledger.js';
import { addDays, todayKST } from '../../js/shared/dates.js';
import { bad } from '../lib/validate.js';
import { journalData } from './journal.js';
import { dailyData } from './reports.js';

const monthEnd = (ym) => addDays(`${addDays(`${ym}-01`, 31).slice(0, 7)}-01`, -1);

export async function all({ env, actor }) {
  const db = env.DB;
  const parish = await db.prepare('SELECT parish_name, start_date, writer_name FROM parish_settings WHERE id = 1').first();
  const from = parish.start_date;
  const to = todayKST() < from ? from : todayKST();

  // 월 목록 (운영 개시 달 ~ 이번 달)
  const months = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addDays(`${m}-01`, 31).slice(0, 7)) months.push(m);
  const years = [...new Set(months.map((m) => m.slice(0, 4)))];

  const [tx, accountsNow, settingsRows, journals, masses, documents, donors, equipment] = await Promise.all([
    searchTransactions(db, { from, to }, 1_000_000),
    computePeriod(db, to, to),
    db.batch([
      db.prepare(`SELECT a.id, f.name AS fund_name, a.name, a.bank_name, a.account_no, a.is_cash, a.is_active
                  FROM accounts a JOIN funds f ON f.id = a.fund_id ORDER BY f.sort_order, a.sort_order, a.id`),
      db.prepare('SELECT kind, name, is_active, allow_deduction FROM budget_subjects ORDER BY kind DESC, sort_order, id'),
      db.prepare('SELECT title FROM approval_steps ORDER BY seq'),
      db.prepare('SELECT title FROM daily_approval_steps ORDER BY seq'),
    ]),
    db.prepare('SELECT * FROM journals ORDER BY journal_date').all(),
    db.prepare('SELECT journal_date, mass_time, name, kind, attendance, confessions FROM journal_masses ORDER BY journal_date, seq').all(),
    db.prepare('SELECT journal_date, direction, doc_no, party, title FROM journal_documents ORDER BY journal_date, seq').all(),
    db.prepare(
      `SELECT p.payer, t.tx_date, s.name AS subject_name, t.amount
       FROM tx_payers p JOIN transactions t ON t.id = p.tx_id JOIN accounts a ON a.id = t.account_id
       JOIN funds f ON f.id = a.fund_id LEFT JOIN budget_subjects s ON s.id = t.subject_id
       WHERE t.status = 'POSTED' AND t.kind = 'NORMAL' AND t.direction = 'IN' AND f.code = 'SPECIAL'
       ORDER BY substr(t.tx_date, 1, 4), p.payer, t.tx_date, t.id`
    ).all(),
    db.prepare('SELECT * FROM equipment ORDER BY purchase_date, id').all(),
  ]);

  const monthly = [];
  for (const m of months) {
    const p = await computePeriod(db, `${m}-01`, monthEnd(m) > to ? to : monthEnd(m));
    monthly.push({ month: m, funds: p.funds, total: p.total });
  }
  const bySubject = [];
  for (const y of years) {
    const rows = {};
    for (const kind of ['INCOME', 'EXPENSE']) {
      rows[kind] = {};
      for (const m of months.filter((x) => x.startsWith(y))) {
        for (const r of await subjectTotals(db, `${m}-01`, monthEnd(m), kind)) {
          rows[kind][r.name] ??= {};
          rows[kind][r.name][Number(m.slice(5, 7))] = r.total;
        }
      }
    }
    bySubject.push({ year: y, income: rows.INCOME, expense: rows.EXPENSE });
  }

  const [accountRows, subjects, mainSteps, dailySteps] = settingsRows;
  const balance = new Map(accountsNow.accounts.map((a) => [a.id, a.end]));
  return json({
    parishName: parish.parish_name,
    writerName: parish.writer_name,
    from,
    to,
    // 입력자: 내 로그인 메일은 작성자 이름으로 (화면의 거래 조회와 같게)
    transactions: tx.rows.map((t) => (parish.writer_name && t.createdBy === actor.email ? { ...t, createdBy: parish.writer_name } : t)),
    monthly,
    bySubject,
    accounts: accountRows.results.map((a) => ({
      fund: a.fund_name, name: a.name, bank: a.bank_name, accountNo: a.account_no,
      isCash: a.is_cash === 1, isActive: a.is_active === 1, balance: balance.get(a.id) ?? 0,
    })),
    subjects: subjects.results.map((s) => ({ kind: s.kind, name: s.name, isActive: s.is_active === 1, allowDeduction: s.allow_deduction === 1 })),
    approval: { main: mainSteps.results.map((r) => r.title), daily: dailySteps.results.map((r) => r.title) },
    journals: journals.results,
    masses: masses.results,
    documents: documents.results,
    donors: donors.results,
    equipment: equipment.results,
  });
}

/**
 * GET /api/export/journals?month=YYYY-MM : 그달 날짜별 사목일지 (1쪽 사목일지 + 2쪽 회계, 사진 포함)
 * 화면이 이것으로 "사목일지 YYYY-MM.xlsx" (하루에 시트 한 장)를 만든다. 사목일지를 저장했거나 거래가 있는 날만.
 */
export async function journals({ env, url }) {
  const db = env.DB;
  const month = url.searchParams.get('month') ?? '';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad('월 형식이 올바르지 않습니다.', 'BAD_DATE');
  const dates = await db.prepare(
    `SELECT journal_date AS d FROM journals WHERE substr(journal_date, 1, 7) = ?1
     UNION SELECT tx_date FROM transactions WHERE status = 'POSTED' AND substr(tx_date, 1, 7) = ?1
     ORDER BY d`
  ).bind(month).all();
  const parish = await db.prepare('SELECT parish_name FROM parish_settings WHERE id = 1').first();
  const days = [];
  for (const { d } of dates.results) days.push({ date: d, journal: await journalData(db, d), daily: await dailyData(db, d) });
  return json({ parishName: parish.parish_name, month, days });
}
