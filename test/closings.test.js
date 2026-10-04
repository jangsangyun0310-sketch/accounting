import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, d1Adapter, accountId, subjectId, worker } from './helpers.js';

// 오늘 = 2026-10-04 로 고정 (todayKST 가 Date 를 쓰므로 Date.now 를 고정)
const FIXED_NOW = Date.parse('2026-10-04T03:00:00Z');
const realNow = Date.now;
Date.now = () => FIXED_NOW;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [FIXED_NOW])); }
  static now() { return FIXED_NOW; }
};
process.on('exit', () => { globalThis.Date = RealDate; Date.now = realNow; });

function setup() {
  const db = createDb();
  const env = { DB: d1Adapter(db), AUTH_MODE: 'dev', DEV_USER: 'office@test' };
  const api = async (method, path, body) => {
    const res = await worker.fetch(new Request(`http://local${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }), env);
    return { status: res.status, body: await res.json() };
  };
  const income = (date, amount, account = '교무금') => api('POST', '/api/transactions', {
    date, direction: 'IN', accountId: accountId(db, account), subjectId: subjectId(db, 'INCOME', '교무금'), amount: String(amount),
  });
  return { db, api, income };
}

test('마감: 결재선·잔액 스냅샷 저장, 이력 기록, 이후 입력 차단', async () => {
  const { db, api, income } = setup();
  await income('2026-10-02', 1000);
  let r = await api('POST', '/api/closings/2026-10-02/close', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const d = (await api('GET', '/api/closings/2026-10-02')).body;
  assert.equal(d.closing.status, 'CLOSED');
  assert.deepEqual(d.closing.approvalSteps, ['기안', '재정부회장', '사목회장', '주임신부']);
  assert.equal(d.closing.writerName, '사무장');
  assert.equal(d.closing.balances.find((b) => b.name === '교무금').balance, 1001000);
  assert.equal(d.closing.balances.length, 9);
  assert.equal(d.verification.ok, true);
  assert.deepEqual(d.events.map((e) => [e.action, e.actor]), [['CLOSE', 'office@test']]);

  r = await income('2026-10-02', 5);
  assert.equal(r.body.error.code, 'DATE_CLOSED');
  r = await api('POST', '/api/closings/2026-10-02/close', {});
  assert.equal(r.body.error.code, 'ALREADY_CLOSED');

  // 결재선을 바꿔도 마감된 날의 스냅샷은 그대로
  await api('PUT', '/api/approval-steps', { titles: ['담당', '신부'] });
  assert.deepEqual((await api('GET', '/api/closings/2026-10-02')).body.closing.approvalSteps,
    ['기안', '재정부회장', '사목회장', '주임신부']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM closing_events').get().n, 1);
});

test('마감 순서: 앞 날짜 미마감 거래가 있으면 거부, 미래 날짜 거부, 개시일 이전 거부', async () => {
  const { api, income } = setup();
  await income('2026-10-02', 1000);
  await income('2026-10-03', 1000);
  let r = await api('POST', '/api/closings/2026-10-03/close', {});
  assert.equal(r.body.error.code, 'CLOSE_ORDER');
  r = await api('POST', '/api/closings/2026-10-05/close', {});
  assert.equal(r.body.error.code, 'FUTURE_DATE');
  r = await api('POST', '/api/closings/2026-09-30/close', {});
  assert.equal(r.body.error.code, 'BEFORE_START_DATE');

  const cal = (await api('GET', '/api/closings?month=2026-10')).body;
  assert.equal(cal.nextRequired, '2026-10-02');
  assert.equal(cal.closableUntil, '2026-10-02');
  const day = (d) => cal.days.find((x) => x.date === d);
  assert.equal(day('2026-10-01').canClose, true); // 거래 없는 앞 날짜는 가능
  assert.equal(day('2026-10-02').canClose, true);
  assert.equal(day('2026-10-03').canClose, false);
  assert.equal(day('2026-10-05').status, 'future');
  assert.equal(cal.days.length, 31);
});

test('마감취소: 마지막 마감일만, 메모 선택, 재마감 시 새 스냅샷', async () => {
  const { api, income } = setup();
  await income('2026-10-02', 1000);
  await api('POST', '/api/closings/2026-10-02/close', {});
  await income('2026-10-03', 2000);
  await api('POST', '/api/closings/2026-10-03/close', { writerName: '김사무' });

  let r = await api('POST', '/api/closings/2026-10-02/reopen', { reason: '정정' });
  assert.equal(r.body.error.code, 'REOPEN_NOT_LATEST');
  // 메모는 선택: 비워도 마감취소되고, 내부 기록에는 '메모 없음'
  r = await api('POST', '/api/closings/2026-10-03/reopen', {});
  assert.equal(r.status, 200);
  r = await api('POST', '/api/closings/2026-10-03/reopen', { reason: '또' });
  assert.equal(r.body.error.code, 'NOT_CLOSED');

  // 마감취소 후 수정 가능
  r = await income('2026-10-03', 500);
  assert.equal(r.status, 201);
  let cal = (await api('GET', '/api/closings?month=2026-10')).body;
  assert.equal(cal.days.find((x) => x.date === '2026-10-03').status, 'reopened');
  assert.equal(cal.days.find((x) => x.date === '2026-10-02').canReopen, true);

  r = await api('POST', '/api/closings/2026-10-03/close', {});
  assert.equal(r.status, 200);
  const d = (await api('GET', '/api/closings/2026-10-03')).body;
  assert.equal(d.closing.balances.find((b) => b.name === '교무금').balance, 1003500);
  assert.equal(d.closing.writerName, '사무장'); // 재마감은 기본 작성자
  assert.deepEqual(d.events.map((e) => e.action), ['CLOSE', 'REOPEN', 'CLOSE']);
  assert.equal(d.events[1].reason, '메모 없음');

  const log = (await api('GET', '/api/closing-events')).body.events;
  assert.deepEqual(log.map((e) => `${e.close_date} ${e.action}`),
    ['2026-10-03 CLOSE', '2026-10-03 REOPEN', '2026-10-03 CLOSE', '2026-10-02 CLOSE']);
  cal = (await api('GET', '/api/closings?month=2026-10')).body;
  assert.equal(cal.lastClosed, '2026-10-03');
});

test('뒤 날짜 마감은 거래 없는 앞 날짜를 함께 잠근다', async () => {
  const { api, income } = setup();
  await api('POST', '/api/closings/2026-10-03/close', {});
  const cal = (await api('GET', '/api/closings?month=2026-10')).body;
  assert.equal(cal.days.find((x) => x.date === '2026-10-01').status, 'locked');
  const r = await income('2026-10-01', 1);
  assert.equal(r.body.error.code, 'DATE_CLOSED');
});

test('스냅샷 검증: 마감 후 잔액이 달라지면 불일치로 표시', async () => {
  const { db, api, income } = setup();
  await income('2026-10-02', 1000);
  await api('POST', '/api/closings/2026-10-02/close', {});
  // 트리거를 우회한 직접 조작을 흉내 (실제로는 불가능해야 하는 상황)
  db.exec('DROP TRIGGER trg_accounts_bu_opening');
  db.exec("UPDATE accounts SET opening_balance = opening_balance + 1 WHERE name = '경상비'");
  const v = (await api('GET', '/api/closings/2026-10-02')).body.verification;
  assert.equal(v.ok, false);
  assert.deepEqual(v.mismatches.map((m) => [m.name, m.snapshot, m.current]), [['경상비', 10000000, 10000001]]);
});

test('마감 후 통장 보호: 새 통장 초기잔액 0 만, 초기잔액 있는 통장 삭제 불가, 개시일 변경 불가', async () => {
  const { api } = setup();
  await api('POST', '/api/closings/2026-10-01/close', {});
  let r = await api('POST', '/api/accounts', { fundCode: 'GENERAL', name: '새통장', openingBalance: '1000' });
  assert.equal(r.body.error.code, 'OPENING_LOCKED_NEW');
  r = await api('POST', '/api/accounts', { fundCode: 'GENERAL', name: '새통장', openingBalance: '0' });
  assert.equal(r.status, 201);
  const accounts = (await api('GET', '/api/settings')).body.accounts;
  r = await api('DELETE', `/api/accounts/${accounts.find((a) => a.name === '제대 후원금').id}`);
  assert.equal(r.body.error.code, 'OPENING_LOCKED_DELETE');
  r = await api('DELETE', `/api/accounts/${accounts.find((a) => a.name === '새통장').id}`);
  assert.equal(r.status, 200);
  r = await api('PUT', '/api/settings/parish', { parishName: '예시성당', startDate: '2026-09-01', writerName: '' });
  assert.equal(r.body.error.code, 'START_DATE_LOCKED');
});
