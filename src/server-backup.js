// 서버 자동 백업 (매일 새벽 3시, wrangler.jsonc 의 triggers.crons)
//   모든 성당의 장부 저장소에 "백업 DB 에 너의 장부를 넣어라"를 차례로 부탁하고, 30일 지난 백업은 지운다.
//   압축·저장은 각 성당 저장소(src/ledger.js)가 한다. 성당 화면의 '마지막 백업' 기록과는 따로다.
import { addDays, todayKST } from '../public/js/shared/dates.js';

export const KEEP_DAYS = 30;

export async function runServerBackups(env, date = todayKST()) {
  const { results: parishes } = await env.DB.prepare('SELECT id FROM parishes ORDER BY created_at').all();
  const summary = { date, ok: 0, skipped: 0, failed: [] };
  for (const { id } of parishes) {
    try {
      const stub = env.LEDGER.get(env.LEDGER.idFromName(id));
      const res = await stub.fetch(new Request(
        `https://ledger/__admin/server-backup?parish=${encodeURIComponent(id)}&date=${date}`, { method: 'POST' }));
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
      if (body.skipped) summary.skipped++; else summary.ok++;
    } catch (err) {
      summary.failed.push({ parish: id, error: String(err?.message ?? err) });
    }
  }
  // 오래된 백업 지우기 (탈퇴한 성당 것도 30일이 지나면 함께 지워진다)
  const before = addDays(date, -KEEP_DAYS);
  await env.BACKUPS.batch([
    env.BACKUPS.prepare('DELETE FROM ledger_backup_chunks WHERE backup_date < ?').bind(before),
    env.BACKUPS.prepare('DELETE FROM ledger_backups WHERE backup_date < ?').bind(before),
  ]);
  console.log('server backup', JSON.stringify(summary));
  return summary;
}
