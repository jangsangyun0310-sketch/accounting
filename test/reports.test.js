import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, d1Adapter, accountId, subjectId, worker } from './helpers.js';

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

test('일일 결산서: 요약·수입·지출·이체·통장별 잔액, 삭제한 거래 제외', async () => {
  const { api, tx } = setup();
  await tx('IN', '주일학교 예치금', '후원금', 70000, '주일학교 후원');
  await tx('IN', '교무금', '교무금', 300000, '홍길동');
  await tx('OUT', '경상비', '관리운영비', 50000, '소모품');
  const { body: { id } } = await tx('OUT', '경상비', '전례비', 9999, '중복');
  await api('DELETE', `/api/transactions/${id}`);
  await api('POST', '/api/transfers', {
    date: '2026-10-02', fromAccountId: 1, toAccountId: 7, amount: '1000000', memo: '적립', voucherNo: 'T-1',
  });

  const r = (await api('GET', '/api/reports/daily?date=2026-10-02')).body;
  assert.equal(r.parishName, '예시성당');
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

  const g = r.funds.find((f) => f.code === 'GENERAL');
  assert.deepEqual([g.prev, g.income, g.expense, g.transferIn, g.transferOut, g.end],
    [11800000, 300000, 50000, 0, 1000000, 11050000]);
  assert.deepEqual([r.total.prev, r.total.income, r.total.expense, r.total.end], [28800000, 370000, 50000, 29120000]);
  assert.equal(r.accounts.find((a) => a.name === '장기수선 예치금').end, 7000000);
});

test('마감된 날: 마감 당시 결재선·작성자 사용, 검증 결과 포함', async () => {
  const { api, tx } = setup();
  await tx('IN', '교무금', '교무금', 1000);
  await api('POST', '/api/closings/2026-10-02/close', { writerName: '홍길동' });
  await api('PUT', '/api/approval-steps', { titles: ['담당', '신부'] });
  await api('PUT', '/api/settings/parish', { parishName: '예시성당', startDate: '2026-10-01', writerName: '김사무' });

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
  assert.equal(p.total.prev, 28801000);
  assert.deepEqual(p.income.rows, []);
});

test('잘못된 날짜 거부', async () => {
  const { api } = setup();
  assert.equal((await api('GET', '/api/reports/daily?date=2026-02-30')).status, 400);
});

test('월말결산: 기초·기말 잔액, 과목별 합계(회계별), 일자별 현황, 마감 여부', async () => {
  const { api, tx, db } = setup();
  await tx('IN', '교무금', '교무금', 300000, '홍길동');               // 10/02 일반
  await tx('IN', '주일학교 예치금', '후원금', 70000);                  // 10/02 특별
  await tx('OUT', '경상비', '관리운영비', 50000);                       // 10/02
  await api('POST', '/api/transactions', {                             // 10/05 일반 후원금
    date: '2026-10-05', direction: 'IN', accountId: accountId(db, '기타 후원금'), subjectId: subjectId(db, 'INCOME', '후원금'), amount: '1000',
  });
  await api('POST', '/api/transfers', { date: '2026-10-05', fromAccountId: 1, toAccountId: 7, amount: '500000' });
  await api('POST', '/api/transactions', {                             // 11월은 제외되어야 함
    date: '2026-11-01', direction: 'IN', accountId: accountId(db, '교무금'), subjectId: subjectId(db, 'INCOME', '교무금'), amount: '9',
  });

  const r = (await api('GET', '/api/reports/period?type=month&month=2026-10')).body;
  assert.equal(r.from, '2026-10-01');
  assert.equal(r.to, '2026-10-31');
  assert.equal(r.status, 'PROVISIONAL');
  assert.deepEqual([r.total.prev, r.total.income, r.total.expense, r.total.transferIn - r.total.transferOut, r.total.end],
    [28800000, 371000, 50000, 0, 29121000]);
  const g = r.funds.find((f) => f.code === 'GENERAL');
  assert.deepEqual([g.prev, g.transferOut, g.end], [11800000, 500000, 11800000 + 301000 - 50000 - 500000]);
  // 후원금은 일반·특별 양쪽에 있음
  assert.deepEqual(r.income.rows.map((x) => [x.name, x.GENERAL, x.SPECIAL, x.total]),
    [['교무금', 300000, 0, 300000], ['후원금', 1000, 70000, 71000]]);
  assert.equal(r.income.total, 371000);
  assert.deepEqual(r.expense.rows.map((x) => [x.name, x.total]), [['관리운영비', 50000]]);
  // 일자별: 이체만 있는 날은 수입·지출이 없으므로 10/05 는 후원금 1,000 만
  assert.deepEqual(r.breakdown.map((x) => [x.key, x.income, x.expense, x.balance]),
    [['2026-10-02', 370000, 50000, 29120000], ['2026-10-05', 1000, 0, 29121000]]);

  await api('POST', '/api/closings/2026-10-02/close', {});
  assert.equal((await api('GET', '/api/reports/period?type=month&month=2026-10')).body.status, 'PROVISIONAL');
});

test('연말결산: 월별 현황, 2월 말일 계산, 잘못된 입력 거부', async () => {
  const { api, tx, db } = setup();
  await tx('IN', '교무금', '교무금', 1000);
  await api('POST', '/api/transactions', {
    date: '2026-11-15', direction: 'OUT', accountId: accountId(db, '경상비'), subjectId: subjectId(db, 'EXPENSE', '인건비'), amount: '400',
  });
  const y = (await api('GET', '/api/reports/period?type=year&year=2026')).body;
  assert.deepEqual([y.from, y.to], ['2026-01-01', '2026-12-31']);
  assert.deepEqual(y.breakdown.map((x) => [x.key, x.income, x.expense, x.balance]),
    [['2026-10', 1000, 0, 28801000], ['2026-11', 0, 400, 28800600]]);
  assert.equal((await api('GET', '/api/reports/period?type=month&month=2027-02')).body.to, '2027-02-28');
  assert.equal((await api('GET', '/api/reports/period?type=month&month=2028-02')).body.to, '2028-02-29');
  assert.equal((await api('GET', '/api/reports/period?type=month&month=2026-13')).status, 400);
  assert.equal((await api('GET', '/api/reports/period?type=week')).status, 400);
});

test('자동 마감된 날(거래 없음)의 일일 결산서는 가결산이 아니라 마감 결산서', async () => {
  const { api, tx } = setup();
  await tx('IN', '교무금', '교무금', 300000, '홍길동'); // 10-02 거래
  // 10-01 은 거래 없음 → 10-02 를 마감하면 함께 잠긴다
  assert.equal((await api('POST', '/api/closings/2026-10-02/close', {})).status, 200);
  await api('PUT', '/api/approval-steps', { titles: ['담당', '신부'] }); // 마감 뒤 결재선을 바꿔도

  const auto = (await api('GET', '/api/reports/daily?date=2026-10-01')).body;
  assert.equal(auto.status, 'CLOSED');
  assert.equal(auto.autoClosedBy, '2026-10-02');
  const own = (await api('GET', '/api/reports/daily?date=2026-10-02')).body;
  assert.equal(own.autoClosedBy, null);
  assert.deepEqual(auto.approvalSteps, own.approvalSteps); // 함께 마감한 날의 결재선
  assert.equal(auto.verification, null);
  assert.equal(auto.total.end, own.total.prev); // 거래가 없으니 다음 날 전일잔액과 같다

  const after = (await api('GET', '/api/reports/daily?date=2026-10-03')).body; // 마감 이후 날짜는 그대로 가결산
  assert.equal(after.status, 'PROVISIONAL');
  assert.equal(after.autoClosedBy, null);
});
