// 성당별 장부 저장소 (Durable Object: 성당 하나 = 저장소 하나 = SQLite 데이터베이스 하나)
//   Worker 가 로그인한 사용자의 성당을 확인한 뒤 /api/* 요청을 그 성당의 저장소로만 보낸다.
//   저장소는 바깥에서 직접 부를 수 없고, Worker 만 성당 ID 로 찾아 연다.
//   거래·마감·결산 규칙은 브라우저 때와 같은 장부 엔진(public/core)이 처리한다.
import { DurableObject } from 'cloudflare:workers';
import { handleApi } from '../public/core/engine.js';
import { applyMigrations, backupIsCurrent, resetLedger, serverBackupStatements, storageD1 } from './ledger-core.js';
import { buildBackup } from '../public/core/lib/backup.js';
// 장부 표 구조 (public/core/migrations.js 와 같은 순서. 테스트가 확인한다)
import m0001 from '../public/migrations/0001_init.sql';
import m0002 from '../public/migrations/0002_integrity_triggers.sql';
import m0003 from '../public/migrations/0003_setup_lock.sql';
import m0004 from '../public/migrations/0004_transactions_integrity.sql';
import m0005 from '../public/migrations/0005_closing_guards.sql';
import m0006 from '../public/migrations/0006_backup_restore.sql';
import m0007 from '../public/migrations/0007_delete_instead_of_void.sql';
import m0009 from '../public/migrations/0009_close_every_day.sql';
import m0010 from '../public/migrations/0010_budgets.sql';

const MIGRATION_FILES = [
  { name: '0001_init.sql', sql: m0001 },
  { name: '0002_integrity_triggers.sql', sql: m0002 },
  { name: '0003_setup_lock.sql', sql: m0003 },
  { name: '0004_transactions_integrity.sql', sql: m0004 },
  { name: '0005_closing_guards.sql', sql: m0005 },
  { name: '0006_backup_restore.sql', sql: m0006 },
  { name: '0007_delete_instead_of_void.sql', sql: m0007 },
  { name: '0009_close_every_day.sql', sql: m0009 },
  { name: '0010_budgets.sql', sql: m0010 },
];

export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = storageD1(ctx.storage);
    ctx.blockConcurrencyWhile(async () => applyMigrations(ctx.storage, MIGRATION_FILES));
  }

  /**
   * Worker 가 넘긴 요청
   *   /api/*         : 장부 엔진. 처리자(이메일)는 Worker 가 x-bondang-actor 머리글에 넣는다
   *   /__admin/reset : 장부 비우기 (최신 백업이 있어야 함)
   *   /__admin/wipe  : 탈퇴 — 이 성당 장부를 모두 지운다
   *   /__admin/server-backup?parish=&date= : 서버 자동 백업 — 장부 전체를 백업 DB(env.BACKUPS)에 넣는다
   * /__admin/* 는 Worker 가 계정 화면(src/account.js)에서만 부른다. 바깥 요청은 /api/* 만 이곳으로 온다.
   */
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/__admin/reset') {
      if (!backupIsCurrent(this.ctx.storage)) {
        return Response.json({ error: { code: 'BACKUP_REQUIRED', message: '먼저 지금 장부의 백업 파일을 내려받으세요. (마지막 백업 이후 바뀐 내용이 있습니다)' } }, { status: 409 });
      }
      await resetLedger(this.ctx.storage, MIGRATION_FILES);
      return Response.json({ ok: true });
    }
    if (pathname === '/__admin/server-backup') {
      return this.serverBackup(new URL(request.url).searchParams);
    }
    if (pathname === '/__admin/wipe') {
      await this.ctx.storage.deleteAll();
      return Response.json({ ok: true });
    }
    const actor = request.headers.get('x-bondang-actor') || '사무실';
    return handleApi(request, { DB: this.db, AUTH_MODE: 'server', ACTOR: actor });
  }

  /** 서버 자동 백업: 최초 설정 전 장부는 건너뛴다. 성당 화면의 '마지막 백업' 기록은 남기지 않는다 */
  async serverBackup(params) {
    const { sql } = this.ctx.storage;
    if (sql.exec('SELECT COUNT(*) AS n FROM setup_lock').one().n === 0) return Response.json({ skipped: 'not-set-up' });
    const schema = sql.exec('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').toArray()[0]?.name ?? null;
    const backup = await buildBackup(this.db, { schema });
    const db = this.env.BACKUPS;
    await db.batch(await serverBackupStatements(db, { parishId: params.get('parish'), date: params.get('date'), backup }));
    return Response.json({ ok: true, counts: backup.counts });
  }
}
