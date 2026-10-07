// 테스트용 SQLite: migrations/*.sql 을 순서대로 적용한 메모리 DB
// D1 과 같은 SQLite 엔진이므로 스키마 제약·트리거를 그대로 검증할 수 있다.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { handleApi } from '../public/core/engine.js';

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

/** 마감은 하루씩 빠짐없이: 다음 마감할 날부터 date 까지 차례로 마감 (테스트 준비용) */
export function closeThrough(db, date) {
  const last = db.prepare("SELECT MAX(close_date) AS d FROM daily_closings WHERE status = 'CLOSED'").get().d;
  const start = db.prepare('SELECT start_date AS d FROM parish_settings WHERE id = 1').get().d;
  const day = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  for (let d = last ? day(last, 1) : start; d <= date; d = day(d, 1)) closeDate(db, d);
}

export function reopenDate(db, date, reason = '정정 필요') {
  db.prepare(
    `UPDATE daily_closings SET status = 'REOPENED', reopened_at = ?, reopened_by = 'test', reopen_reason = ?
     WHERE close_date = ?`
  ).run(NOW, reason, date);
}

/** 브라우저 안의 엔진과 같은 API 처리 (fetch(request, env) 모양) */
export const worker = { fetch: (request, env) => handleApi(request, env, new URL(request.url)) };
