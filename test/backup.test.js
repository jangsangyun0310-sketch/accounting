import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createDb, d1Adapter, accountId, subjectId } from './helpers.js';
import { TABLES, sha256Hex } from '../public/core/lib/backup.js';

function client(db) {
  const env = { DB: d1Adapter(db), AUTH_MODE: 'open' };
  return async (method, path, body) => {
    const res = await worker.fetch(new Request(`http://local${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }), env);
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
}

/** 삭제·수정·이체·사용중지·마감·마감취소·내부기록이 모두 있는 DB */
async function richDb() {
  const db = createDb();
  const api = client(db);
  const tx = (date, direction, account, subject, amount, memo = '') => api('POST', '/api/transactions', {
    date, direction, accountId: accountId(db, account),
    subjectId: subjectId(db, direction === 'IN' ? 'INCOME' : 'EXPENSE', subject), amount: String(amount), memo,
  });
  await tx('2026-10-01', 'IN', '교무금', '교무금', 300000, '홍길동');
  const { body: wrong } = await tx('2026-10-01', 'OUT', '경상비', '관리운영비', 12000, '오기');
  await api('PUT', `/api/transactions/${wrong.id}`, {
    date: '2026-10-01', direction: 'OUT', accountId: accountId(db, '경상비'),
    subjectId: subjectId(db, 'EXPENSE', '관리운영비'), amount: '120000', memo: '전기요금',
  });
  const { body: tr } = await api('POST', '/api/transfers', { date: '2026-10-01', fromAccountId: 1, toAccountId: 7, amount: '500000' });
  await api('DELETE', `/api/transactions/${tr.ids[0]}`);
  await api('POST', '/api/transfers', { date: '2026-10-01', fromAccountId: 1, toAccountId: 7, amount: '400000', memo: '적립' });
  await api('POST', '/api/closings/2026-10-01/close', {});
  await tx('2026-10-02', 'IN', '제대 후원금', '후원금', 50000);
  await api('POST', '/api/closings/2026-10-02/close', {});
  await api('POST', '/api/closings/2026-10-02/reopen', { reason: '확인 필요' });
  // 거래가 있는 통장·과목을 사용중지
  const accs = (await api('GET', '/api/settings')).body;
  const altar = accs.accounts.find((a) => a.name === '제대 후원금');
  await api('PUT', `/api/accounts/${altar.id}`, { fundCode: 'SPECIAL', name: altar.name, bankName: '', accountNo: '', openingBalance: String(altar.openingBalance), isActive: false });
  const sub = accs.subjects.find((s) => s.name === '관리운영비');
  await api('PUT', `/api/subjects/${sub.id}`, { kind: 'EXPENSE', name: sub.name, isActive: false });
  return { db, api };
}

function dump(db) {
  return Object.fromEntries(TABLES.map((t) => [t.name,
    db.prepare(`SELECT ${t.columns.join(', ')} FROM ${t.name} ORDER BY ${t.order}`).all().map((r) => ({ ...r }))]));
}

test('백업 → 빈 DB 에 복구: 모든 표가 원본과 같고, 잔액·마감 검증 통과', async () => {
  const { db, api } = await richDb();
  const res = await api('GET', '/api/backup');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const backup = res.body;
  assert.equal(backup.format, 'bondang-salim-backup');
  assert.equal(backup.parishName, '예시성당');
  assert.equal(backup.checksum, await sha256Hex(JSON.stringify(backup.tables)));
  assert.equal(backup.counts.transactions, 5); // 수정된 1건 + 삭제된 이체 제외

  const status = (await api('GET', '/api/backup/status')).body;
  assert.ok(status.lastBackupAt);
  assert.equal(status.changesSince, 0);

  const target = createDb({ seed: false });
  const restoreApi = client(target);
  const dry = await restoreApi('POST', '/api/restore?dryRun=1', backup);
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.summary.lastClosed, '2026-10-01');
  assert.equal(target.prepare('SELECT COUNT(*) n FROM transactions').get().n, 0); // 미리보기는 저장 안 함

  const r = await restoreApi('POST', '/api/restore', backup);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const before = dump(db);
  const after = dump(target);
  for (const t of TABLES) {
    if (t.name === 'backup_log') continue; // 복구 기록 1행이 추가됨
    assert.deepEqual(after[t.name], before[t.name], t.name);
  }
  // 백업 파일은 자기 자신의 BACKUP 기록이 쓰이기 전에 만들어지므로, 복구된 DB 에는 RESTORE 기록만 생긴다
  assert.deepEqual(after.backup_log.map((b) => b.action), ['RESTORE']);
  assert.equal(JSON.parse(after.backup_log[0].summary).from, backup.exportedAt);
  assert.equal(target.prepare('SELECT COUNT(*) n FROM restore_session').get().n, 0);

  // 복구된 DB 에서 마감 검증·결산·하루 현황이 그대로 동작
  const closing = (await restoreApi('GET', '/api/closings/2026-10-01')).body;
  assert.equal(closing.verification.ok, true);
  const day = (await restoreApi('GET', '/api/day?date=2026-10-02')).body;
  assert.equal(day.total.end, (await api('GET', '/api/day?date=2026-10-02')).body.total.end);
  // 복구 후에도 마감 통제 그대로
  const blocked = await restoreApi('POST', '/api/transactions', {
    date: '2026-10-01', direction: 'IN', accountId: 2, subjectId: 1, amount: '1',
  });
  assert.equal(blocked.body.error.code, 'DATE_CLOSED');
  // 복구 후 복구 세션 우회는 다시 막힘 (사용중지 통장 거래)
  const inactive = await restoreApi('POST', '/api/transactions', {
    date: '2026-10-03', direction: 'IN', accountId: accountId(target, '제대 후원금'), subjectId: subjectId(target, 'INCOME', '후원금'), amount: '1',
  });
  assert.equal(inactive.body.error.code, 'ACCOUNT_INACTIVE');
});

test('복구 거부: 데이터가 있는 DB, 손상된 파일, 검사값을 맞춘 변조, 다른 파일', async () => {
  const { api } = await richDb();
  const backup = (await api('GET', '/api/backup')).body;

  let r = await api('POST', '/api/restore', backup); // 원본 DB 에 다시 복구
  assert.equal(r.body.error.code, 'RESTORE_NOT_EMPTY');

  const fresh = () => client(createDb({ seed: false }));
  const tampered = structuredClone(backup);
  tampered.tables.transactions[0].amount = 999;
  r = await fresh()('POST', '/api/restore', tampered);
  assert.equal(r.body.error.code, 'BACKUP_INVALID');
  assert.match(r.body.error.message, /검사값/);

  // 검사값까지 다시 계산한 변조 → 마감 잔액 검증에서 걸림
  tampered.checksum = await sha256Hex(JSON.stringify(tampered.tables));
  r = await fresh()('POST', '/api/restore', tampered);
  assert.equal(r.body.error.code, 'BACKUP_INVALID');
  assert.match(r.body.error.message, /마감 잔액/);

  const brokenPair = structuredClone(backup);
  brokenPair.tables.transactions = brokenPair.tables.transactions.filter((t) => !(t.kind === 'TRANSFER' && t.direction === 'IN'));
  brokenPair.checksum = await sha256Hex(JSON.stringify(brokenPair.tables));
  r = await fresh()('POST', '/api/restore', brokenPair);
  assert.match(r.body.error.message, /이체 묶음/);

  r = await fresh()('POST', '/api/restore', { hello: 'world' });
  assert.match(r.body.error.message, /백업 파일이 아닙니다/);
});

test('복구 세션은 데이터가 있으면 열 수 없다 (트리거 우회 방지)', () => {
  const db = createDb();
  assert.throws(() => db.prepare('INSERT INTO restore_session (id) VALUES (1)').run(), /RESTORE_NOT_EMPTY/);
});

test('최초 설정 전에는 백업 불가', async () => {
  const r = await client(createDb({ seed: false }))('GET', '/api/backup');
  assert.equal(r.body.error.code, 'SETUP_REQUIRED');
});

test('예전 백업(취소된 거래 포함)을 복구하면 취소된 거래는 빼고 복구', async () => {
  const { api } = await richDb();
  const backup = (await api('GET', '/api/backup')).body;
  const old = structuredClone(backup);
  const t0 = old.tables.transactions.find((t) => t.kind === 'NORMAL');
  old.tables.transactions.push({ ...t0, id: 900, status: 'VOIDED', void_reason: '예전 취소', voided_at: 'x', voided_by: 'y', memo: '예전' });
  old.tables.transactions.push({ ...t0, id: 901, replaces_id: 900, memo: '예전 수정본', amount: 1 });
  old.tables.transactions = old.tables.transactions.filter((t) => t.id !== 901); // 잔액 검증을 맞추기 위해 수정본은 제외
  old.checksum = await sha256Hex(JSON.stringify(old.tables));
  const target = createDb({ seed: false });
  const r = await client(target)('POST', '/api/restore', old);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(target.prepare("SELECT COUNT(*) n FROM transactions WHERE status <> 'POSTED'").get().n, 0);
  assert.equal(target.prepare('SELECT COUNT(*) n FROM transactions').get().n, backup.counts.transactions);
});
