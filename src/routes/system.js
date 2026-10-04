// 시스템 상태·설정 조회·잔액 조회 API (1단계: 조회 전용)
import { ApiError, json } from '../lib/http.js';
import { BALANCES_SQL } from '../lib/db.js';
import { isValidDate, todayKST } from '../../public/js/shared/dates.js';
import { assertInteger, sumAmounts } from '../../public/js/shared/money.js';

export async function health({ env }) {
  await env.DB.prepare('SELECT 1').first();
  let migration = null;
  try {
    migration = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first('name');
  } catch {
    // 마이그레이션 테이블이 없는 환경(테스트 등)
  }
  return json({ ok: true, migration, today: todayKST() });
}

export async function me({ actor }) {
  return json({ email: actor.email });
}

export async function getSettings({ env }) {
  const db = env.DB;
  const [parish, funds, accounts, subjects, steps] = await db.batch([
    db.prepare('SELECT parish_name, start_date, writer_name, setup_completed FROM parish_settings WHERE id = 1'),
    db.prepare('SELECT id, code, name FROM funds ORDER BY sort_order'),
    db.prepare(`SELECT id, fund_id, name, bank_name, account_no, opening_balance, sort_order, is_active
                FROM accounts ORDER BY fund_id, sort_order, id`),
    db.prepare(`SELECT id, kind, parent_id, code, name, sort_order, is_active
                FROM budget_subjects ORDER BY kind, sort_order, id`),
    db.prepare('SELECT seq, title FROM approval_steps ORDER BY seq'),
  ]);
  const p = parish.results[0] ?? null;
  return json({
    setupCompleted: p ? p.setup_completed === 1 : false,
    parish: p && { parishName: p.parish_name, startDate: p.start_date, writerName: p.writer_name },
    funds: funds.results,
    accounts: accounts.results,
    subjects: subjects.results,
    approvalSteps: steps.results,
  });
}

/** GET /api/balances?date=YYYY-MM-DD : 해당 일자 업무 종료 기준 통장별·회계별 잔액 */
export async function getBalances({ env, url }) {
  const date = url.searchParams.get('date') || todayKST();
  if (!isValidDate(date)) throw new ApiError(400, 'BAD_DATE', '날짜 형식이 올바르지 않습니다.');
  return json(await computeBalances(env.DB, date));
}

export async function computeBalances(db, date) {
  const { results } = await db.prepare(BALANCES_SQL).bind(date).all();
  const accounts = results.map((r) => ({
    id: r.id,
    fundId: r.fund_id,
    fundCode: r.fund_code,
    name: r.name,
    isActive: r.is_active === 1,
    balance: assertInteger(r.balance),
  }));
  const fundCodes = [...new Set(accounts.map((a) => a.fundCode))];
  const funds = fundCodes.map((code) => {
    const list = accounts.filter((a) => a.fundCode === code);
    return {
      code,
      name: results.find((r) => r.fund_code === code).fund_name,
      balance: sumAmounts(list.map((a) => a.balance)),
    };
  });
  return { date, accounts, funds, total: sumAmounts(accounts.map((a) => a.balance)) };
}
