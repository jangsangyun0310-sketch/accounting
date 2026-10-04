// 시스템 상태·설정 조회·잔액 조회 API (1단계: 조회 전용)
import { ApiError, json } from '../lib/http.js';
import { BALANCES_SQL } from '../lib/db.js';
import { isValidDate, todayKST } from '../../js/shared/dates.js';
import { assertInteger, sumAmounts } from '../../js/shared/money.js';

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
