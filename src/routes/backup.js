// 백업 내려받기, 백업 상태, 복구
import { ApiError, json, readJson } from '../lib/http.js';
import { buildBackup, restoreStatements, validateBackup } from '../lib/backup.js';
import { todayKST } from '../../public/js/shared/dates.js';

async function currentSchema(db) {
  try {
    return await db.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first('name');
  } catch {
    return null; // 마이그레이션 표가 없는 환경(테스트)
  }
}

/** GET /api/backup : 전체 데이터 JSON 파일 */
export async function download({ env, actor }) {
  const db = env.DB;
  const backup = await buildBackup(db, { schema: await currentSchema(db) });
  if (!backup.tables.setup_lock.length) throw new ApiError(409, 'SETUP_REQUIRED', '최초 설정 전에는 백업할 데이터가 없습니다.');

  await db.prepare(`INSERT INTO backup_log (at, actor, action, summary) VALUES (?, ?, 'BACKUP', ?)`)
    .bind(backup.exportedAt, actor.email, JSON.stringify({ counts: backup.counts, checksum: backup.checksum })).run();

  const fileName = `본당살림-백업-${backup.parishName}-${todayKST()}.json`;
  return new Response(JSON.stringify(backup), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="bondang-backup-${todayKST()}.json"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'cache-control': 'no-store',
    },
  });
}

/** GET /api/backup/status : 마지막 백업과 그 이후 변경 건수 */
export async function status({ env }) {
  const db = env.DB;
  const last = await db.prepare(
    `SELECT at, actor FROM backup_log WHERE action = 'BACKUP' ORDER BY id DESC LIMIT 1`
  ).first();
  const changes = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM audit_log WHERE at > ?1) + (SELECT COUNT(*) FROM closing_events WHERE at > ?1) AS n`
  ).bind(last?.at ?? '').first('n');
  const { results: history } = await db.prepare(
    'SELECT at, actor, action FROM backup_log ORDER BY id DESC LIMIT 10'
  ).all();
  return json({ lastBackupAt: last?.at ?? null, lastBackupBy: last?.actor ?? null, changesSince: changes, history });
}

/** POST /api/restore[?dryRun=1] : 백업 파일 검증, 빈 DB 에 복구 */
export async function restore({ request, env, actor, url }) {
  const backup = await readJson(request);
  const summary = await validateBackup(backup);
  const db = env.DB;

  const existing = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM setup_lock) + (SELECT COUNT(*) FROM accounts)
          + (SELECT COUNT(*) FROM transactions) + (SELECT COUNT(*) FROM audit_log) AS n`
  ).first('n');
  if (existing > 0) {
    throw new ApiError(409, 'RESTORE_NOT_EMPTY', '이미 데이터가 있는 곳에는 복구할 수 없습니다. 새로 설치한(빈) 프로그램에서만 복구할 수 있습니다.');
  }
  if (url.searchParams.get('dryRun') === '1') return json({ ok: true, dryRun: true, summary });

  await db.batch([
    ...restoreStatements(db, backup.tables),
    db.prepare(`INSERT INTO backup_log (at, actor, action, summary) VALUES (?, ?, 'RESTORE', ?)`)
      .bind(new Date().toISOString(), actor.email, JSON.stringify({ from: backup.exportedAt, checksum: backup.checksum, counts: summary.counts })),
  ]);
  return json({ ok: true, summary });
}
