// 예산 대비 집행
//   GET /api/budgets?year=YYYY : 과목별 예산·집행(그 해 1월 1일 ~ 기준일)·집행률
//   PUT /api/budgets {year, items:[{subjectId, amount}]} : 그 해 예산을 통째로 바꾼다 (0 이나 빈 칸은 예산 없음)
// 집행액은 확정된 일반 거래(수입·지출)만 더한다. 이체는 돈이 늘거나 줄지 않으므로 넣지 않는다.
import { ApiError, json, readJson } from '../lib/http.js';
import { auditStatement } from '../lib/db.js';
import { array, bad, id as parseId } from '../lib/validate.js';
import { parseAmount, sumAmounts } from '../../js/shared/money.js';
import { todayKST } from '../../js/shared/dates.js';

function parseYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw bad('연도가 올바르지 않습니다.', 'BAD_YEAR');
  return year;
}

/** 집행률(%) 소수 첫째 자리. 예산이 없으면 null */
const rate = (actual, budget) => (budget > 0 ? Math.round((actual / budget) * 1000) / 10 : null);

export async function list({ env, url }) {
  const db = env.DB;
  const year = parseYear(url.searchParams.get('year') || todayKST().slice(0, 4));
  const today = todayKST();
  // 기준일: 올해는 오늘까지, 지난 해는 12월 31일까지 (앞으로 올 해는 아직 집행 없음)
  const through = String(year) === today.slice(0, 4) ? today : `${year}-12-31`;
  const { results } = await db.prepare(
    `SELECT s.id, s.kind, s.name, s.is_active, s.sort_order,
            COALESCE(b.amount, 0) AS budget,
            COALESCE((SELECT SUM(t.amount) FROM transactions t
                       WHERE t.subject_id = s.id AND t.kind = 'NORMAL' AND t.status = 'POSTED'
                         AND t.tx_date BETWEEN ?2 AND ?3), 0) AS actual
       FROM budget_subjects s LEFT JOIN budgets b ON b.subject_id = s.id AND b.year = ?1
      ORDER BY s.kind DESC, s.sort_order, s.id`
  ).bind(year, `${year}-01-01`, through).all();
  // 사용 중지된 과목은 예산이나 집행이 있을 때만 보인다
  const rows = results.filter((r) => r.is_active || r.budget || r.actual).map((r) => ({
    subjectId: r.id, kind: r.kind, name: r.name, isActive: Boolean(r.is_active),
    budget: r.budget, actual: r.actual, remaining: r.budget - r.actual, rate: rate(r.actual, r.budget),
  }));
  const group = (kind) => {
    const items = rows.filter((r) => r.kind === kind);
    const budget = sumAmounts(items.map((r) => r.budget));
    const actual = sumAmounts(items.map((r) => r.actual));
    return { items, budget, actual, remaining: budget - actual, rate: rate(actual, budget) };
  };
  const parish = await db.prepare('SELECT parish_name, writer_name FROM parish_settings WHERE id = 1').first();
  const steps = await db.prepare('SELECT title FROM approval_steps ORDER BY seq').all();
  return json({
    year, through, today,
    parishName: parish?.parish_name ?? '', writerName: parish?.writer_name ?? '',
    approvalSteps: steps.results.map((s) => s.title),
    income: group('INCOME'), expense: group('EXPENSE'),
  });
}

export async function save({ request, env, actor }) {
  const db = env.DB;
  const body = await readJson(request);
  const year = parseYear(body?.year);
  const items = array(body?.items, '예산', { max: 500 }).map((it) => ({
    subjectId: parseId(it?.subjectId, '과목'),
    amount: it?.amount === '' || it?.amount == null ? 0 : parseAmount(it.amount, { allowZero: true }),
  }));
  const ids = new Set(items.map((i) => i.subjectId));
  if (ids.size !== items.length) throw bad('같은 과목이 두 번 있습니다.', 'DUPLICATE');
  const { results: subjects } = await db.prepare('SELECT id FROM budget_subjects').all();
  const known = new Set(subjects.map((s) => s.id));
  if ([...ids].some((i) => !known.has(i))) throw new ApiError(409, 'STALE', '과목 목록이 바뀌었습니다. 화면을 새로고침한 뒤 다시 입력하세요.');

  const { results: before } = await db.prepare('SELECT subject_id, amount FROM budgets WHERE year = ? ORDER BY subject_id').bind(year).all();
  const now = new Date().toISOString();
  const kept = items.filter((i) => i.amount > 0);
  await db.batch([
    db.prepare('DELETE FROM budgets WHERE year = ?').bind(year),
    ...kept.map((i) => db.prepare(
      'INSERT INTO budgets (year, subject_id, amount, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)',
    ).bind(year, i.subjectId, i.amount, now, actor.email)),
    auditStatement(db, {
      actor: actor.email, entity: 'budgets', entityId: year, action: 'UPDATE',
      before, after: kept.map((i) => ({ subject_id: i.subjectId, amount: i.amount })),
    }),
  ]);
  return json({ ok: true, count: kept.length });
}
