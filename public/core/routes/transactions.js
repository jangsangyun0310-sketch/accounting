// 거래 입력·이체·삭제·수정·조회 API
// 삭제는 흔적 없이 지운다(내부 기록만 남김). 수정 = 삭제 후 새로 입력. 마감된 날짜는 DB 트리거가 막는다.
import { ApiError, json, readJson } from '../lib/http.js';
import { auditRowStatement, auditStatement, readRowJson } from '../lib/db.js';
import { computeDay, searchTransactions } from '../lib/ledger.js';
import { amount, bad, date, id as parseId, oneOf, text } from '../lib/validate.js';
import { isValidDate, todayKST } from '../../js/shared/dates.js';

// ---------------------------------------------------------------- 입력 검증

function commonFields(body) {
  return {
    date: date(body?.date, '거래일'),
    amount: amount(body?.amount, '금액'),
    memo: text(body?.memo, '적요', { max: 100, required: false }),
    voucherNo: text(body?.voucherNo, '증빙번호', { max: 30, required: false }),
  };
}

function normalInput(body) {
  return {
    ...commonFields(body),
    direction: oneOf(body?.direction, ['IN', 'OUT'], '수입/지출 구분'),
    accountId: parseId(body?.accountId, '통장'),
    subjectId: parseId(body?.subjectId, '예산과목'),
  };
}

function transferInput(body) {
  const input = {
    ...commonFields(body),
    fromAccountId: parseId(body?.fromAccountId, '출금 통장'),
    toAccountId: parseId(body?.toAccountId, '입금 통장'),
  };
  if (input.fromAccountId === input.toAccountId) throw bad('보내는 곳과 받는 곳이 같은 통장입니다.');
  return input;
}


// ---------------------------------------------------------------- SQL 문 생성

// id 를 주면 그 번호로 넣는다 (수정할 때 원래 번호·순서를 유지)
function insertNormal(db, t, actor, now, id = null) {
  return db.prepare(
    `INSERT INTO transactions (id, tx_date, kind, direction, account_id, subject_id, amount, memo, voucher_no,
                               created_at, created_by)
     VALUES (?, ?, 'NORMAL', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(id, t.date, t.direction, t.accountId, t.subjectId, t.amount, t.memo, t.voucherNo, now, actor);
}

function insertTransferHalf(db, t, direction, accountId, group, actor, now, id = null) {
  return db.prepare(
    `INSERT INTO transactions (id, tx_date, kind, direction, account_id, transfer_group, amount, memo, voucher_no,
                               created_at, created_by)
     VALUES (?, ?, 'TRANSFER', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(id, t.date, direction, accountId, group, t.amount, t.memo, t.voucherNo, now, actor);
}

const createAudit = (db, actor) => auditRowStatement(db, { actor, action: 'CREATE', table: 'transactions', id: 'last' });

/** 이체 한 쌍 입력 문 (출금 → 입금 순), 각각 내부 기록 포함 */
function transferStatements(db, t, actor, now, ids = [null, null]) {
  const group = crypto.randomUUID();
  return [
    insertTransferHalf(db, t, 'OUT', t.fromAccountId, group, actor, now, ids[0]), createAudit(db, actor),
    insertTransferHalf(db, t, 'IN', t.toAccountId, group, actor, now, ids[1]), createAudit(db, actor),
  ];
}

/** 대상 거래(이체면 한 쌍)를 읽는다 */
async function loadTarget(db, id) {
  const row = await db.prepare('SELECT id, kind, transfer_group FROM transactions WHERE id = ?').bind(id).first();
  if (!row) throw new ApiError(404, 'NOT_FOUND', '거래를 찾을 수 없습니다. 화면을 새로고침하세요.');
  if (row.kind !== 'TRANSFER') return { kind: 'NORMAL', ids: [row.id] };
  const { results } = await db.prepare(
    "SELECT id FROM transactions WHERE transfer_group = ? ORDER BY CASE direction WHEN 'OUT' THEN 0 ELSE 1 END"
  ).bind(row.transfer_group).all();
  return { kind: 'TRANSFER', ids: results.map((r) => r.id) }; // [출금, 입금]
}

/** 삭제 문 + 내부 기록. 이체는 한쪽을 지우면 트리거가 반대쪽도 지운다. */
async function deleteStatements(db, target, actor) {
  const befores = await Promise.all(target.ids.map((id) => readRowJson(db, 'transactions', id)));
  return [
    ...target.ids.map((id, i) => auditStatement(db, {
      actor, entity: 'transactions', entityId: id, action: 'DELETE', before: JSON.parse(befores[i]),
    })),
    db.prepare('DELETE FROM transactions WHERE id = ?').bind(target.ids[0]),
  ];
}

// ---------------------------------------------------------------- 핸들러

/** GET /api/day?date= : 하루 현황(회계별·통장별 집계 + 거래 목록) */
export async function getDay({ env, url }) {
  const d = url.searchParams.get('date') || todayKST();
  if (!isValidDate(d)) throw bad('날짜 형식이 올바르지 않습니다.', 'BAD_DATE');
  return json(await computeDay(env.DB, d));
}

/** GET /api/transactions?from=&to=&accountId=&subjectId=&kind=&q= */
export async function search({ env, url }) {
  const p = url.searchParams;
  const f = {
    from: date(p.get('from'), '시작일'),
    to: date(p.get('to'), '종료일'),
    accountId: p.get('accountId') ? parseId(p.get('accountId'), '통장') : null,
    subjectId: p.get('subjectId') ? parseId(p.get('subjectId'), '과목') : null,
    kind: p.get('kind') ? oneOf(p.get('kind'), ['IN', 'OUT', 'TRANSFER'], '구분') : null,
    q: text(p.get('q'), '검색어', { max: 50, required: false }),
  };
  if (f.from > f.to) throw bad('시작일이 종료일보다 늦습니다.');
  return json(await searchTransactions(env.DB, f));
}

/** POST /api/transactions : 수입·지출 입력 */
export async function create({ request, env, actor }) {
  const t = normalInput(await readJson(request));
  const db = env.DB;
  const [created] = await db.batch([insertNormal(db, t, actor.email, new Date().toISOString()), createAudit(db, actor.email)]);
  return json({ ok: true, id: created.results[0].id }, 201);
}

/** POST /api/transfers : 통장 간 이체 (출금·입금 한 쌍) */
export async function createTransfer({ request, env, actor }) {
  const t = transferInput(await readJson(request));
  const db = env.DB;
  const [out, , into] = await db.batch(transferStatements(db, t, actor.email, new Date().toISOString()));
  return json({ ok: true, ids: [out.results[0].id, into.results[0].id] }, 201);
}

/** DELETE /api/transactions/:id : 삭제 (이체는 한 쌍 모두). 마감된 날짜는 DB 가 거부 */
export async function remove({ env, actor, params }) {
  const db = env.DB;
  const target = await loadTarget(db, parseId(params.id, '거래 번호'));
  await db.batch(await deleteStatements(db, target, actor.email));
  return json({ ok: true });
}

/** PUT /api/transactions/:id : 수정 = 삭제 후 새로 입력 (한 번에, 전부 성공 또는 전부 실패) */
export async function update({ request, env, actor, params }) {
  const body = await readJson(request);
  const db = env.DB;
  const target = await loadTarget(db, parseId(params.id, '거래 번호'));
  const input = target.kind === 'NORMAL' ? normalInput(body) : transferInput(body);
  const now = new Date().toISOString();
  const statements = await deleteStatements(db, target, actor.email);
  if (target.kind === 'NORMAL') statements.push(insertNormal(db, input, actor.email, now, target.ids[0]), createAudit(db, actor.email));
  else statements.push(...transferStatements(db, input, actor.email, now, target.ids));
  await db.batch(statements);
  return json({ ok: true });
}
