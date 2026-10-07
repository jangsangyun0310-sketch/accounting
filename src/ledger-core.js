// 성당별 장부 저장소의 핵심 (Durable Object 의 SQLite 를 장부 엔진이 쓰는 D1 모양으로)
// cloudflare:workers 에 기대지 않아 Node 테스트에서도 그대로 검사할 수 있다.

/**
 * Durable Object 저장소(ctx.storage)를 D1 과 같은 prepare/bind/first/all/run/batch 로 감싼다.
 * 그래서 장부 엔진(public/core)을 고치지 않고 서버에서 그대로 쓴다.
 */
export function storageD1(storage) {
  const { sql } = storage;
  const rows = (query, params) => sql.exec(query, ...params).toArray();

  const statement = (query, params = []) => ({
    bind: (...p) => statement(query, p),
    first: async (column) => {
      const r = rows(query, params)[0];
      if (r == null) return null;
      return column ? r[column] : r;
    },
    all: async () => ({ results: rows(query, params) }),
    run: async () => {
      rows(query, params);
      return { success: true, meta: { changes: sql.exec('SELECT changes() AS n').one().n } };
    },
    _results: () => rows(query, params),
  });

  return {
    prepare: (query) => statement(query),
    // D1 batch 와 같이 전부 성공 또는 전부 취소
    batch: async (statements) => storage.transactionSync(() => statements.map((s) => ({ results: s._results() }))),
  };
}

/**
 * 장부 표 구조를 순서대로 적용한다. 적용 기록은 d1_migrations 표에 남긴다
 * (장부 엔진의 상태 확인·백업이 이 표에서 스키마 이름을 읽는다).
 * @param {{ name: string, sql: string }[]} files
 */
export function applyMigrations(storage, files) {
  const { sql } = storage;
  sql.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)`);
  const done = new Set(sql.exec('SELECT name FROM d1_migrations').toArray().map((r) => r.name));
  for (const file of files) {
    if (done.has(file.name)) continue;
    storage.transactionSync(() => {
      sql.exec(file.sql);
      sql.exec('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)', file.name, new Date().toISOString());
    });
  }
}

/**
 * 장부를 비워도 되는지: 최초 설정 전(빈 장부)이거나, 마지막 백업 이후 바뀐 것이 없어야 한다.
 * (비우기 전에 반드시 최신 백업 파일을 받게 하려는 것)
 */
export function backupIsCurrent(storage) {
  const { sql } = storage;
  if (sql.exec('SELECT COUNT(*) AS n FROM setup_lock').one().n === 0) return true;
  const last = sql.exec("SELECT at FROM backup_log WHERE action = 'BACKUP' ORDER BY id DESC LIMIT 1").toArray()[0];
  if (!last) return false;
  const changed = sql.exec(
    'SELECT (SELECT COUNT(*) FROM audit_log WHERE at > ?1) + (SELECT COUNT(*) FROM closing_events WHERE at > ?1) AS n', last.at,
  ).one().n;
  return changed === 0;
}

/** 장부 비우기: 저장소의 모든 자료를 지우고 빈 표 구조를 다시 만든다 */
export async function resetLedger(storage, files) {
  await storage.deleteAll();
  applyMigrations(storage, files);
}

// ---------------------------------------------------------------- 서버 자동 백업

export const BACKUP_CHUNK_BYTES = 1_000_000; // D1 한 값 2MB 제한 안쪽

/** 글자 → gzip 바이트 */
export async function gzipText(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** gzip 바이트 → 글자 */
export async function gunzipText(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export function chunkBytes(bytes, size = BACKUP_CHUNK_BYTES) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out.length ? out : [new Uint8Array(0)];
}

/**
 * 백업 자료 한 벌을 백업 DB 에 넣는 SQL 문 (같은 날짜 것이 있으면 바꾼다).
 * @param db 백업 DB (env.BACKUPS)
 */
export async function serverBackupStatements(db, { parishId, date, backup }) {
  const json = JSON.stringify(backup);
  const chunks = chunkBytes(await gzipText(json));
  return [
    db.prepare('DELETE FROM ledger_backup_chunks WHERE parish_id = ? AND backup_date = ?').bind(parishId, date),
    db.prepare('DELETE FROM ledger_backups WHERE parish_id = ? AND backup_date = ?').bind(parishId, date),
    db.prepare(`INSERT INTO ledger_backups (parish_id, backup_date, created_at, json_size, checksum, counts, chunks)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(parishId, date, new Date().toISOString(), new TextEncoder().encode(json).length,
        backup.checksum, JSON.stringify(backup.counts), chunks.length),
    ...chunks.map((data, seq) => db.prepare(
      'INSERT INTO ledger_backup_chunks (parish_id, backup_date, seq, data) VALUES (?, ?, ?, ?)',
    ).bind(parishId, date, seq, data)),
  ];
}
