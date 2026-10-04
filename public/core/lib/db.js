// DB 공용 처리: 트리거 오류 코드 번역, 감사 로그, 잔액 계산 쿼리
import { ApiError } from './http.js';

// 트리거가 RAISE(ABORT, '<CODE>') 로 던지는 코드 → 사용자 메시지
const DB_ERRORS = {
  DATE_CLOSED: [409, '마감된 날짜의 거래는 변경할 수 없습니다. 먼저 마감취소를 하세요.'],
  BEFORE_START_DATE: [400, '운영 개시일 이전 날짜로는 거래를 입력할 수 없습니다.'],
  ACCOUNT_INACTIVE: [400, '사용 중지된 통장이거나 존재하지 않는 통장입니다.'],
  SUBJECT_MISMATCH: [400, '예산과목이 수입/지출 구분과 맞지 않거나 사용 중지된 과목입니다.'],
  REPLACES_NOT_VOIDED: [409, '수정 대상 원본 거래가 취소 처리되지 않았습니다.'],
  TX_IMMUTABLE: [409, '거래 내용은 직접 수정할 수 없습니다. 취소 후 다시 입력하세요.'],
  TX_NO_DELETE: [409, '거래는 삭제할 수 없습니다. 취소 처리하세요.'],
  INVALID_STATUS: [400, '잘못된 거래 상태입니다.'],
  CLOSE_ORDER: [409, '이전 날짜에 마감되지 않은 거래가 있습니다. 앞 날짜부터 순서대로 마감하세요.'],
  ALREADY_LOCKED: [409, '이후 날짜까지 이미 마감되어 있습니다.'],
  REOPEN_NOT_LATEST: [409, '마감취소는 가장 마지막 마감일부터 순서대로만 할 수 있습니다.'],
  CLOSING_INVALID: [409, '잘못된 마감 처리 요청입니다.'],
  CLOSING_NO_DELETE: [409, '마감 기록은 삭제할 수 없습니다.'],
  LOG_IMMUTABLE: [409, '이력 기록은 변경하거나 삭제할 수 없습니다.'],
  OPENING_LOCKED_NEW: [409, '마감된 날짜가 있어 새 통장의 초기잔액은 0원이어야 합니다. 입금은 거래나 이체로 입력하세요.'],
  OPENING_LOCKED_DELETE: [409, '마감된 날짜가 있어 초기잔액이 있는 통장은 삭제할 수 없습니다. 사용중지로 처리하세요.'],
  OPENING_LOCKED: [409, '마감된 날짜가 있어 초기잔액을 변경할 수 없습니다.'],
  ALREADY_CLOSED: [409, '이미 마감된 날짜입니다.'],
  ACCOUNT_IN_USE: [409, '거래가 있는 통장은 삭제하거나 회계 구분을 바꿀 수 없습니다. 사용 중지로 처리하세요.'],
  SUBJECT_IN_USE: [409, '사용된 과목은 삭제하거나 수입/지출 구분을 바꿀 수 없습니다. 사용 중지로 처리하세요.'],
  START_DATE_LOCKED: [409, '거래가 있어 운영 개시일을 변경할 수 없습니다.'],
  TRANSFER_MISMATCH: [400, '이체의 출금·입금 내역이 맞지 않습니다.'],
  ALREADY_REPLACED: [409, '이미 수정된 거래입니다. 화면을 새로고침하세요.'],
  RESTORE_NOT_EMPTY: [409, '이미 데이터가 있는 곳에는 복구할 수 없습니다.'],
  SETUP_DONE: [409, '최초 설정이 이미 완료되었습니다. 변경은 설정 화면에서 하세요.'],
};

/** D1 오류를 ApiError 로 번역. 알 수 없는 오류는 그대로 다시 던진다. */
export function translateDbError(err) {
  if (err instanceof ApiError) return err;
  let message = String(err?.message ?? err);
  if (message.includes('UNIQUE constraint failed: setup_lock')) message = 'SETUP_DONE';
  if (message.includes('UNIQUE constraint failed: transactions.replaces_id')) message = 'ALREADY_REPLACED';
  if (message.includes('UNIQUE constraint failed: daily_closings.close_date')) message = 'ALREADY_CLOSED';
  for (const [code, [status, text]] of Object.entries(DB_ERRORS)) {
    if (message.includes(code)) return new ApiError(status, code, text);
  }
  if (message.includes('UNIQUE constraint failed')) {
    return new ApiError(409, 'DUPLICATE', '같은 이름이 이미 등록되어 있습니다.');
  }
  if (message.includes('CHECK constraint failed') || message.includes('FOREIGN KEY constraint failed')) {
    return new ApiError(400, 'CONSTRAINT', '입력값이 올바르지 않습니다.');
  }
  throw err;
}

/** batch 에 함께 넣을 감사 로그 INSERT 문 */
export function auditStatement(db, { actor, entity, entityId, action, before = null, after = null }) {
  return db
    .prepare(
      `INSERT INTO audit_log (at, actor, entity, entity_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      new Date().toISOString(),
      actor,
      entity,
      entityId == null ? null : String(entityId),
      action,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after)
    );
}

// 감사 로그에 남길 테이블별 컬럼
const SNAPSHOT_COLUMNS = {
  parish_settings: ['parish_name', 'start_date', 'writer_name', 'setup_completed'],
  accounts: ['id', 'fund_id', 'name', 'bank_name', 'account_no', 'opening_balance', 'sort_order', 'is_active'],
  budget_subjects: ['id', 'kind', 'parent_id', 'code', 'name', 'sort_order', 'is_active'],
  transactions: ['id', 'tx_date', 'kind', 'direction', 'account_id', 'subject_id', 'transfer_group', 'amount',
    'memo', 'voucher_no', 'status', 'replaces_id', 'void_reason', 'voided_at', 'voided_by'],
};

/** 해당 테이블 한 행을 JSON 문자열로 만드는 SQL 식 */
export function rowJsonSql(table) {
  return `json_object(${SNAPSHOT_COLUMNS[table].map((c) => `'${c}', ${c}`).join(', ')})`;
}

/** 변경 전 행 스냅샷 (JSON 문자열). 행이 없으면 null */
export async function readRowJson(db, table, id) {
  return db.prepare(`SELECT ${rowJsonSql(table)} AS j FROM ${table} WHERE id = ?`).bind(id).first('j');
}

/**
 * 변경 직후의 행을 DB 에서 직접 읽어 after_json 으로 기록하는 감사 로그 문.
 * 같은 batch 안에서 변경 문 바로 뒤에 둔다.
 * id = 'last' 이면 직전 INSERT 의 행(last_insert_rowid)을 기록한다.
 */
export function auditRowStatement(db, { actor, action, table, id, beforeJson = null }) {
  const where = id === 'last' ? 'id = last_insert_rowid()' : 'id = ?6';
  const stmt = db.prepare(
    `INSERT INTO audit_log (at, actor, entity, entity_id, action, before_json, after_json)
     SELECT ?1, ?2, ?3, CAST(id AS TEXT), ?4, ?5, ${rowJsonSql(table)} FROM ${table} WHERE ${where}`
  );
  const params = [new Date().toISOString(), actor, table, action, beforeJson];
  return id === 'last' ? stmt.bind(...params) : stmt.bind(...params, id);
}

/**
 * 통장별 잔액 (asOfDate 일자 업무 종료 기준).
 * 잔액 = 초기잔액 + Σ(POSTED 수입) − Σ(POSTED 지출), tx_date ≤ asOfDate
 * 비활성 통장도 잔액이 있으면 포함한다.
 */
export const BALANCES_SQL = `
  SELECT a.id, a.fund_id, f.code AS fund_code, f.name AS fund_name,
         a.name, a.is_active, a.opening_balance,
         a.opening_balance + COALESCE((
           SELECT SUM(CASE t.direction WHEN 'IN' THEN t.amount ELSE -t.amount END)
           FROM transactions t
           WHERE t.account_id = a.id AND t.status = 'POSTED' AND t.tx_date <= ?1
         ), 0) AS balance
  FROM accounts a
  JOIN funds f ON f.id = a.fund_id
  ORDER BY f.sort_order, a.sort_order, a.id`;
