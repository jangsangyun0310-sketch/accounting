// 비품대장: 종이 대장처럼 올린 다음 날부터는 고치지 않는다 (올린 날은 다 고칠 수 있음, 둘 곳 · 비고는 언제든).
// 폐기 = 폐기일자, 삭제 = 두 줄 긋기 (사유는 비워도 됨).
//   GET  /api/equipment                       : 목록 (폐기 · 삭제한 줄 포함, 화면이 거른다)
//   POST /api/equipment {name, spec, quantity, purchaseDate, price, vendor, location, note} : 비품 올리기
//   PUT  /api/equipment/:id {name, spec, quantity, purchaseDate, price, vendor, location, note} : 고치기 (다음 날부터는 둘 곳 · 비고만)
//   POST /api/equipment/:id/dispose {date, reason} : 폐기
//   POST /api/equipment/:id/delete {reason}   : 삭제 (빨간 두 줄로 남김)
//   GET  /api/equipment/:id/photos            : 사진들 (data URL)
//   POST /api/equipment/:id/photos {image}    : 사진 붙이기 (4장까지)
//   DELETE /api/equipment/photos/:photoId     : 사진 떼기
// 거래 입력에서 비품 과목으로 지출하면 transactions.js 가 equipmentStatements 로 함께 올린다.
import { ApiError, json, readJson } from '../lib/http.js';
import { auditRowStatement, auditStatement, readRowJson } from '../lib/db.js';
import { amount, bad, date as parseDate, id as parseId, text } from '../lib/validate.js';
import { count } from './journal.js';
import { todayKST } from '../../js/shared/dates.js';

const MAX_PHOTOS = 4;

/** 올린 날(한국 시간)이면 아직 고칠 수 있다. DB 트리거와 같은 규칙 */
const kstDate = (iso) => new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().slice(0, 10);
const editableToday = (row) => kstDate(row.created_at) === todayKST();
const MAX_IMAGE = 1500000;

/** 관리번호 SQL 식: 구매연도-순번 (그해 몇 번째). dateSql 은 구매일자 식 */
const itemNoSql = (dateSql) => `(SELECT printf('%s-%03d', substr(${dateSql}, 1, 4), COUNT(*) + 1)
  FROM equipment e WHERE substr(e.purchase_date, 1, 4) = substr(${dateSql}, 1, 4))`;

/** 거래와 같이 올릴 때 받는 칸 (구매일자 · 구매금액은 거래에서) */
export function linkedInput(v) {
  return {
    name: text(v?.name, '비품 품명', { max: 50 }),
    spec: text(v?.spec, '규격·모델', { max: 60, required: false }),
    quantity: Math.max(1, count(v?.quantity ?? 1, '수량')),
    vendor: text(v?.vendor, '구매처', { max: 40, required: false }),
    location: text(v?.location, '둘 곳', { max: 40, required: false }),
    note: text(v?.note, '비고', { max: 200, required: false }),
  };
}

/**
 * 거래와 이어진 비품 올리기 문 (+ 내부 기록). txIdSql = 거래 번호 SQL 식.
 * 비품 과목 지출일 때만 들어간다 (아니면 아무것도 넣지 않음).
 */
export function linkedInsertStatements(db, e, txIdSql, txParams, actor, now) {
  return [
    db.prepare(
      `INSERT INTO equipment (item_no, name, spec, quantity, purchase_date, price, vendor, location, note, tx_id,
                              created_at, created_by, updated_at, updated_by)
       SELECT ${itemNoSql('t.tx_date')}, ?, ?, ?, t.tx_date, t.amount, ?, ?, ?, t.id, ?, ?, ?, ?
       FROM transactions t JOIN budget_subjects s ON s.id = t.subject_id
       WHERE t.id = ${txIdSql} AND t.kind = 'NORMAL' AND t.direction = 'OUT' AND s.is_equipment = 1`
    ).bind(e.name, e.spec, e.quantity, e.vendor, e.location, e.note, now, actor, now, actor, ...txParams),
    auditRowStatement(db, { actor, action: 'CREATE', table: 'equipment', id: 'last' }),
  ];
}

/** 거래가 지워질 때: 이어진 비품은 두 줄로 긋고(사유: 거래 삭제) 연결을 끊는다 */
export function txDeletedStatement(db, txId, actor, now) {
  return db.prepare(
    `UPDATE equipment SET
       delete_reason = CASE WHEN deleted_at IS NULL AND disposed_at IS NULL THEN '지출 거래 삭제' ELSE delete_reason END,
       deleted_at = CASE WHEN deleted_at IS NULL AND disposed_at IS NULL THEN ? ELSE deleted_at END,
       tx_id = NULL, updated_at = ?, updated_by = ?
     WHERE tx_id = ?`
  ).bind(todayKST(), now, actor, txId);
}

/**
 * 거래를 고칠 때 (같은 번호로 다시 넣은 뒤): 날짜나 금액이 바뀌었으면
 * 이어진 비품(살아 있는 것)을 두 줄로 긋고 같은 내용 · 새 날짜 · 새 금액으로 다시 올린다.
 */
export async function txUpdatedStatements(db, txId, after, actor, now) {
  const live = await db.prepare(
    'SELECT * FROM equipment WHERE tx_id = ? AND deleted_at IS NULL AND disposed_at IS NULL'
  ).bind(txId).all();
  const out = [];
  for (const e of live.results) {
    if (e.purchase_date === after.date && e.price === after.amount) continue;
    if (editableToday(e)) { // 올린 날이면 그대로 고친다
      out.push(
        db.prepare('UPDATE equipment SET purchase_date = ?, price = ?, updated_at = ?, updated_by = ? WHERE id = ?')
          .bind(after.date, after.amount, now, actor, e.id),
        auditRowStatement(db, { actor, action: 'UPDATE', table: 'equipment', id: e.id }),
      );
      continue;
    }
    out.push(
      db.prepare(`UPDATE equipment SET deleted_at = ?, delete_reason = '지출 거래 수정 (금액·날짜)', updated_at = ?, updated_by = ? WHERE id = ?`)
        .bind(todayKST(), now, actor, e.id),
      auditRowStatement(db, { actor, action: 'DELETE', table: 'equipment', id: e.id }),
      ...linkedInsertStatements(db, e, '?', [txId], actor, now),
    );
  }
  return out;
}

const mapItem = (r) => ({
  id: r.id, itemNo: r.item_no, name: r.name, spec: r.spec, quantity: r.quantity,
  purchaseDate: r.purchase_date, price: r.price, vendor: r.vendor, location: r.location, note: r.note,
  txId: r.tx_id, txExists: r.tx_exists === 1,
  disposedAt: r.disposed_at, disposeReason: r.dispose_reason,
  deletedAt: r.deleted_at, deleteReason: r.delete_reason,
  photoCount: r.photo_count, createdAt: r.created_at, createdBy: r.created_by,
  editable: !r.deleted_at && !r.disposed_at && editableToday(r), // 오늘 올린 것: 모든 칸을 고칠 수 있음
});

export async function list({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT e.*, EXISTS (SELECT 1 FROM transactions t WHERE t.id = e.tx_id) AS tx_exists,
            (SELECT COUNT(*) FROM equipment_photos p WHERE p.equipment_id = e.id) AS photo_count
     FROM equipment e ORDER BY e.purchase_date DESC, e.id DESC`
  ).all();
  return json({ items: results.map(mapItem) });
}

/** 바꿀 수 있는 비품 (폐기 · 삭제 전) */
async function liveItem(db, id) {
  const row = await db.prepare('SELECT * FROM equipment WHERE id = ?').bind(id).first();
  if (!row) throw new ApiError(404, 'NOT_FOUND', '비품을 찾을 수 없습니다. 화면을 새로고침하세요.');
  if (row.deleted_at || row.disposed_at) throw new ApiError(409, 'EQUIPMENT_LOCKED', '폐기하거나 삭제한 비품은 바꿀 수 없습니다.');
  return row;
}

export async function create({ request, env, actor }) {
  const db = env.DB;
  const body = await readJson(request);
  const e = {
    ...linkedInput(body),
    purchaseDate: parseDate(body?.purchaseDate, '구매일자'),
    price: amount(body?.price ?? '', '구매금액', { allowZero: true }),
  };
  const now = new Date().toISOString();
  const [created] = await db.batch([
    db.prepare(
      `INSERT INTO equipment (item_no, name, spec, quantity, purchase_date, price, vendor, location, note,
                              created_at, created_by, updated_at, updated_by)
       VALUES (${itemNoSql('?1')}, ?2, ?3, ?4, ?1, ?5, ?6, ?7, ?8, ?9, ?10, ?9, ?10) RETURNING id, item_no`
    ).bind(e.purchaseDate, e.name, e.spec, e.quantity, e.price, e.vendor, e.location, e.note, now, actor.email),
    auditRowStatement(db, { actor: actor.email, action: 'CREATE', table: 'equipment', id: 'last' }),
  ]);
  return json({ ok: true, id: created.results[0].id, itemNo: created.results[0].item_no }, 201);
}

export async function update({ request, env, actor, params }) {
  const db = env.DB;
  const id = parseId(params.id, '비품 번호');
  const body = await readJson(request);
  const row = await liveItem(db, id);
  const location = text(body?.location, '둘 곳', { max: 40, required: false });
  const note = text(body?.note, '비고', { max: 200, required: false });
  // 올린 날이면 모든 칸, 다음 날부터는 둘 곳 · 비고만 (나머지는 그대로). 거래와 이어진 비품의 날짜 · 금액은 거래를 따른다
  let e = { name: row.name, spec: row.spec, quantity: row.quantity, vendor: row.vendor, purchaseDate: row.purchase_date, price: row.price };
  if (editableToday(row)) {
    const v = linkedInput(body);
    e = { ...e, name: v.name, spec: v.spec, quantity: v.quantity, vendor: v.vendor };
    if (row.tx_id == null) {
      e.purchaseDate = parseDate(body?.purchaseDate, '구매일자');
      e.price = amount(body?.price ?? '', '구매금액', { allowZero: true });
    }
  }
  const before = await readRowJson(db, 'equipment', id);
  await db.batch([
    db.prepare(
      `UPDATE equipment SET name = ?, spec = ?, quantity = ?, vendor = ?, purchase_date = ?, price = ?, location = ?, note = ?,
              updated_at = ?, updated_by = ? WHERE id = ?`
    ).bind(e.name, e.spec, e.quantity, e.vendor, e.purchaseDate, e.price, location, note, new Date().toISOString(), actor.email, id),
    auditRowStatement(db, { actor: actor.email, action: 'UPDATE', table: 'equipment', id, beforeJson: before }),
  ]);
  return json({ ok: true });
}

export async function dispose({ request, env, actor, params }) {
  const db = env.DB;
  const id = parseId(params.id, '비품 번호');
  const body = await readJson(request);
  const d = parseDate(body?.date, '폐기일자');
  const reason = text(body?.reason, '폐기 사유', { max: 100, required: false });
  const row = await liveItem(db, id);
  if (d < row.purchase_date) throw bad('폐기일자가 구매일자보다 빠릅니다.', 'BAD_DATE');
  const before = await readRowJson(db, 'equipment', id);
  await db.batch([
    db.prepare('UPDATE equipment SET disposed_at = ?, dispose_reason = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .bind(d, reason, new Date().toISOString(), actor.email, id),
    auditRowStatement(db, { actor: actor.email, action: 'DISPOSE', table: 'equipment', id, beforeJson: before }),
  ]);
  return json({ ok: true });
}

export async function strike({ request, env, actor, params }) {
  const db = env.DB;
  const id = parseId(params.id, '비품 번호');
  const reason = text((await readJson(request))?.reason, '삭제 사유', { max: 100, required: false });
  await liveItem(db, id);
  const before = await readRowJson(db, 'equipment', id);
  await db.batch([
    db.prepare('UPDATE equipment SET deleted_at = ?, delete_reason = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .bind(todayKST(), reason, new Date().toISOString(), actor.email, id),
    auditRowStatement(db, { actor: actor.email, action: 'DELETE', table: 'equipment', id, beforeJson: before }),
  ]);
  return json({ ok: true });
}

export async function photos({ env, params }) {
  const id = parseId(params.id, '비품 번호');
  const { results } = await env.DB.prepare('SELECT id, image FROM equipment_photos WHERE equipment_id = ? ORDER BY id').bind(id).all();
  return json({ photos: results });
}

export async function addPhoto({ request, env, actor, params }) {
  const db = env.DB;
  const id = parseId(params.id, '비품 번호');
  const image = (await readJson(request))?.image;
  if (typeof image !== 'string' || !image.startsWith('data:image/jpeg;base64,')) throw bad('사진 형식이 올바르지 않습니다.', 'BAD_IMAGE');
  if (image.length > MAX_IMAGE) throw bad('사진이 너무 큽니다.', 'IMAGE_TOO_LARGE');
  const row = await db.prepare(
    'SELECT (SELECT COUNT(*) FROM equipment_photos WHERE equipment_id = e.id) AS n FROM equipment e WHERE e.id = ?'
  ).bind(id).first();
  if (!row) throw new ApiError(404, 'NOT_FOUND', '비품을 찾을 수 없습니다.');
  if (row.n >= MAX_PHOTOS) throw bad(`사진은 ${MAX_PHOTOS}장까지 붙일 수 있습니다.`, 'TOO_MANY_PHOTOS');
  await db.batch([
    db.prepare('INSERT INTO equipment_photos (equipment_id, image, created_at, created_by) VALUES (?, ?, ?, ?)')
      .bind(id, image, new Date().toISOString(), actor.email),
    auditStatement(db, { actor: actor.email, entity: 'equipment_photos', entityId: id, action: 'CREATE' }),
  ]);
  return json({ ok: true }, 201);
}

export async function removePhoto({ env, actor, params }) {
  const db = env.DB;
  const photoId = parseId(params.photoId, '사진 번호');
  const row = await db.prepare('SELECT equipment_id FROM equipment_photos WHERE id = ?').bind(photoId).first();
  if (!row) throw new ApiError(404, 'NOT_FOUND', '사진을 찾을 수 없습니다.');
  await db.batch([
    db.prepare('DELETE FROM equipment_photos WHERE id = ?').bind(photoId),
    auditStatement(db, { actor: actor.email, entity: 'equipment_photos', entityId: row.equipment_id, action: 'DELETE' }),
  ]);
  return json({ ok: true });
}
