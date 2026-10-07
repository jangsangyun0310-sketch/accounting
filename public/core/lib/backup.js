// 백업 파일 만들기·검증·복구 SQL 생성
// 백업 파일 = 모든 표의 원본 행 + SHA-256 검사값. 복구는 빈 DB 에 한 batch 로 넣는다.
import { ApiError } from './http.js';
import { sumAmounts } from '../../js/shared/money.js';

export const BACKUP_FORMAT = 'bondang-salim-backup';
export const BACKUP_VERSION = 1;

// 복구 순서대로 (외래키·트리거 순서: 거래는 마감보다 먼저 넣어야 마감일 잠금에 걸리지 않는다)
export const TABLES = [
  { name: 'parish_settings', order: 'id',
    columns: ['id', 'parish_name', 'start_date', 'writer_name', 'setup_completed', 'updated_at', 'updated_by'] },
  { name: 'setup_lock', order: 'id', columns: ['id', 'created_at', 'created_by'] },
  { name: 'accounts', order: 'id',
    columns: ['id', 'fund_id', 'name', 'bank_name', 'account_no', 'opening_balance', 'sort_order', 'is_active',
      'created_at', 'created_by', 'updated_at', 'updated_by'] },
  { name: 'budget_subjects', order: 'parent_id IS NOT NULL, id',
    columns: ['id', 'kind', 'parent_id', 'code', 'name', 'sort_order', 'is_active',
      'created_at', 'created_by', 'updated_at', 'updated_by'] },
  { name: 'approval_steps', order: 'seq', columns: ['seq', 'title'] },
  { name: 'transactions', order: 'id',
    columns: ['id', 'tx_date', 'kind', 'direction', 'account_id', 'subject_id', 'transfer_group', 'amount', 'memo',
      'voucher_no', 'status', 'replaces_id', 'void_reason', 'voided_at', 'voided_by', 'created_at', 'created_by'] },
  { name: 'daily_closings', order: 'close_date',
    columns: ['close_date', 'status', 'approval_snapshot', 'balance_snapshot', 'writer_name', 'closed_at', 'closed_by',
      'reopened_at', 'reopened_by', 'reopen_reason'] },
  { name: 'closing_events', order: 'id', columns: ['id', 'close_date', 'action', 'reason', 'at', 'actor'] },
  { name: 'audit_log', order: 'id',
    columns: ['id', 'at', 'actor', 'entity', 'entity_id', 'action', 'before_json', 'after_json'] },
  { name: 'backup_log', order: 'id', columns: ['id', 'at', 'actor', 'action', 'summary'] },
];

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 현재 DB 전체를 백업 객체로 */
export async function buildBackup(db, { schema }) {
  const results = await db.batch(TABLES.map((t) =>
    db.prepare(`SELECT ${t.columns.join(', ')} FROM ${t.name} ORDER BY ${t.order}`)));
  const tables = Object.fromEntries(TABLES.map((t, i) => [t.name, results[i].results]));
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schema,
    exportedAt: new Date().toISOString(),
    parishName: tables.parish_settings[0]?.parish_name ?? '',
    counts: Object.fromEntries(TABLES.map((t) => [t.name, tables[t.name].length])),
    checksum: await sha256Hex(JSON.stringify(tables)),
    tables,
  };
}

const invalid = (message) => new ApiError(400, 'BACKUP_INVALID', message);

/**
 * 백업 파일 검증. 형식·검사값·회계 정합성(마감 스냅샷 잔액, 이체 쌍, 과목 구분)을 확인한다.
 * @returns 요약 정보
 */
export async function validateBackup(backup) {
  if (!backup || typeof backup !== 'object' || backup.format !== BACKUP_FORMAT) {
    throw invalid('본당살림 백업 파일이 아닙니다.');
  }
  if (backup.version !== BACKUP_VERSION) throw invalid(`지원하지 않는 백업 형식 버전입니다 (${backup.version}).`);
  const { tables } = backup;
  if (!tables || typeof tables !== 'object') throw invalid('백업 파일에 데이터가 없습니다.');

  for (const t of TABLES) {
    const rows = tables[t.name];
    if (!Array.isArray(rows)) throw invalid(`백업 파일에 ${t.name} 표가 없습니다.`);
    for (const row of rows) {
      const keys = row && typeof row === 'object' ? Object.keys(row) : [];
      if (keys.length !== t.columns.length || !t.columns.every((c) => c in row)) {
        throw invalid(`${t.name} 표의 항목 구성이 이 프로그램 버전과 다릅니다.`);
      }
    }
  }
  if (Object.keys(tables).length !== TABLES.length) throw invalid('백업 파일의 표 구성이 다릅니다.');

  if (await sha256Hex(JSON.stringify(tables)) !== backup.checksum) {
    throw invalid('백업 파일이 손상되었거나 수정되었습니다 (검사값 불일치).');
  }

  if (tables.parish_settings.length !== 1 || tables.setup_lock.length !== 1) {
    throw invalid('최초 설정이 완료된 백업 파일이 아닙니다.');
  }

  // 회계 정합성: 파일 안의 데이터만으로 다시 계산해 본다
  const accounts = new Map(tables.accounts.map((a) => [a.id, a]));
  const subjects = new Map(tables.budget_subjects.map((s) => [s.id, s]));
  const txs = tables.transactions;

  for (const t of txs) {
    if (!accounts.has(t.account_id)) throw invalid(`거래 #${t.id} 의 통장이 백업에 없습니다.`);
    if (t.kind === 'NORMAL') {
      const s = subjects.get(t.subject_id);
      if (!s || s.kind !== (t.direction === 'IN' ? 'INCOME' : 'EXPENSE')) {
        throw invalid(`거래 #${t.id} 의 예산과목이 맞지 않습니다.`);
      }
    }
  }

  const groups = new Map();
  for (const t of txs.filter((x) => x.kind === 'TRANSFER')) {
    groups.set(t.transfer_group, [...(groups.get(t.transfer_group) ?? []), t]);
  }
  for (const [group, pair] of groups) {
    const out = pair.find((t) => t.direction === 'OUT');
    const inn = pair.find((t) => t.direction === 'IN');
    if (pair.length !== 2 || !out || !inn || out.tx_date !== inn.tx_date || out.amount !== inn.amount
        || out.status !== inn.status) {
      throw invalid(`이체 묶음(${group})의 출금·입금이 맞지 않습니다.`);
    }
  }

  // 통장별 날짜순 누적 잔액 → 마감일 잔액은 이진 탐색 (거래·마감이 많아도 빠르게)
  const ledgers = new Map([...accounts.keys()].map((id) => [id, { dates: [], totals: [] }]));
  const sorted = txs.filter((t) => t.status === 'POSTED')
    .sort((a, b) => (a.tx_date < b.tx_date ? -1 : a.tx_date > b.tx_date ? 1 : 0));
  for (const t of sorted) {
    const l = ledgers.get(t.account_id);
    const prev = l.totals.at(-1) ?? accounts.get(t.account_id).opening_balance;
    const next = sumAmounts([prev, t.direction === 'IN' ? t.amount : -t.amount]);
    if (l.dates.at(-1) === t.tx_date) l.totals[l.totals.length - 1] = next;
    else { l.dates.push(t.tx_date); l.totals.push(next); }
  }
  const balanceAt = (accountId, date) => {
    const { dates, totals } = ledgers.get(accountId);
    let lo = 0;
    let hi = dates.length; // dates[lo..hi) 중 date 이하인 마지막 위치 찾기
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] <= date) lo = mid + 1; else hi = mid;
    }
    return lo === 0 ? accounts.get(accountId).opening_balance : totals[lo - 1];
  };
  for (const c of tables.daily_closings.filter((x) => x.status === 'CLOSED')) {
    let snapshot;
    try { snapshot = JSON.parse(c.balance_snapshot); } catch { throw invalid(`${c.close_date} 마감 기록이 손상되었습니다.`); }
    if (!Array.isArray(snapshot)) throw invalid(`${c.close_date} 마감 기록이 손상되었습니다.`);
    for (const s of snapshot) {
      if (!accounts.has(s.id) || balanceAt(s.id, c.close_date) !== s.balance) {
        throw invalid(`${c.close_date} 마감 잔액(${s.name})이 거래 내역과 맞지 않습니다.`);
      }
    }
  }

  const dates = txs.map((t) => t.tx_date).sort();
  const closed = tables.daily_closings.filter((x) => x.status === 'CLOSED').map((x) => x.close_date).sort();
  return {
    parishName: tables.parish_settings[0].parish_name,
    exportedAt: backup.exportedAt,
    schema: backup.schema,
    counts: Object.fromEntries(TABLES.map((t) => [t.name, tables[t.name].length])),
    firstDate: dates[0] ?? null,
    lastDate: dates.at(-1) ?? null,
    lastClosed: closed.at(-1) ?? null,
  };
}

const CHUNK_CHARS = 400_000; // D1 바인딩 값 크기 제한(2MB) 안쪽으로 나눈다

/** 복구용 SQL 문 목록 (복구 세션 열기 → 표별 INSERT → 세션 닫기) */
export function restoreStatements(db, tables) {
  const statements = [db.prepare('INSERT INTO restore_session (id) VALUES (1)')];
  for (const t of TABLES) {
    const select = t.columns.map((c) => `json_extract(value, '$.${c}')`).join(', ');
    const sql = `INSERT INTO ${t.name} (${t.columns.join(', ')}) SELECT ${select} FROM json_each(?1) ORDER BY key`;
    // 이전 버전 백업의 취소된 거래는 복구하지 않는다 (지금은 취소 = 삭제)
    const rows = t.name === 'transactions'
      ? tables.transactions.filter((x) => x.status === 'POSTED').map((x) => ({ ...x, replaces_id: null }))
      : tables[t.name];
    for (const chunk of chunkRows(rows)) statements.push(db.prepare(sql).bind(JSON.stringify(chunk)));
  }
  statements.push(db.prepare('DELETE FROM restore_session'));
  return statements;
}

function chunkRows(rows) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const row of rows) {
    const len = JSON.stringify(row).length;
    if (current.length && size + len > CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
