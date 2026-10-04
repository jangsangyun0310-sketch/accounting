// sqlite-wasm 데이터베이스를 D1 과 같은 모양(prepare/bind/first/all/run/batch)으로 감싼다.
// 그래서 서버용 API 엔진(public/core)을 브라우저에서 그대로 쓸 수 있다.

/** 64비트 정수(BigInt)를 안전한 범위면 Number 로 (금액 계산은 Number 정수로 한다) */
function normalize(row) {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === 'bigint') {
      if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new Error(`정수가 너무 큽니다: ${k}`);
      }
      row[k] = Number(v);
    }
  }
  return row;
}

export function d1Adapter(db) {
  const rows = (sql, params) => db.exec({
    sql,
    bind: params.length ? params : undefined,
    rowMode: 'object',
    returnValue: 'resultRows',
  }).map(normalize);

  const statement = (sql, params = []) => ({
    bind: (...p) => statement(sql, p),
    first: async (column) => {
      const r = rows(sql, params)[0];
      if (r == null) return null;
      return column ? r[column] : r;
    },
    all: async () => ({ results: rows(sql, params) }),
    run: async () => {
      rows(sql, params);
      return { success: true, meta: { changes: db.changes() } };
    },
    _results: () => rows(sql, params),
  });

  return {
    prepare: (sql) => statement(sql),
    // D1 batch 와 같이 전부 성공 또는 전부 취소 (트랜잭션)
    batch: async (statements) => db.transaction(() => statements.map((s) => ({ results: s._results() }))),
  };
}
