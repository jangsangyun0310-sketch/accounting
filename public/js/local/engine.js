// 브라우저 안의 본당살림 엔진
// sqlite-wasm 메모리 DB + 서버와 같은 API 코드(public/core). 변경이 있을 때마다 DB 전체를 바이트로 내보내 저장소에 넘긴다.
import sqlite3InitModule from '/vendor/sqlite/index.mjs';
import { handleApi } from '/core/engine.js';
import { MIGRATIONS } from '/core/migrations.js';
import { d1Adapter } from './sqlite-d1.js';

let sqlite3 = null;

async function sqlite() {
  sqlite3 ??= await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  return sqlite3;
}

/** 저장된 바이트(없으면 새 DB)로 엔진을 연다 */
export async function openEngine(bytes, { onChange } = {}) {
  const s3 = await sqlite();
  const db = new s3.oo1.DB(':memory:', 'c');
  if (bytes && bytes.length) {
    const p = s3.wasm.allocFromTypedArray(bytes);
    const rc = s3.capi.sqlite3_deserialize(db.pointer, 'main', p, bytes.length, bytes.length,
      s3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | s3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
    db.checkRc(rc);
  }
  db.exec('PRAGMA foreign_keys = ON');
  await applyMigrations(db);

  const env = { DB: d1Adapter(db), AUTH_MODE: 'open' };
  const exportBytes = () => s3.capi.sqlite3_js_db_export(db);

  // 저장에 실패하면 화면의 자료와 저장된 자료가 달라지므로, 새로고침할 때까지 더 이상 처리하지 않는다
  let broken = null;
  const errorResponse = (status, code, message) => new Response(
    JSON.stringify({ error: { code, message } }), { status, headers: { 'content-type': 'application/json' } });

  return {
    exportBytes,
    /** fetch 와 같은 모양으로 /api/* 를 처리 */
    async fetch(path, init = {}) {
      if (broken) return errorResponse(409, 'RELOAD_REQUIRED', broken);
      const request = new Request(new URL(path, location.origin), init);
      const response = await handleApi(request, env);
      const method = (init.method || 'GET').toUpperCase();
      if (method !== 'GET' && response.ok && onChange) {
        try {
          await onChange(exportBytes());
        } catch (err) {
          broken = `${err.message} (방금 입력한 내용은 저장되지 않았습니다. 새로고침(F5) 후 다시 입력하세요.)`;
          return errorResponse(409, err.code || 'SAVE_FAILED', broken);
        }
      }
      return response;
    },
    close: () => db.close(),
  };
}

async function applyMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.exec({ sql: 'SELECT name FROM _local_migrations', rowMode: 'array', returnValue: 'resultRows' })
    .map((r) => r[0]));
  for (const name of MIGRATIONS) {
    if (done.has(name)) continue;
    const res = await fetch(`/migrations/${name}`);
    if (!res.ok) throw new Error(`프로그램 파일을 불러오지 못했습니다 (${name}). 새로고침하세요.`);
    const sql = await res.text();
    db.transaction(() => {
      db.exec(sql);
      db.exec({ sql: 'INSERT INTO _local_migrations (name, applied_at) VALUES (?, ?)', bind: [name, new Date().toISOString()] });
    });
  }
}
