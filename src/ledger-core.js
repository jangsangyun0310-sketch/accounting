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
