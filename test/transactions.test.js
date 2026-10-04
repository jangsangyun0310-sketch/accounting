import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createDb, d1Adapter, accountId, subjectId, closeDate } from './helpers.js';
import { nextVoucher } from '../public/js/shared/voucher.js';

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
  const acc = (name) => accountId(db, name);
  const sub = (kind, name) => subjectId(db, kind, name);
  return { db, api, acc, sub };
}

const fund = (day, code) => day.funds.find((f) => f.code === code);

test('수입·지출 입력 → 하루 현황 집계와 잔액', async () => {
  const { api, acc, sub } = setup();
  let r = await api('POST', '/api/transactions', {
    date: '2026-10-04', direction: 'IN', accountId: acc('교무금'), subjectId: sub('INCOME', '교무금'),
    amount: '350,000', memo: '홍길동 10월 교무금', voucherNo: '2026-001',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(Number.isInteger(r.body.id));
  r = await api('POST', '/api/transactions', {
    date: '2026-10-04', direction: 'OUT', accountId: acc('경상비'), subjectId: sub('EXPENSE', '관리운영비'),
    amount: '120000', memo: '전기요금',
  });
  assert.equal(r.status, 201);

  const day = (await api('GET', '/api/day?date=2026-10-04')).body;
  const g = fund(day, 'GENERAL');
  assert.deepEqual([g.prev, g.income, g.expense, g.end], [11800000, 350000, 120000, 12030000]);
  assert.deepEqual([day.total.prev, day.total.end], [28800000, 29030000]);
  assert.equal(day.transactions.length, 2);
  assert.equal(day.transactions[0].subjectName, '교무금');
  assert.equal(day.transactions[0].fundCode, 'GENERAL');
  assert.equal(day.locked, false);
  // 다음날 전일잔액 = 오늘 당일잔액
  const next = (await api('GET', '/api/day?date=2026-10-05')).body;
  assert.equal(next.total.prev, 29030000);
});

test('입력 검증: 금액·과목 구분·통장', async () => {
  const { api, acc, sub } = setup();
  const base = { date: '2026-10-04', direction: 'IN', accountId: acc('교무금'), subjectId: sub('INCOME', '교무금'), amount: '1000' };
  const cases = [
    [{ amount: '1000.5' }, 'BAD_AMOUNT'],
    [{ amount: '0' }, 'BAD_AMOUNT'],
    [{ subjectId: sub('EXPENSE', '인건비') }, 'SUBJECT_MISMATCH'],
    [{ accountId: 9999 }, 'ACCOUNT_INACTIVE'],
    [{ date: '2026-09-30' }, 'BEFORE_START_DATE'],
    [{ direction: 'X' }, 'INVALID_INPUT'],
  ];
  for (const [patch, code] of cases) {
    const r = await api('POST', '/api/transactions', { ...base, ...patch });
    assert.equal(r.body.error?.code, code, JSON.stringify(patch));
  }
});

test('통장 간 이체: 회계 간 이동은 회계별 잔액만 바뀌고 전체는 불변', async () => {
  const { api, acc } = setup();
  const r = await api('POST', '/api/transfers', {
    date: '2026-10-04', fromAccountId: acc('경상비'), toAccountId: acc('장기수선 예치금'), amount: '1,000,000', memo: '적립',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.ids.length, 2);
  const day = (await api('GET', '/api/day?date=2026-10-04')).body;
  const g = fund(day, 'GENERAL');
  const s = fund(day, 'SPECIAL');
  assert.deepEqual([g.income, g.expense, g.transferOut, g.end], [0, 0, 1000000, 10800000]);
  assert.deepEqual([s.transferIn, s.end], [1000000, 18000000]);
  assert.equal(day.total.end, 28800000);
  const out = day.transactions.find((t) => t.direction === 'OUT');
  assert.equal(out.counterpartName, '장기수선 예치금');

  const same = await api('POST', '/api/transfers', {
    date: '2026-10-04', fromAccountId: acc('경상비'), toAccountId: acc('경상비'), amount: '1',
  });
  assert.equal(same.status, 400);
});

test('삭제: 흔적 없이 지워지고 잔액에서 제외, 이체는 한 쌍 모두 삭제', async () => {
  const { api, acc, sub, db } = setup();
  const { body: { id } } = await api('POST', '/api/transactions', {
    date: '2026-10-04', direction: 'IN', accountId: acc('교무금'), subjectId: sub('INCOME', '교무금'), amount: '5000',
  });
  assert.equal((await api('DELETE', `/api/transactions/${id}`)).status, 200);
  const again = await api('DELETE', `/api/transactions/${id}`);
  assert.equal(again.body.error.code, 'NOT_FOUND');
  let day = (await api('GET', '/api/day?date=2026-10-04')).body;
  assert.equal(day.total.end, 28800000);
  assert.equal(day.transactions.length, 0);

  const tr = await api('POST', '/api/transfers', {
    date: '2026-10-04', fromAccountId: acc('경상비'), toAccountId: acc('교무금'), amount: '700',
  });
  await api('DELETE', `/api/transactions/${tr.body.ids[1]}`); // 입금 쪽만 지정
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, 0);
  // 화면에는 없지만 내부 기록은 남는다
  const audits = db.prepare("SELECT entity_id FROM audit_log WHERE action = 'DELETE' ORDER BY id").all().map((r) => Number(r.entity_id));
  assert.deepEqual(audits, [id, ...tr.body.ids]);
  day = (await api('GET', '/api/day?date=2026-10-04')).body;
  assert.equal(day.total.end, 28800000);
});

test('수정: 내용만 바뀌고 이전 내용은 남지 않음, 사유 불필요', async () => {
  const { api, acc, sub, db } = setup();
  const { body: { id } } = await api('POST', '/api/transactions', {
    date: '2026-10-04', direction: 'IN', accountId: acc('교무금'), subjectId: sub('INCOME', '교무금'), amount: '30000',
  });
  const edit = {
    date: '2026-10-04', direction: 'IN', accountId: acc('교무금'), subjectId: sub('INCOME', '교무금'), amount: '300000', memo: '정정',
  };
  const r = await api('PUT', `/api/transactions/${id}`, edit);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const day = (await api('GET', '/api/day?date=2026-10-04')).body;
  assert.equal(fund(day, 'GENERAL').income, 300000);
  assert.deepEqual(day.transactions.map((t) => [t.id, t.amount, t.memo]), [[id, 300000, '정정']]); // 번호 유지
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, 1);
  // 한 번 더 수정해도 그대로 한 건 (번호는 바뀔 수 있으므로 화면은 목록을 새로 불러온다)
  const again = day.transactions[0].id;
  assert.equal((await api('PUT', `/api/transactions/${again}`, { ...edit, amount: '310000' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, 1);
});

test('이체 수정: 한 쌍이 통째로 새 내용으로', async () => {
  const { api, acc, db } = setup();
  const tr = await api('POST', '/api/transfers', {
    date: '2026-10-04', fromAccountId: acc('경상비'), toAccountId: acc('교무금'), amount: '700',
  });
  const r = await api('PUT', `/api/transactions/${tr.body.ids[0]}`, {
    date: '2026-10-04', fromAccountId: acc('경상비'), toAccountId: acc('기타 후원금'), amount: '800',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = db.prepare('SELECT direction, account_id, amount FROM transactions ORDER BY id').all().map((x) => ({ ...x }));
  assert.deepEqual(rows, [
    { direction: 'OUT', account_id: acc('경상비'), amount: 800 },
    { direction: 'IN', account_id: acc('기타 후원금'), amount: 800 },
  ]);
});

test('마감된 날짜 통제', async () => {
  const { api, acc, sub, db } = setup();
  const base = { direction: 'IN', accountId: acc('교무금'), subjectId: sub('INCOME', '교무금'), amount: '1000' };
  const { body: { id } } = await api('POST', '/api/transactions', { ...base, date: '2026-10-04' });
  const { body: { id: later } } = await api('POST', '/api/transactions', { ...base, date: '2026-10-06' });
  closeDate(db, '2026-10-04');

  assert.equal((await api('GET', '/api/day?date=2026-10-04')).body.locked, true);
  assert.equal((await api('GET', '/api/day?date=2026-10-06')).body.locked, false);
  let r = await api('POST', '/api/transactions', { ...base, date: '2026-10-04' });
  assert.equal(r.body.error.code, 'DATE_CLOSED');
  r = await api('DELETE', `/api/transactions/${id}`);
  assert.equal(r.body.error.code, 'DATE_CLOSED');
  r = await api('PUT', `/api/transactions/${id}`, { ...base, date: '2026-10-04', amount: '2' });
  assert.equal(r.body.error.code, 'DATE_CLOSED');
  // 열린 날짜의 거래를 마감된 날짜로 옮기는 수정도 거부, 실패하면 원래 거래 그대로 (한 번에 처리)
  r = await api('PUT', `/api/transactions/${later}`, { ...base, date: '2026-10-03' });
  assert.equal(r.body.error.code, 'DATE_CLOSED');
  assert.equal(db.prepare('SELECT tx_date FROM transactions WHERE id = ?').get(later).tx_date, '2026-10-06');
});

test('거래 조회: 기간·통장별 잔액 흐름, 검색어, 삭제한 거래 제외', async () => {
  const { api, acc, sub } = setup();
  const post = (date, direction, account, subject, amount, memo = '') => api('POST', '/api/transactions', {
    date, direction, accountId: acc(account), subjectId: sub(direction === 'IN' ? 'INCOME' : 'EXPENSE', subject), amount, memo,
  });
  await post('2026-10-02', 'IN', '경상비', '주일헌금', '100000', '10/2 헌금');
  await post('2026-10-04', 'OUT', '경상비', '관리운영비', '30000', '50%_할인 물품');
  const { body: { id } } = await post('2026-10-04', 'IN', '경상비', '감사헌금', '5000');
  await api('DELETE', `/api/transactions/${id}`);
  await api('POST', '/api/transfers', { date: '2026-10-05', fromAccountId: acc('경상비'), toAccountId: acc('교무금'), amount: '1000' });

  let r = (await api('GET', `/api/transactions?from=2026-10-03&to=2026-10-31&accountId=${acc('경상비')}`)).body;
  assert.equal(r.openingBalance, 10100000);
  assert.deepEqual(r.rows.map((x) => x.balanceAfter), [10070000, 10069000]);
  assert.deepEqual(r.totals, { income: 0, expense: 30000, transferIn: 0, transferOut: 1000 });

  r = (await api('GET', `/api/transactions?from=2026-10-01&to=2026-10-31&accountId=${acc('경상비')}`)).body;
  assert.deepEqual(r.rows.map((x) => x.balanceAfter), [10100000, 10070000, 10069000]);

  r = (await api('GET', '/api/transactions?from=2026-10-01&to=2026-10-31&q=' + encodeURIComponent('50%_'))).body;
  assert.deepEqual(r.rows.map((x) => x.memo), ['50%_할인 물품']);
  r = (await api('GET', '/api/transactions?from=2026-10-01&to=2026-10-31&q=' + encodeURIComponent('%'))).body;
  assert.equal(r.rows.length, 1); // % 는 문자 그대로 검색

  r = (await api('GET', '/api/transactions?from=2026-10-01&to=2026-10-31&kind=TRANSFER')).body;
  assert.equal(r.rows.length, 2);
  r = await api('GET', '/api/transactions?from=2026-10-31&to=2026-10-01');
  assert.equal(r.status, 400);
});

test('증빙번호 자동 제안', () => {
  assert.equal(nextVoucher('2026-015'), '2026-016');
  assert.equal(nextVoucher('A-9'), 'A-10');
  assert.equal(nextVoucher('099'), '100');
  assert.equal(nextVoucher('12번'), '13번');
  assert.equal(nextVoucher('영수증'), '');
  assert.equal(nextVoucher(''), '');
});

test('수정해도 목록 순서(번호)가 그대로', async () => {
  const { api, acc, sub } = setup();
  const base = { date: '2026-10-04', direction: 'IN', accountId: acc('교무금'), subjectId: sub('INCOME', '교무금') };
  const a = (await api('POST', '/api/transactions', { ...base, amount: '1', memo: '첫째' })).body.id;
  const b = (await api('POST', '/api/transactions', { ...base, amount: '2', memo: '둘째' })).body.id;
  const tr = (await api('POST', '/api/transfers', { date: '2026-10-04', fromAccountId: acc('경상비'), toAccountId: acc('교무금'), amount: '3' })).body.ids;
  await api('PUT', `/api/transactions/${a}`, { ...base, amount: '10', memo: '첫째 수정' });
  await api('PUT', `/api/transactions/${tr[1]}`, { date: '2026-10-04', fromAccountId: acc('경상비'), toAccountId: acc('기타 후원금'), amount: '30' });
  const day = (await api('GET', '/api/day?date=2026-10-04')).body;
  assert.deepEqual(day.transactions.map((t) => [t.id, t.amount]), [[a, 10], [b, 2], [tr[0], 30], [tr[1], 30]]);
});
