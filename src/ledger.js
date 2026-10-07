// 성당별 장부 저장소 (Durable Object: 성당 하나 = 저장소 하나 = SQLite 데이터베이스 하나)
//   Worker 가 로그인한 사용자의 성당을 확인한 뒤 /api/* 요청을 그 성당의 저장소로만 보낸다.
//   저장소는 바깥에서 직접 부를 수 없고, Worker 만 성당 ID 로 찾아 연다.
//   거래·마감·결산 규칙은 브라우저 때와 같은 장부 엔진(public/core)이 처리한다.
import { DurableObject } from 'cloudflare:workers';
import { handleApi } from '../public/core/engine.js';
import { applyMigrations, storageD1 } from './ledger-core.js';
// 장부 표 구조 (public/core/migrations.js 와 같은 순서. 테스트가 확인한다)
import m0001 from '../public/migrations/0001_init.sql';
import m0002 from '../public/migrations/0002_integrity_triggers.sql';
import m0003 from '../public/migrations/0003_setup_lock.sql';
import m0004 from '../public/migrations/0004_transactions_integrity.sql';
import m0005 from '../public/migrations/0005_closing_guards.sql';
import m0006 from '../public/migrations/0006_backup_restore.sql';
import m0007 from '../public/migrations/0007_delete_instead_of_void.sql';

const MIGRATION_FILES = [
  { name: '0001_init.sql', sql: m0001 },
  { name: '0002_integrity_triggers.sql', sql: m0002 },
  { name: '0003_setup_lock.sql', sql: m0003 },
  { name: '0004_transactions_integrity.sql', sql: m0004 },
  { name: '0005_closing_guards.sql', sql: m0005 },
  { name: '0006_backup_restore.sql', sql: m0006 },
  { name: '0007_delete_instead_of_void.sql', sql: m0007 },
];

export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = storageD1(ctx.storage);
    ctx.blockConcurrencyWhile(async () => applyMigrations(ctx.storage, MIGRATION_FILES));
  }

  /** Worker 가 넘긴 /api/* 요청. 처리자(이메일)는 Worker 가 x-bondang-actor 머리글에 넣는다 */
  async fetch(request) {
    const actor = request.headers.get('x-bondang-actor') || '사무실';
    return handleApi(request, { DB: this.db, AUTH_MODE: 'server', ACTOR: actor });
  }
}
