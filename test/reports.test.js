import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createDb, d1Adapter, accountId, subjectId } from './helpers.js';

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
  const tx = (direction, account, subject, amount, memo = '') => api('POST', '/api/transactions', {
    date: '2026-10-02', direction, accountId: accountId(db, account),
    subjectId: subjectId(db, direction === 'IN' ? 'INCOME' : 'EXPENSE', subject), amount: String(amount), memo,
  });
  return { db, api, tx };
}

test('일일 결산서: 요약·수입·지출·이체·통장별 잔액, 취소 거래 제외', async () => {
  const { api, tx } = setup();
  await tx('IN', '주일학교 예치금', '후원금', 70000, '주일학교 후원');
  await tx('IN', '교무금', '교무금', 300000, '홍길동');
  await tx('OUT', '경상비', '관리운영비', 50000, '소모품');
  const { body: { id } } = await tx('OUT', '경상비', '전례비', 9999, '중복');
  await api('POST', `/api/transactions/${id}/void`, { reason: '중복 입력' });
  await api('POST', '/api/transfers', {
    date: '2026-10-02', fromAccountId: 1, toAccountId: 7, amount: '1000000', memo: '적립', voucherNo: 'T-1',
  });

  const r = (await api('GET', '/api/reports/daily?date=2026-10-02')).body;
  assert.equal(r.parishName, '용머리성당');
  assert.equal(r.status, 'PROVISIONAL');
  assert.equal(r.writerName, '사무장');
  assert.deepEqual(r.approvalSteps, ['기안', '재정부회장', '사목회장', '주임신부']);
  // 수입은 일반회계 먼저
  assert.deepEqual(r.income.rows.map((x) => [x.fundCode, x.accountName, x.amount]),
    [['GENERAL', '교무금', 300000], ['SPECIAL', '주일학교 예치금', 70000]]);
  assert.equal(r.income.total, 370000);
  assert.deepEqual(r.expense.rows.map((x) => x.memo), ['소모품']);
  assert.equal(r.expense.total, 50000);
  assert.deepEqual(r.transfers.rows.map((x) => [x.fromName, x.toName, x.amount, x.voucherNo]),
    [['경상비', '장기수선 예치금', 1000000, 'T-1']]);
  assert.equal(r.voidedCount, 1);

  const g = r.funds.find((f) => f.code === 'GENERAL');
  assert.deepEqual([g.prev, g.income, g.expense, g.transferIn, g.transferOut, g.end],
    [33600000, 300000, 50000, 0, 1000000, 32850000]);
  assert.deepEqual([r.total.prev, r.total.income, r.total.expense, r.total.end], [66600000, 370000, 50000, 66920000]);
  assert.equal(r.accounts.find((a) => a.name === '장기수선 예치금').end, 13000000);
});

test('마감된 날: 마감 당시 결재선·작성자 사용, 검증 결과 포함', async () => {
  const { api, tx } = setup();
  await tx('IN', '교무금', '교무금', 1000);
  await api('POST', '/api/closings/2026-10-02/close', { writerName: '홍길동' });
  await api('PUT', '/api/approval-steps', { titles: ['담당', '신부'] });
  await api('PUT', '/api/settings/parish', { parishName: '용머리성당', startDate: '2026-10-01', writerName: '김사무' });

  const r = (await api('GET', '/api/reports/daily?date=2026-10-02')).body;
  assert.equal(r.status, 'CLOSED');
  assert.equal(r.writerName, '홍길동');
  assert.deepEqual(r.approvalSteps, ['기안', '재정부회장', '사목회장', '주임신부']);
  assert.equal(r.verification.ok, true);
  assert.ok(r.closedAt);

  // 미마감 날은 현재 설정
  const p = (await api('GET', '/api/reports/daily?date=2026-10-03')).body;
  assert.equal(p.status, 'PROVISIONAL');
  assert.equal(p.writerName, '김사무');
  assert.deepEqual(p.approvalSteps, ['담당', '신부']);
  assert.equal(p.total.prev, 66601000);
  assert.deepEqual(p.income.rows, []);
});

test('잘못된 날짜 거부', async () => {
  const { api } = setup();
  assert.equal((await api('GET', '/api/reports/daily?date=2026-02-30')).status, 400);
});
