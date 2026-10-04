import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDb, d1Adapter, insertTx, voidTx, closeDate, reopenDate, accountId, subjectId,
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

test('수입은 잔액 증가, 지출은 감소, 취소 거래는 제외', async () => {
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

  voidTx(db, out);
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

test('거래 내용 직접 수정·삭제 불가, 취소만 가능, 취소 후 되살리기 불가', () => {
  const db = createDb();
  const id = insertTx(db, { date: '2026-10-04', direction: 'IN', account: '교무금', subject: '교무금', amount: 1000 });
  rejects(() => db.prepare('UPDATE transactions SET amount = 2000 WHERE id = ?').run(id), 'TX_IMMUTABLE');
  rejects(() => db.prepare('DELETE FROM transactions WHERE id = ?').run(id), 'TX_NO_DELETE');
  rejects(() => db.prepare(
    `UPDATE transactions SET status='VOIDED', voided_at='x', voided_by='t', void_reason='', amount=1 WHERE id=?`).run(id),
  'TX_IMMUTABLE');
  // 사유 없는 취소는 CHECK 위반
  assert.throws(() => db.prepare(
    `UPDATE transactions SET status='VOIDED', voided_at='x', voided_by='t', void_reason=' ' WHERE id=?`).run(id),
  /CHECK constraint failed/);
  voidTx(db, id);
  rejects(() => db.prepare(`UPDATE transactions SET status='POSTED', voided_at=NULL, voided_by=NULL WHERE id=?`).run(id),
    'TX_IMMUTABLE');
});

test('수정 = 원본 취소 후 replaces_id 로 새 거래 (원본이 취소되지 않았으면 거부)', () => {
  const db = createDb();
  const orig = insertTx(db, { date: '2026-10-04', direction: 'IN', account: '교무금', subject: '교무금', amount: 1000 });
  const insertReplacement = () => db.prepare(
    `INSERT INTO transactions (tx_date, direction, account_id, subject_id, amount, replaces_id, created_at, created_by)
     VALUES ('2026-10-04', 'IN', ?, ?, 10000, ?, 'now', 'test')`
  ).run(accountId(db, '교무금'), subjectId(db, 'INCOME', '교무금'), orig);
  rejects(insertReplacement, 'REPLACES_NOT_VOIDED');
  voidTx(db, orig, '금액 오기');
  insertReplacement();
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

test('마감: 마감일 이하 거래 입력·취소 불가, 이후 날짜는 가능', () => {
  const db = createDb();
  const id = insertTx(db, { date: '2026-10-04', direction: 'IN', account: '교무금', subject: '교무금', amount: 1000 });
  closeDate(db, '2026-10-04');
  rejects(() => insertTx(db, { date: '2026-10-04', direction: 'IN', account: '교무금', subject: '교무금', amount: 1 }), 'DATE_CLOSED');
  rejects(() => insertTx(db, { date: '2026-10-02', direction: 'IN', account: '교무금', subject: '교무금', amount: 1 }), 'DATE_CLOSED');
  rejects(() => voidTx(db, id), 'DATE_CLOSED');
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
