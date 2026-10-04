import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDb, d1Adapter, insertTx, deleteTx, closeDate, reopenDate, accountId, subjectId,
} from './helpers.js';
import { computeBalances } from '../src/routes/system.js';
import { translateDbError } from '../src/lib/db.js';

const rejects = (fn, code) => assert.throws(fn, (e) => String(e.message).includes(code), `expected ${code}`);

test('초기잔액 합계: 일반 11,800,000 / 특별 17,000,000 / 전체 28,800,000', async () => {
  const db = createDb();
  const b = await computeBalances(d1Adapter(db), '2026-10-01');
  assert.deepEqual(b.funds.map((f) => [f.code, f.balance]), [['GENERAL', 11800000], ['SPECIAL', 17000000]]);
  assert.equal(b.total, 28800000);
  assert.equal(b.accounts.length, 9);
});

test('수입은 잔액 증가, 지출은 감소, 삭제한 거래는 제외', async () => {
  const db = createDb();
  const adapter = d1Adapter(db);
  insertTx(db, { date: '2026-10-04', direction: 'IN', account: '교무금', subject: '교무금', amount: 350000 });
  const out = insertTx(db, { date: '2026-10-04', direction: 'OUT', account: '경상비', subject: '관리운영비', amount: 120000 });
  insertTx(db, { date: '2026-10-05', direction: 'IN', account: '경상비', subject: '주일헌금', amount: 1000 });

  let b = await computeBalances(adapter, '2026-10-04');
  const bal = (name) => b.accounts.find((a) => a.name === name).balance;
  assert.equal(bal('교무금'), 1350000);
  assert.equal(bal('경상비'), 9880000);
  assert.equal(b.total, 28800000 + 350000 - 120000);

  // 전일(10/3) 잔액은 영향 없음, 다음날 거래는 당일 잔액에 미포함
  assert.equal((await computeBalances(adapter, '2026-10-03')).total, 28800000);

  deleteTx(db, out);
  b = await computeBalances(adapter, '2026-10-04');
  assert.equal(bal('경상비'), 10000000);
});

test('금액: 실수·0·음수·문자열 저장 불가', () => {
  const db = createDb();
  for (const amount of [1000.5, 0, -100, '1000.5', 'abc']) {
    assert.throws(() => insertTx(db, { date: '2026-10-04', direction: 'IN', account: '교무금', subject: '교무금', amount }),
      /CHECK constraint failed/, `amount=${amount}`);
  }
  assert.throws(() => db.prepare('UPDATE accounts SET opening_balance = 1.5 WHERE id = 1').run(), /CHECK constraint failed/);
});

test('거래 행은 직접 고칠 수 없다 (수정은 삭제 후 새로 입력), 삭제는 가능', () => {
  const db = createDb();
  const id = insertTx(db, { date: '2026-10-04', direction: 'IN', account: '교무금', subject: '교무금', amount: 1000 });
  rejects(() => db.prepare('UPDATE transactions SET amount = 2000 WHERE id = ?').run(id), 'TX_IMMUTABLE');
  deleteTx(db, id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, 0);
});

test('이체 한쪽을 지우면 반대쪽도 함께 지워진다', () => {
  const db = createDb();
  const ins = db.prepare(
    `INSERT INTO transactions (tx_date, kind, direction, account_id, transfer_group, amount, created_at, created_by)
     VALUES ('2026-10-04', 'TRANSFER', ?, ?, 'g1', 500, 'now', 'test') RETURNING id`);
  ins.get('OUT', accountId(db, '교무금'));
  const inId = ins.get('IN', accountId(db, '경상비')).id;
  deleteTx(db, inId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, 0);
});

test('과목 구분 불일치, 운영 개시일 이전, 비활성 통장 거부', () => {
  const db = createDb();
  rejects(() => db.prepare(
    `INSERT INTO transactions (tx_date, direction, account_id, subject_id, amount, created_at, created_by)
     VALUES ('2026-10-04', 'IN', 1, ?, 1000, 'now', 'test')`).run(subjectId(db, 'EXPENSE', '인건비')), 'SUBJECT_MISMATCH');
  rejects(() => insertTx(db, { date: '2026-09-30', direction: 'IN', account: '교무금', subject: '교무금', amount: 1 }),
    'BEFORE_START_DATE');
  db.prepare("UPDATE accounts SET is_active = 0 WHERE name = '교무금'").run();
  rejects(() => insertTx(db, { date: '2026-10-04', direction: 'IN', account: '교무금', subject: '교무금', amount: 1 }),
    'ACCOUNT_INACTIVE');
});

test('통장 간 이체: 같은 그룹의 OUT/IN 한 쌍, 전체 합계 불변', async () => {
  const db = createDb();
  const ins = db.prepare(
    `INSERT INTO transactions (tx_date, kind, direction, account_id, transfer_group, amount, created_at, created_by)
     VALUES ('2026-10-04', 'TRANSFER', ?, ?, 'g1', 500000, 'now', 'test')`);
  ins.run('OUT', accountId(db, '교무금'));
  ins.run('IN', accountId(db, '경상비'));
  const b = await computeBalances(d1Adapter(db), '2026-10-04');
  assert.equal(b.total, 28800000);
  assert.equal(b.accounts.find((a) => a.name === '경상비').balance, 10500000);
  // 이체에는 과목을 넣을 수 없고, 일반 거래에는 그룹을 넣을 수 없다
  assert.throws(() => db.prepare(
    `INSERT INTO transactions (tx_date, kind, direction, account_id, subject_id, transfer_group, amount, created_at, created_by)
     VALUES ('2026-10-04', 'TRANSFER', 'IN', 1, 1, 'g2', 1, 'now', 'test')`).run(), /CHECK constraint failed/);
});

test('마감: 마감일 이하 거래 입력·삭제 불가, 이후 날짜는 가능', () => {
  const db = createDb();
  const id = insertTx(db, { date: '2026-10-04', direction: 'IN', account: '교무금', subject: '교무금', amount: 1000 });
  closeDate(db, '2026-10-04');
  rejects(() => insertTx(db, { date: '2026-10-04', direction: 'IN', account: '교무금', subject: '교무금', amount: 1 }), 'DATE_CLOSED');
  rejects(() => insertTx(db, { date: '2026-10-02', direction: 'IN', account: '교무금', subject: '교무금', amount: 1 }), 'DATE_CLOSED');
  rejects(() => deleteTx(db, id), 'DATE_CLOSED');
  insertTx(db, { date: '2026-10-05', direction: 'IN', account: '교무금', subject: '교무금', amount: 1 });
});

test('마감 순서: 앞 날짜 미마감 거래가 있으면 뒤 날짜 마감 불가, 앞 날짜 재마감 불가', () => {
  const db = createDb();
  insertTx(db, { date: '2026-10-02', direction: 'IN', account: '교무금', subject: '교무금', amount: 1 });
  rejects(() => closeDate(db, '2026-10-04'), 'CLOSE_ORDER');
  rejects(() => closeDate(db, '2026-10-03'), 'CLOSE_ORDER'); // 거래가 있는 날은 반드시 개별 마감
  closeDate(db, '2026-10-02');
  closeDate(db, '2026-10-04'); // 거래 없는 10/3 은 자동 통과
  rejects(() => closeDate(db, '2026-10-01'), 'ALREADY_LOCKED');
});

test('마감취소: 마지막 마감일부터 역순, 사유 필수, 기록 삭제 불가, 재마감 가능', () => {
  const db = createDb();
  closeDate(db, '2026-10-03');
  closeDate(db, '2026-10-04');
  rejects(() => reopenDate(db, '2026-10-03'), 'REOPEN_NOT_LATEST');
  assert.throws(() => reopenDate(db, '2026-10-04', ''), /CHECK constraint failed/);
  reopenDate(db, '2026-10-04');
  insertTx(db, { date: '2026-10-04', direction: 'IN', account: '교무금', subject: '교무금', amount: 1 });
  rejects(() => db.prepare("DELETE FROM daily_closings WHERE close_date = '2026-10-04'").run(), 'CLOSING_NO_DELETE');
  db.prepare(`UPDATE daily_closings SET status = 'CLOSED' WHERE close_date = '2026-10-04'`).run();
  rejects(() => insertTx(db, { date: '2026-10-04', direction: 'IN', account: '교무금', subject: '교무금', amount: 1 }), 'DATE_CLOSED');
});

test('이력 테이블은 추가만 가능', () => {
  const db = createDb();
  db.prepare(`INSERT INTO closing_events (close_date, action, at, actor) VALUES ('2026-10-04', 'CLOSE', 'now', 't')`).run();
  db.prepare(`INSERT INTO audit_log (at, actor, entity, action) VALUES ('now', 't', 'x', 'CREATE')`).run();
  rejects(() => db.prepare("UPDATE closing_events SET reason = 'x'").run(), 'LOG_IMMUTABLE');
  rejects(() => db.prepare('DELETE FROM closing_events').run(), 'LOG_IMMUTABLE');
  rejects(() => db.prepare("UPDATE audit_log SET actor = 'x'").run(), 'LOG_IMMUTABLE');
  rejects(() => db.prepare('DELETE FROM audit_log').run(), 'LOG_IMMUTABLE');
});

test('설정 보호: 마감 후 초기잔액 변경 불가, 거래 있는 통장·과목 삭제 불가', () => {
  const db = createDb();
  db.prepare("UPDATE accounts SET opening_balance = 100 WHERE name = '제대 후원금'").run(); // 마감 전엔 가능
  insertTx(db, { date: '2026-10-04', direction: 'IN', account: '교무금', subject: '교무금', amount: 1 });
  rejects(() => db.prepare("DELETE FROM accounts WHERE name = '교무금'").run(), 'ACCOUNT_IN_USE');
  rejects(() => db.prepare("UPDATE accounts SET fund_id = 2 WHERE name = '교무금'").run(), 'ACCOUNT_IN_USE');
  rejects(() => db.prepare("DELETE FROM budget_subjects WHERE kind = 'INCOME' AND name = '교무금'").run(), 'SUBJECT_IN_USE');
  rejects(() => db.prepare("UPDATE parish_settings SET start_date = '2026-09-01'").run(), 'START_DATE_LOCKED');
  db.prepare("DELETE FROM accounts WHERE name = '제대 후원금'").run(); // 거래 없는 통장은 삭제 가능
  closeDate(db, '2026-10-04');
  rejects(() => db.prepare("UPDATE accounts SET opening_balance = 1 WHERE name = '경상비'").run(), 'OPENING_LOCKED');
});

test('DB 오류 코드 → 한국어 메시지 번역', () => {
  const e = translateDbError(new Error('D1_ERROR: DATE_CLOSED: SQLITE_CONSTRAINT'));
  assert.equal(e.status, 409);
  assert.equal(e.code, 'DATE_CLOSED');
  assert.throws(() => translateDbError(new Error('network down')), /network down/);
});

test('0007 마이그레이션: 기존 취소 기록 정리, 유효 거래·잔액·마감 스냅샷은 그대로', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync, readdirSync } = await import('node:fs');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const files = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
  for (const f of files.filter((x) => x < '0007')) db.exec(readFileSync(`migrations/${f}`, 'utf8'));
  db.exec(readFileSync('seed/dev-sample.sql', 'utf8'));
  // 예전 방식: 취소(VOIDED), 수정(원본 취소 + replaces_id), 이체 취소
  const ins = (amount, extra = '') => db.prepare(
    `INSERT INTO transactions (tx_date, direction, account_id, subject_id, amount, created_at, created_by ${extra ? ', replaces_id' : ''})
     VALUES ('2026-10-02', 'IN', 2, 1, ?, 'now', 't' ${extra ? ', ?' : ''}) RETURNING id`);
  const voidIt = (id) => db.prepare(
    `UPDATE transactions SET status='VOIDED', void_reason='x', voided_at='now', voided_by='t' WHERE id=?`).run(id);
  const keep = ins(1000).get(1000).id;
  const orig = ins(5000).get(5000).id;
  voidIt(orig);
  const repl = ins(7000, 'r').get(7000, orig).id;
  db.prepare(`INSERT INTO daily_closings (close_date, status, approval_snapshot, balance_snapshot, writer_name, closed_at, closed_by)
    SELECT '2026-10-02', 'CLOSED', '[]', json_group_array(json_object('id', id, 'name', name, 'fundCode', 'X', 'balance', opening_balance +
      COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.account_id = a.id AND t.status = 'POSTED'), 0))), 's', 'now', 't' FROM accounts a`).run();
  const before = await computeBalances(d1Adapter(db), '2026-10-02');

  db.exec(readFileSync('migrations/0007_delete_instead_of_void.sql', 'utf8'));

  const rows = db.prepare('SELECT id, status, replaces_id FROM transactions ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ id: keep, status: 'POSTED', replaces_id: null }, { id: repl, status: 'POSTED', replaces_id: null }]);
  assert.deepEqual((await computeBalances(d1Adapter(db), '2026-10-02')).accounts, before.accounts);
  // 마감된 날짜는 이제 삭제도 막힌다
  rejects(() => db.prepare('DELETE FROM transactions WHERE id = ?').run(keep), 'DATE_CLOSED');
});
