// 서버 자동 백업: 압축·조각 저장 → 다시 풀면 같은 백업, 성당별로 부탁, 30일 지난 것 지움
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { d1Adapter } from './helpers.js';
import { chunkBytes, gunzipText, serverBackupStatements } from '../src/ledger-core.js';
import { runServerBackups } from '../src/server-backup.js';

function backupsDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../src/backup-migrations/0001_ledger_backups.sql', import.meta.url), 'utf8'));
  return db;
}

const sample = (n = 3) => ({
  format: 'bondang-salim-backup', version: 1, checksum: 'abc',
  counts: { transactions: n },
  tables: { transactions: Array.from({ length: n }, (_, i) => ({ id: i + 1, memo: `교무금 ${i}` })) },
});

async function restore(db, parishId, date) {
  const meta = db.prepare('SELECT chunks FROM ledger_backups WHERE parish_id = ? AND backup_date = ?').get(parishId, date);
  const rows = db.prepare('SELECT data FROM ledger_backup_chunks WHERE parish_id = ? AND backup_date = ? ORDER BY seq').all(parishId, date);
  assert.equal(rows.length, meta.chunks);
  const bytes = Buffer.concat(rows.map((r) => Buffer.from(r.data)));
  return JSON.parse(await gunzipText(new Uint8Array(bytes)));
}

test('서버 백업: gzip 으로 줄여 조각으로 넣고, 다시 풀면 같은 자료 (같은 날짜는 바꿔 넣기)', async () => {
  const raw = backupsDb();
  const db = d1Adapter(raw);
  await db.batch(await serverBackupStatements(db, { parishId: 'p1', date: '2026-10-08', backup: sample(3) }));
  await db.batch(await serverBackupStatements(db, { parishId: 'p1', date: '2026-10-08', backup: sample(5) }));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM ledger_backups').get().n, 1);
  assert.deepEqual(await restore(raw, 'p1', '2026-10-08'), sample(5));
});

test('큰 자료는 여러 조각으로 나뉘고 순서대로 이으면 원래대로', () => {
  const bytes = Uint8Array.from({ length: 2500 }, (_, i) => i % 251);
  const parts = chunkBytes(bytes, 1000);
  assert.deepEqual(parts.map((p) => p.length), [1000, 1000, 500]);
  assert.deepEqual(Buffer.concat(parts), Buffer.from(bytes));
});

test('매일 백업: 모든 성당에 차례로 부탁, 실패해도 다음 성당 계속, 30일 지난 백업 삭제', async () => {
  const main = new DatabaseSync(':memory:');
  main.exec("CREATE TABLE parishes (id TEXT PRIMARY KEY, name TEXT, created_at TEXT)");
  main.exec("INSERT INTO parishes VALUES ('a', '가성당', '1'), ('b', '나성당', '2'), ('c', '다성당', '3')");
  const raw = backupsDb();
  const backups = d1Adapter(raw);
  // 오래된 백업 (31일 전) 과 남길 백업 (30일 전)
  await backups.batch(await serverBackupStatements(backups, { parishId: 'a', date: '2026-09-07', backup: sample() }));
  await backups.batch(await serverBackupStatements(backups, { parishId: 'a', date: '2026-09-08', backup: sample() }));
  const asked = [];
  const env = {
    DB: d1Adapter(main),
    BACKUPS: backups,
    LEDGER: {
      idFromName: (name) => name,
      get: (name) => ({
        fetch: async (req) => {
          asked.push([name, new URL(req.url).pathname, new URL(req.url).searchParams.get('date')]);
          if (name === 'b') return new Response('boom', { status: 500 });
          if (name === 'c') return Response.json({ skipped: 'not-set-up' });
          return Response.json({ ok: true });
        },
      }),
    },
  };
  const summary = await runServerBackups(env, '2026-10-08');
  assert.deepEqual(asked.map((a) => a[0]), ['a', 'b', 'c']);
  assert.deepEqual(asked[0].slice(1), ['/__admin/server-backup', '2026-10-08']);
  assert.equal(summary.ok, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed.length, 1);
  assert.deepEqual(raw.prepare('SELECT backup_date FROM ledger_backups ORDER BY backup_date').all().map((r) => r.backup_date), ['2026-09-08']);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM ledger_backup_chunks WHERE backup_date = '2026-09-07'").get().n, 0);
});
