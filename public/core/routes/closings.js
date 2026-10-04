// 일 마감·마감취소
// 마감 시 결재선과 통장별 잔액을 같은 SQL 문 안에서 스냅샷으로 저장한다 (읽기와 저장 사이 틈 없음).
// 순서 규칙(날짜순 마감, 역순 마감취소)은 DB 트리거가 최종적으로 강제한다.
import { ApiError, json, readJson } from '../lib/http.js';
import { BALANCES_SQL } from '../lib/db.js';
import { verifySnapshot } from '../lib/ledger.js';
import { addDays, isValidDate, todayKST } from '../../js/shared/dates.js';
import { bad, date as parseDate, text } from '../lib/validate.js';

// ?1 = 마감일. BALANCES_SQL 도 ?1 을 기준일로 쓴다.
const APPROVAL_SNAPSHOT_SQL = `(SELECT json_group_array(title) FROM (SELECT title FROM approval_steps ORDER BY seq))`;
const BALANCE_SNAPSHOT_SQL = `(SELECT json_group_array(json_object(
    'id', id, 'name', name, 'fundCode', fund_code, 'balance', balance)) FROM (${BALANCES_SQL}))`;

async function closingState(db) {
  const row = await db.prepare(
    `SELECT (SELECT start_date FROM parish_settings WHERE id = 1) AS start_date,
            (SELECT MAX(close_date) FROM daily_closings WHERE status = 'CLOSED') AS last_closed`
  ).first();
  const lastClosed = row.last_closed;
  // 아직 잠기지 않은 거래가 있는 가장 이른 날짜: 이 날짜를 넘어서 마감할 수 없다
  const nextRequired = await db.prepare(
    `SELECT MIN(tx_date) AS d FROM transactions WHERE tx_date > ?`
  ).bind(lastClosed ?? '0000-00-00').first('d');
  const today = todayKST();
  const closableUntil = nextRequired && nextRequired < today ? nextRequired : today;
  return { startDate: row.start_date, lastClosed, nextRequired, today, closableUntil };
}

/** GET /api/closings?month=YYYY-MM : 달력용 날짜별 상태 */
export async function list({ env, url }) {
  const month = url.searchParams.get('month') || todayKST().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month) || !isValidDate(`${month}-01`)) throw bad('월 형식이 올바르지 않습니다.');
  const first = `${month}-01`;
  const last = addDays(addDays(first, 32).slice(0, 8) + '01', -1);
  const db = env.DB;
  const [state, txs, closings] = await Promise.all([
    closingState(db),
    db.prepare(
      `SELECT tx_date, SUM(status = 'POSTED') AS posted, SUM(status = 'VOIDED') AS voided
       FROM transactions WHERE tx_date BETWEEN ? AND ? GROUP BY tx_date`
    ).bind(first, last).all(),
    db.prepare(
      `SELECT close_date, status, closed_at, closed_by, reopened_at, reopened_by, reopen_reason
       FROM daily_closings WHERE close_date BETWEEN ? AND ?`
    ).bind(first, last).all(),
  ]);
  const txByDate = new Map(txs.results.map((r) => [r.tx_date, r]));
  const closeByDate = new Map(closings.results.map((r) => [r.close_date, r]));

  const days = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const t = txByDate.get(d);
    const c = closeByDate.get(d);
    let status;
    if (state.startDate && d < state.startDate) status = 'before-start';
    else if (c?.status === 'CLOSED') status = 'closed';
    else if (state.lastClosed && d <= state.lastClosed) status = 'locked'; // 뒤 날짜 마감으로 함께 잠김
    else if (d > state.today) status = 'future';
    else status = c?.status === 'REOPENED' ? 'reopened' : 'open';
    days.push({
      date: d,
      status,
      posted: t?.posted ?? 0,
      voided: t?.voided ?? 0,
      closedAt: c?.closed_at ?? null,
      closedBy: c?.closed_by ?? null,
      canClose: !['closed', 'locked', 'before-start', 'future'].includes(status) && d <= state.closableUntil,
      canReopen: status === 'closed' && d === state.lastClosed,
    });
  }
  return json({ month, ...state, days });
}

/** GET /api/closings/:date : 마감 정보, 이력, 스냅샷 검증 */
export async function detail({ env, params }) {
  const d = parseDate(params.date, '마감일');
  const db = env.DB;
  const [closing, events, state] = await Promise.all([
    db.prepare(
      `SELECT close_date, status, approval_snapshot, balance_snapshot, writer_name, closed_at, closed_by,
              reopened_at, reopened_by, reopen_reason FROM daily_closings WHERE close_date = ?`
    ).bind(d).first(),
    db.prepare('SELECT id, action, reason, at, actor FROM closing_events WHERE close_date = ? ORDER BY id').bind(d).all(),
    closingState(db),
  ]);
  const verification = closing?.status === 'CLOSED' ? await verifySnapshot(db, d, closing.balance_snapshot) : null;
  return json({
    date: d,
    closing: closing && {
      status: closing.status,
      approvalSteps: JSON.parse(closing.approval_snapshot),
      balances: JSON.parse(closing.balance_snapshot),
      writerName: closing.writer_name,
      closedAt: closing.closed_at,
      closedBy: closing.closed_by,
      reopenedAt: closing.reopened_at,
      reopenedBy: closing.reopened_by,
      reopenReason: closing.reopen_reason,
    },
    events: events.results,
    verification,
    canClose: !(closing?.status === 'CLOSED') && !(state.lastClosed && d <= state.lastClosed)
      && d >= state.startDate && d <= state.closableUntil,
    canReopen: closing?.status === 'CLOSED' && d === state.lastClosed,
    ...state,
  });
}

/** GET /api/closing-events?limit= : 최근 마감·마감취소 기록 */
export async function events({ env, url }) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
  const { results } = await env.DB.prepare(
    'SELECT id, close_date, action, reason, at, actor FROM closing_events ORDER BY id DESC LIMIT ?'
  ).bind(limit).all();
  return json({ events: results });
}

/** POST /api/closings/:date/close {writerName?} */
export async function close({ request, env, actor, params }) {
  const d = parseDate(params.date, '마감일');
  const body = await readJson(request);
  const writerName = body?.writerName == null ? null : text(body.writerName, '작성자', { max: 20, required: false });
  const db = env.DB;
  const state = await closingState(db);

  if (d > state.today) throw bad('미래 날짜는 마감할 수 없습니다.', 'FUTURE_DATE');
  const existing = await db.prepare('SELECT status FROM daily_closings WHERE close_date = ?').bind(d).first('status');
  if (existing === 'CLOSED') throw new ApiError(409, 'ALREADY_CLOSED', '이미 마감된 날짜입니다.');

  const now = new Date().toISOString();
  const writerSql = `COALESCE(?2, (SELECT writer_name FROM parish_settings WHERE id = 1), '')`;
  const upsert = existing
    ? db.prepare(
      `UPDATE daily_closings
          SET status = 'CLOSED', approval_snapshot = ${APPROVAL_SNAPSHOT_SQL},
              balance_snapshot = ${BALANCE_SNAPSHOT_SQL}, writer_name = ${writerSql},
              closed_at = ?3, closed_by = ?4
        WHERE close_date = ?1`
    )
    : db.prepare(
      `INSERT INTO daily_closings (close_date, status, approval_snapshot, balance_snapshot, writer_name, closed_at, closed_by)
       VALUES (?1, 'CLOSED', ${APPROVAL_SNAPSHOT_SQL}, ${BALANCE_SNAPSHOT_SQL}, ${writerSql}, ?3, ?4)`
    );
  await db.batch([
    upsert.bind(d, writerName, now, actor.email),
    db.prepare(`INSERT INTO closing_events (close_date, action, reason, at, actor) VALUES (?, 'CLOSE', '', ?, ?)`)
      .bind(d, now, actor.email),
  ]);
  return json({ ok: true });
}

/** POST /api/closings/:date/reopen {reason?} : 메모는 선택. 비우면 내부 기록에는 '메모 없음'으로 남긴다. */
export async function reopen({ request, env, actor, params }) {
  const d = parseDate(params.date, '마감일');
  const reason = text((await readJson(request))?.reason, '메모', { max: 200, required: false }) || '메모 없음';
  const db = env.DB;
  const existing = await db.prepare('SELECT status FROM daily_closings WHERE close_date = ?').bind(d).first('status');
  if (existing !== 'CLOSED') throw new ApiError(409, 'NOT_CLOSED', '마감되지 않은 날짜입니다.');
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      `UPDATE daily_closings SET status = 'REOPENED', reopened_at = ?, reopened_by = ?, reopen_reason = ?
       WHERE close_date = ?`
    ).bind(now, actor.email, reason, d),
    db.prepare(`INSERT INTO closing_events (close_date, action, reason, at, actor) VALUES (?, 'REOPEN', ?, ?, ?)`)
      .bind(d, reason, now, actor.email),
  ]);
  return json({ ok: true });
}
