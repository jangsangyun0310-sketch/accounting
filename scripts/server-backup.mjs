// 운영자용: 서버 자동 백업 꺼내기
//   node scripts/server-backup.mjs list                        성당별 백업 목록 (최근 날짜·건수)
//   node scripts/server-backup.mjs get <성당ID> <YYYY-MM-DD>    그날 백업을 .json 파일로 저장
// 꺼낸 .json 파일은 성당 화면의 최초 설정 → [예전 장부 가져오기]로 되살린다
// (이미 쓰는 장부라면 먼저 설정 → 초기화 / 탈퇴 → 장부 초기화).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

function d1(database, sql) {
  // 셸을 거치지 않고 wrangler 를 바로 실행 (윈도에서 SQL 이 쪼개지지 않게)
  const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const out = execFileSync(process.execPath, [wrangler, 'd1', 'execute', database, LOCAL ? '--local' : '--remote', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 1 << 30 });
  return JSON.parse(out.slice(out.indexOf('['))).flatMap((r) => r.results);
}
const LOCAL = process.argv.includes('--local'); // 내 컴퓨터의 시험용 DB
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

const [cmd, parishId, date, outArg] = process.argv.slice(2).filter((a) => a !== '--local');
if (cmd === 'list') {
  const names = new Map(d1('bondang-salim-main', 'SELECT id, name FROM parishes').map((p) => [p.id, p.name]));
  const rows = d1('bondang-salim-backups',
    'SELECT parish_id, COUNT(*) AS n, MIN(backup_date) AS first, MAX(backup_date) AS last FROM ledger_backups GROUP BY parish_id');
  for (const r of rows) console.log(`${r.parish_id}  ${names.get(r.parish_id) ?? '(탈퇴한 성당)'}  ${r.first} ~ ${r.last} (${r.n}개)`);
  if (!rows.length) console.log('아직 서버 백업이 없습니다.');
} else if (cmd === 'get' && parishId && /^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  const [meta] = d1('bondang-salim-backups',
    `SELECT checksum, chunks FROM ledger_backups WHERE parish_id = ${quote(parishId)} AND backup_date = ${quote(date)}`);
  if (!meta) throw new Error('그 날짜의 백업이 없습니다. list 로 날짜를 확인하세요.');
  const chunks = d1('bondang-salim-backups',
    `SELECT seq, hex(data) AS h FROM ledger_backup_chunks WHERE parish_id = ${quote(parishId)} AND backup_date = ${quote(date)} ORDER BY seq`);
  if (chunks.length !== meta.chunks) throw new Error('백업 조각이 모자랍니다.');
  const json = gunzipSync(Buffer.concat(chunks.map((c) => Buffer.from(c.h, 'hex')))).toString('utf8');
  const backup = JSON.parse(json);
  const sum = createHash('sha256').update(JSON.stringify(backup.tables)).digest('hex');
  if (sum !== backup.checksum || sum !== meta.checksum) throw new Error('검사값이 맞지 않습니다. 백업이 손상되었습니다.');
  const out = outArg ?? `본당살림-서버백업-${backup.parishName || parishId}-${date}.json`;
  writeFileSync(out, json);
  console.log(`저장했습니다: ${out} (${Object.entries(backup.counts).map(([k, v]) => `${k} ${v}`).join(', ')})`);
} else {
  console.log('사용법: node scripts/server-backup.mjs list | get <성당ID> <YYYY-MM-DD> [저장할 파일]');
}
