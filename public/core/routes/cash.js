// 금고 현금 확인: 그날 금고에서 센 금액을 적어 두고 장부 잔액과 비교한다.
// 장부 계산과는 상관없는 참고 기록이라 마감 여부와 관계없이 언제든 고칠 수 있다.
// (이 기능을 빼려면 이 파일·cash_counts 표·화면의 금고 확인 칸만 지우면 된다)
//   GET /api/cash-counts?date=YYYY-MM-DD : 현금마다 장부 잔액과 센 금액
//   PUT /api/cash-counts {date, counts: [{accountId, counted}]} : counted 가 빈칸·null 이면 지운다
import { json, readJson } from '../lib/http.js';
import { BALANCES_SQL, auditStatement } from '../lib/db.js';
import { amount, array, bad, date as parseDate, id as parseId } from '../lib/validate.js';
import { isValidDate, todayKST } from '../../js/shared/dates.js';

/** 그날 센 금액 {accountId: counted} */
export async function cashCountsOn(db, date) {
  const { results } = await db.prepare('SELECT account_id, counted FROM cash_counts WHERE count_date = ?').bind(date).all();
  return Object.fromEntries(results.map((r) => [r.account_id, r.counted]));
}

export async function get({ env, url }) {
  const db = env.DB;
  const d = url.searchParams.get('date') || todayKST();
  if (!isValidDate(d)) throw bad('날짜 형식이 올바르지 않습니다.', 'BAD_DATE');
  const [balances, cash, counts] = await Promise.all([
    db.prepare(BALANCES_SQL).bind(d).all(),
    db.prepare('SELECT id FROM accounts WHERE is_cash = 1').all(),
    cashCountsOn(db, d),
  ]);
  const cashIds = new Set(cash.results.map((r) => r.id));
  const items = balances.results
    .filter((a) => cashIds.has(a.id) && (a.is_active === 1 || a.balance !== 0 || counts[a.id] != null))
    .map((a) => ({ accountId: a.id, name: a.name, fundCode: a.fund_code, balance: a.balance, counted: counts[a.id] ?? null }));
  return json({ date: d, items });
}

export async function save({ request, env, actor }) {
  const db = env.DB;
  const body = await readJson(request);
  const d = parseDate(body?.date, '금고 확인');
  const counts = array(body?.counts ?? [], '금고 확인', { max: 50 }).map((c) => ({
    accountId: parseId(c?.accountId, '현금 번호'),
    counted: c?.counted == null || c.counted === '' ? null : amount(c.counted, '금고에서 센 금액', { allowZero: true }),
  }));
  const { results } = await db.prepare('SELECT id FROM accounts WHERE is_cash = 1').all();
  const cashIds = new Set(results.map((r) => r.id));
  if (counts.some((c) => !cashIds.has(c.accountId))) throw bad('현금으로 등록된 곳만 금고 확인을 할 수 있습니다.');
  const now = new Date().toISOString();
  await db.batch([
    ...counts.map((c) => (c.counted == null
      ? db.prepare('DELETE FROM cash_counts WHERE count_date = ? AND account_id = ?').bind(d, c.accountId)
      : db.prepare(
        `INSERT INTO cash_counts (count_date, account_id, counted, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (count_date, account_id) DO UPDATE SET counted = excluded.counted,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      ).bind(d, c.accountId, c.counted, now, actor.email))),
    auditStatement(db, { actor: actor.email, entity: 'cash_counts', entityId: d, action: 'UPDATE', after: { counts } }),
  ]);
  return json({ ok: true });
}
