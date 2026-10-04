// 테스트용 SQLite: migrations/*.sql 을 순서대로 적용한 메모리 DB
// D1 과 같은 SQLite 엔진이므로 스키마 제약·트리거를 그대로 검증할 수 있다.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

export function createDb({ seed = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON'); // D1 은 항상 외래키 검사
  const dir = join(root, 'public', 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  if (seed) db.exec(readFileSync(join(root, 'seed', 'dev-sample.sql'), 'utf8'));
  return db;
}

/** D1 의 prepare/bind/first/all/batch 를 흉내 내는 최소 어댑터 (라우트 코드 테스트용) */
export function d1Adapter(db) {
  const wrap = (sql, params = []) => ({
    bind: (...p) => wrap(sql, p),
    first: async (col) => {
      const row = db.prepare(sql).get(...params);
      return row == null ? null : col ? row[col] : { ...row };
    },
    all: async () => ({ results: db.prepare(sql).all(...params).map((r) => ({ ...r })) }),
    run: async () => db.prepare(sql).run(...params),
    _exec: () => {
      const results = db.prepare(sql).all(...params).map((r) => ({ ...r }));
      return { results, meta: { changes: db.prepare('SELECT changes() AS c').get().c } };
    },
  });
  return {
    prepare: (sql) => wrap(sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

const NOW = '2026-10-04T00:00:00.000Z';

export function accountId(db, name) {
  return db.prepare('SELECT id FROM accounts WHERE name = ?').get(name).id;
}

export function subjectId(db, kind, name) {
  return db.prepare('SELECT id FROM budget_subjects WHERE kind = ? AND name = ?').get(kind, name).id;
}

export function insertTx(db, { date, direction, account, subject, amount, memo = '' }) {
  const kind = direction === 'IN' ? 'INCOME' : 'EXPENSE';
  return db
    .prepare(
      `INSERT INTO transactions (tx_date, direction, account_id, subject_id, amount, memo, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'test')`
    )
    .run(date, direction, accountId(db, account), subjectId(db, kind, subject), amount, memo, NOW).lastInsertRowid;
}

export function deleteTx(db, id) {
  db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
}

export function closeDate(db, date) {
  db.prepare(
    `INSERT INTO daily_closings (close_date, status, approval_snapshot, balance_snapshot, writer_name, closed_at, closed_by)
     VALUES (?, 'CLOSED', '[]', '{}', '사무장', ?, 'test')`
  ).run(date, NOW);
}

export function reopenDate(db, date, reason = '정정 필요') {
  db.prepare(
    `UPDATE daily_closings SET status = 'REOPENED', reopened_at = ?, reopened_by = 'test', reopen_reason = ?
     WHERE close_date = ?`
  ).run(NOW, reason, date);
}
