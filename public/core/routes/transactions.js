// 거래 입력·이체·삭제·수정·조회 API
// 삭제는 흔적 없이 지운다(내부 기록만 남김). 수정 = 삭제 후 새로 입력. 마감된 날짜는 DB 트리거가 막는다.
import { ApiError, json, readJson } from '../lib/http.js';
import { auditRowStatement, auditStatement, readRowJson } from '../lib/db.js';
import { computeDay, searchTransactions } from '../lib/ledger.js';
import { amount, bad, date, id as parseId, oneOf, text } from '../lib/validate.js';
import { isValidDate, todayKST } from '../../js/shared/dates.js';
import { linkedInput, linkedInsertStatements, txDeletedStatement, txUpdatedStatements } from './equipment.js';

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
    payer: text(body?.payer, '봉헌자', { max: 30, required: false }),
    direction: oneOf(body?.direction, ['IN', 'OUT'], '수입/지출 구분'),
    accountId: parseId(body?.accountId, '통장'),
    // 과목은 화면에서 고르지 않는다 (통장이 과목 역할). 없으면 checkNormal 이 기본 과목을 채운다
    subjectId: body?.subjectId ? parseId(body.subjectId, '예산과목') : null,
    // 비품대장에도 올리기 (비품 과목 지출일 때만 들어간다)
    equipment: body?.equipment ? linkedInput(body.equipment) : null,
  };
}

const DEFAULT_SUBJECT = { INCOME: '특별회계 수입', EXPENSE: '특별회계 지출' };

/**
 * 수입·지출 저장 전 확인: 과목이 없으면 기본 과목(없으면 만든다), 특별회계 수입이면 봉헌자 필수.
 * 연말정산 때 봉헌자 이름으로 내역을 모으기 때문에 비워 둘 수 없다.
 */
async function checkNormal(db, t, actor) {
  const fund = await db.prepare('SELECT f.code FROM accounts a JOIN funds f ON f.id = a.fund_id WHERE a.id = ?').bind(t.accountId).first('code');
  if (fund === 'SPECIAL' && t.direction === 'IN' && !t.payer) throw bad('수입은 봉헌자 이름을 적어야 합니다.', 'PAYER_REQUIRED');
  if (t.subjectId) return t;
  const kind = t.direction === 'IN' ? 'INCOME' : 'EXPENSE';
  const pick = () => db.prepare(
    'SELECT id FROM budget_subjects WHERE kind = ? AND name = ? AND parent_id IS NULL'
  ).bind(kind, DEFAULT_SUBJECT[kind]).first('id');
  let subjectId = await pick();
  if (!subjectId) {
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO budget_subjects (kind, name, sort_order, created_at, created_by, updated_at, updated_by)
       VALUES (?1, ?2, 0, ?3, ?4, ?3, ?4) ON CONFLICT DO NOTHING`
    ).bind(kind, DEFAULT_SUBJECT[kind], now, actor).run();
    subjectId = await pick();
  }
  return { ...t, subjectId };
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

/**
 * 납부자: 특별회계 통장의 수입일 때만 넣는다 (그 밖이면 이름을 적어 보내도 넣지 않음).
 * id 가 없으면 바로 앞에서 넣은 거래 (last_insert_rowid). tx_payers 의 tx_id 가 rowid 라 다음 내부 기록의 'last' 도 같은 거래 번호다.
 */
function insertPayer(db, payer, actor, now, id = null) {
  return db.prepare(
    `INSERT INTO tx_payers (tx_id, payer, updated_at, updated_by)
     SELECT t.id, ?, ?, ? FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN funds f ON f.id = a.fund_id
     WHERE t.id = COALESCE(?, last_insert_rowid()) AND t.kind = 'NORMAL' AND t.direction = 'IN' AND f.code = 'SPECIAL'`
  ).bind(payer, now, actor, id);
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
  const db = env.DB;
  const t = await checkNormal(db, normalInput(await readJson(request)), actor.email);
  const now = new Date().toISOString();
  const [created] = await db.batch([
    insertNormal(db, t, actor.email, now),
    ...(t.payer ? [insertPayer(db, t.payer, actor.email, now)] : []),
    createAudit(db, actor.email),
    ...(t.equipment ? linkedInsertStatements(db, t.equipment, '(SELECT MAX(id) FROM transactions)', [], actor.email, now) : []),
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

/** DELETE /api/transactions/:id : 삭제 (이체는 한 쌍 모두). 마감된 날짜는 DB 가 거부 */
export async function remove({ env, actor, params }) {
  const db = env.DB;
  const target = await loadTarget(db, parseId(params.id, '거래 번호'));
  const now = new Date().toISOString();
  await db.batch([
    ...await deleteStatements(db, target, actor.email),
    ...target.ids.map((id) => txDeletedStatement(db, id, actor.email, now)), // 이어진 비품은 두 줄로
  ]);
  return json({ ok: true });
}

/** PUT /api/transactions/:id : 수정 = 삭제 후 새로 입력 (한 번에, 전부 성공 또는 전부 실패) */
export async function update({ request, env, actor, params }) {
  const body = await readJson(request);
  const db = env.DB;
  const target = await loadTarget(db, parseId(params.id, '거래 번호'));
  const input = target.kind === 'NORMAL' ? await checkNormal(db, normalInput(body), actor.email) : transferInput(body);
  const now = new Date().toISOString();
  const statements = await deleteStatements(db, target, actor.email);
  if (target.kind === 'NORMAL') {
    statements.push(insertNormal(db, input, actor.email, now, target.ids[0]));
    if (input.payer) statements.push(insertPayer(db, input.payer, actor.email, now, target.ids[0]));
    statements.push(createAudit(db, actor.email));
    // 이어진 비품: 날짜 · 금액이 바뀌면 따라가고, 아직 없는데 올리기를 골랐으면 새로 올린다
    const id = target.ids[0];
    statements.push(...await txUpdatedStatements(db, id, input, actor.email, now));
    const linked = await db.prepare('SELECT 1 FROM equipment WHERE tx_id = ? AND deleted_at IS NULL AND disposed_at IS NULL').bind(id).first();
    if (input.equipment && !linked) statements.push(...linkedInsertStatements(db, input.equipment, '?', [id], actor.email, now));
  }
  else statements.push(...transferStatements(db, input, actor.email, now, target.ids));
  await db.batch(statements);
  return json({ ok: true });
}

/**
 * PUT /api/transactions/:id/payer {payer} : 납부자 이름만 고치기. 마감한 날도 된다 (금액·통장·날짜는 그대로).
 * 비우면 지운다. 특별회계 수입이 아니면 거부.
 */
export async function setPayer({ request, env, actor, params }) {
  const db = env.DB;
  const id = parseId(params.id, '거래 번호');
  const payer = text((await readJson(request))?.payer, '봉헌자', { max: 30 });
  const row = await db.prepare(
    `SELECT t.kind, t.direction, f.code AS fund_code FROM transactions t
     JOIN accounts a ON a.id = t.account_id JOIN funds f ON f.id = a.fund_id WHERE t.id = ? AND t.status = 'POSTED'`
  ).bind(id).first();
  if (!row) throw new ApiError(404, 'NOT_FOUND', '거래를 찾을 수 없습니다. 화면을 새로고침하세요.');
  if (row.kind !== 'NORMAL' || row.direction !== 'IN' || row.fund_code !== 'SPECIAL') {
    throw bad('봉헌자는 특별회계 수입에만 적을 수 있습니다.', 'PAYER_NOT_ALLOWED');
  }
  const before = await db.prepare('SELECT payer FROM tx_payers WHERE tx_id = ?').bind(id).first('payer');
  const now = new Date().toISOString();
  await db.batch([
    payer
      ? db.prepare(
        `INSERT INTO tx_payers (tx_id, payer, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (tx_id) DO UPDATE SET payer = excluded.payer, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      ).bind(id, payer, now, actor.email)
      : db.prepare('DELETE FROM tx_payers WHERE tx_id = ?').bind(id),
    auditStatement(db, { actor: actor.email, entity: 'tx_payers', entityId: id, action: 'UPDATE', before: { payer: before ?? '' }, after: { payer } }),
  ]);
  return json({ ok: true });
}

/** GET /api/memos?accountId= : 그 통장에서 지금까지 적은 내용 (많이 쓴 순, 내용 칸 자동 완성용 — 월말결산서 내역이 같은 글자로 모이게) */
export async function memos({ env, url }) {
  const accountId = parseId(url.searchParams.get('accountId'), '통장');
  const { results } = await env.DB.prepare(
    `SELECT memo FROM transactions WHERE account_id = ? AND status = 'POSTED' AND kind = 'NORMAL' AND memo <> ''
     GROUP BY memo ORDER BY COUNT(*) DESC, MAX(id) DESC LIMIT 500`
  ).bind(accountId).all();
  return json({ memos: results.map((r) => r.memo) });
}

/** GET /api/payers : 지금까지 적은 납부자 이름 (최근에 쓴 순, 입력 칸 자동 완성용) */
export async function payers({ env }) {
  const { results } = await env.DB.prepare(
    'SELECT payer FROM tx_payers GROUP BY payer ORDER BY MAX(tx_id) DESC LIMIT 2000'
  ).all();
  return json({ payers: results.map((r) => r.payer) });
}
