// 거래 입력·이체·취소·수정·조회 API
// 거래 행은 바꾸지 않는다: 취소 = 상태만 VOIDED, 수정 = 원본 취소 + 새 거래(replaces_id)
import { ApiError, json, readJson } from '../lib/http.js';
import { auditRowStatement, readRowJson } from '../lib/db.js';
import { computeDay, searchTransactions, transactionHistory } from '../lib/ledger.js';
import { amount, bad, date, id as parseId, oneOf, text } from '../lib/validate.js';
import { isValidDate, todayKST } from '../../public/js/shared/dates.js';

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

const reasonInput = (body) => text(body?.reason, '사유', { max: 200 });

// ---------------------------------------------------------------- SQL 문 생성

function insertNormal(db, t, actor, now, replacesId = null) {
  return db.prepare(
    `INSERT INTO transactions (tx_date, kind, direction, account_id, subject_id, amount, memo, voucher_no,
                               replaces_id, created_at, created_by)
     VALUES (?, 'NORMAL', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(t.date, t.direction, t.accountId, t.subjectId, t.amount, t.memo, t.voucherNo, replacesId, now, actor);
}

function insertTransferHalf(db, t, direction, accountId, group, actor, now, replacesId = null) {
  return db.prepare(
    `INSERT INTO transactions (tx_date, kind, direction, account_id, transfer_group, amount, memo, voucher_no,
                               replaces_id, created_at, created_by)
     VALUES (?, 'TRANSFER', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(t.date, direction, accountId, group, t.amount, t.memo, t.voucherNo, replacesId, now, actor);
}

/** 이체 한 쌍 입력 문 (출금 → 입금 순), 각각 감사 로그 포함 */
function transferStatements(db, t, actor, now, replaces = { out: null, in: null }) {
  const group = crypto.randomUUID();
  const audit = () => auditRowStatement(db, { actor, action: 'CREATE', table: 'transactions', id: 'last' });
  return [
    insertTransferHalf(db, t, 'OUT', t.fromAccountId, group, actor, now, replaces.out), audit(),
    insertTransferHalf(db, t, 'IN', t.toAccountId, group, actor, now, replaces.in), audit(),
  ];
}

function voidStatement(db, id, reason, actor, now) {
  return db.prepare(
    `UPDATE transactions SET status = 'VOIDED', void_reason = ?, voided_at = ?, voided_by = ?
     WHERE id = ? AND status = 'POSTED'`
  ).bind(reason, now, actor, id);
}

/** 원본 거래(이체면 한 쌍)를 읽어 취소 가능 여부 확인 */
async function loadForChange(db, id) {
  const row = await db.prepare('SELECT id, kind, direction, transfer_group, status FROM transactions WHERE id = ?')
    .bind(id).first();
  if (!row) throw new ApiError(404, 'NOT_FOUND', '거래를 찾을 수 없습니다.');
  if (row.status !== 'POSTED') throw new ApiError(409, 'ALREADY_VOIDED', '이미 취소된 거래입니다. 화면을 새로고침하세요.');
  if (row.kind !== 'TRANSFER') return { kind: 'NORMAL', rows: [row] };
  const { results } = await db.prepare('SELECT id, direction FROM transactions WHERE transfer_group = ? ORDER BY id')
    .bind(row.transfer_group).all();
  return {
    kind: 'TRANSFER',
    rows: results,
    out: results.find((r) => r.direction === 'OUT'),
    in: results.find((r) => r.direction === 'IN'),
  };
}

/** 취소 문 + 취소된 모든 행(이체면 2행)의 감사 로그 */
async function voidStatements(db, target, reason, actor, now) {
  const befores = await Promise.all(target.rows.map((r) => readRowJson(db, 'transactions', r.id)));
  return [
    voidStatement(db, target.rows[0].id, reason, actor, now), // 이체는 트리거가 반대쪽도 취소
    ...target.rows.map((r, i) => auditRowStatement(db, {
      actor, action: 'VOID', table: 'transactions', id: r.id, beforeJson: befores[i],
    })),
  ];
}

// ---------------------------------------------------------------- 핸들러

/** GET /api/day?date= : 하루 현황(회계별·통장별 집계 + 거래 목록) */
export async function getDay({ env, url }) {
  const d = url.searchParams.get('date') || todayKST();
  if (!isValidDate(d)) throw bad('날짜 형식이 올바르지 않습니다.', 'BAD_DATE');
  return json(await computeDay(env.DB, d));
}

/** GET /api/transactions?from=&to=&accountId=&subjectId=&kind=&q=&includeVoided=1 */
export async function search({ env, url }) {
  const p = url.searchParams;
  const f = {
    from: date(p.get('from'), '시작일'),
    to: date(p.get('to'), '종료일'),
    accountId: p.get('accountId') ? parseId(p.get('accountId'), '통장') : null,
    subjectId: p.get('subjectId') ? parseId(p.get('subjectId'), '과목') : null,
    kind: p.get('kind') ? oneOf(p.get('kind'), ['IN', 'OUT', 'TRANSFER'], '구분') : null,
    q: text(p.get('q'), '검색어', { max: 50, required: false }),
    includeVoided: p.get('includeVoided') === '1',
  };
  if (f.from > f.to) throw bad('시작일이 종료일보다 늦습니다.');
  return json(await searchTransactions(env.DB, f));
}

/** GET /api/transactions/:id : 수정 이력과 감사 로그 */
export async function detail({ env, params }) {
  return json(await transactionHistory(env.DB, parseId(params.id, '거래 번호')));
}

/** POST /api/transactions : 수입·지출 입력 */
export async function create({ request, env, actor }) {
  const t = normalInput(await readJson(request));
  const db = env.DB;
  const [created] = await db.batch([
    insertNormal(db, t, actor.email, new Date().toISOString()),
    auditRowStatement(db, { actor: actor.email, action: 'CREATE', table: 'transactions', id: 'last' }),
  ]);
  return json({ ok: true, id: created.results[0].id }, 201);
}

/** POST /api/transfers : 통장 간 이체 (출금·입금 한 쌍) */
export async function createTransfer({ request, env, actor }) {
  const t = transferInput(await readJson(request));
  const db = env.DB;
  const [out, , into] = await db.batch(transferStatements(db, t, actor.email, new Date().toISOString()));
  return json({ ok: true, ids: [out.results[0].id, into.results[0].id] }, 201);
}

/** POST /api/transactions/:id/void {reason} : 거래 취소 (이체는 한 쌍 모두) */
export async function voidTx({ request, env, actor, params }) {
  const id = parseId(params.id, '거래 번호');
  const reason = reasonInput(await readJson(request));
  const db = env.DB;
  const target = await loadForChange(db, id);
  await db.batch(await voidStatements(db, target, reason, actor.email, new Date().toISOString()));
  return json({ ok: true });
}

/** POST /api/transactions/:id/replace {reason, ...새 내용} : 수정 = 원본 취소 + 새 거래 */
export async function replace({ request, env, actor, params }) {
  const id = parseId(params.id, '거래 번호');
  const body = await readJson(request);
  const reason = reasonInput(body);
  const db = env.DB;
  const target = await loadForChange(db, id);
  const now = new Date().toISOString();
  const by = actor.email;
  const statements = await voidStatements(db, target, `수정: ${reason}`, by, now);

  if (target.kind === 'NORMAL') {
    statements.push(
      insertNormal(db, normalInput(body), by, now, id),
      auditRowStatement(db, { actor: by, action: 'CREATE', table: 'transactions', id: 'last' }),
    );
  } else {
    statements.push(...transferStatements(db, transferInput(body), by, now, { out: target.out.id, in: target.in.id }));
  }
  await db.batch(statements);
  return json({ ok: true });
}
