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

test('취소: 사유 선택, 잔액에서 제외, 두 번 취소 불가, 이체는 한 쌍 모두 취소', async () => {
  const { api, acc, sub, db } = setup();
  const { body: { id } } = await api('POST', '/api/transactions', {
    date: '2026-10-04', direction: 'IN', accountId: acc('교무금'), subjectId: sub('INCOME', '교무금'), amount: '5000',
  });
  assert.equal((await api('POST', `/api/transactions/${id}/void`, { reason: '중복 입력' })).status, 200);
  const again = await api('POST', `/api/transactions/${id}/void`, { reason: '다시' });
  assert.equal(again.body.error.code, 'ALREADY_VOIDED');
  let day = (await api('GET', '/api/day?date=2026-10-04')).body;
  assert.equal(day.total.end, 28800000);
  assert.equal(day.transactions[0].status, 'VOIDED');
  assert.equal(day.transactions[0].voidReason, '중복 입력');

  const tr = await api('POST', '/api/transfers', {
    date: '2026-10-04', fromAccountId: acc('경상비'), toAccountId: acc('교무금'), amount: '700',
  });
  await api('POST', `/api/transactions/${tr.body.ids[1]}/void`, {}); // 입금 쪽만 지정, 사유 없이
  assert.equal(db.prepare('SELECT void_reason FROM transactions WHERE id = ?').get(tr.body.ids[0]).void_reason, '사유 없음');
  const statuses = db.prepare("SELECT status FROM transactions WHERE kind = 'TRANSFER'").all().map((r) => r.status);
  assert.deepEqual(statuses, ['VOIDED', 'VOIDED']);
  const audits = db.prepare("SELECT entity_id FROM audit_log WHERE action = 'VOID' ORDER BY id").all().map((r) => Number(r.entity_id));
  assert.deepEqual(audits, [id, ...tr.body.ids]);
  day = (await api('GET', '/api/day?date=2026-10-04')).body;
  assert.equal(day.total.end, 28800000);
});

test('수정: 원본 취소 + 새 거래, 이력 조회, 같은 원본 재수정 불가', async () => {
  const { api, acc, sub } = setup();
  const { body: { id } } = await api('POST', '/api/transactions', {
    date: '2026-10-04', direction: 'IN', accountId: acc('교무금'), subjectId: sub('INCOME', '교무금'), amount: '30000',
  });
  const edit = {
    reason: '금액 오기', date: '2026-10-04', direction: 'IN', accountId: acc('교무금'),
    subjectId: sub('INCOME', '교무금'), amount: '300000', memo: '정정',
  };
  let r = await api('POST', `/api/transactions/${id}/replace`, edit);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await api('POST', `/api/transactions/${id}/replace`, edit);
  assert.equal(r.body.error.code, 'ALREADY_VOIDED');

  const day = (await api('GET', '/api/day?date=2026-10-04')).body;
  assert.equal(fund(day, 'GENERAL').income, 300000);
  const latest = day.transactions.find((t) => t.status === 'POSTED');
  assert.equal(latest.replacesId, id);
  assert.equal(day.transactions.find((t) => t.id === id).replacedById, latest.id);
  assert.equal(day.transactions.find((t) => t.id === id).voidReason, '수정: 금액 오기');

  // 두 번째 수정 → 이력은 3개 버전, 어느 버전에서 조회해도 같은 이력
  await api('POST', `/api/transactions/${latest.id}/replace`, { ...edit, amount: '310000', reason: '재정정' });
  for (const anyId of [id, latest.id]) {
    const h = (await api('GET', `/api/transactions/${anyId}`)).body;
    assert.deepEqual(h.versions.map((v) => v.amount), [30000, 300000, 310000]);
    assert.deepEqual(h.versions.map((v) => v.status), ['VOIDED', 'VOIDED', 'POSTED']);
    assert.deepEqual(h.audit.map((a) => a.action), ['CREATE', 'VOID', 'CREATE', 'VOID', 'CREATE']);
  }
});

test('이체 수정: 새 이체 한 쌍이 각각 원본을 가리킴', async () => {
  const { api, acc, db } = setup();
  const tr = await api('POST', '/api/transfers', {
    date: '2026-10-04', fromAccountId: acc('경상비'), toAccountId: acc('교무금'), amount: '700',
  });
  const r = await api('POST', `/api/transactions/${tr.body.ids[0]}/replace`, {
    reason: '통장 오기', date: '2026-10-04', fromAccountId: acc('경상비'), toAccountId: acc('기타 후원금'), amount: '700',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = db.prepare("SELECT direction, status, replaces_id FROM transactions ORDER BY id").all().map((x) => ({ ...x }));
  assert.deepEqual(rows, [
    { direction: 'OUT', status: 'VOIDED', replaces_id: null },
    { direction: 'IN', status: 'VOIDED', replaces_id: null },
    { direction: 'OUT', status: 'POSTED', replaces_id: tr.body.ids[0] },
    { direction: 'IN', status: 'POSTED', replaces_id: tr.body.ids[1] },
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
  r = await api('POST', `/api/transactions/${id}/void`, { reason: 'x' });
  assert.equal(r.body.error.code, 'DATE_CLOSED');
  r = await api('POST', `/api/transactions/${later}/replace`, { ...base, date: '2026-10-03', reason: '날짜 오기' });
  assert.equal(r.body.error.code, 'DATE_CLOSED');
  // 실패한 수정은 원본도 그대로 (batch 전체 취소)
  assert.equal(db.prepare('SELECT status FROM transactions WHERE id = ?').get(later).status, 'POSTED');
});

test('거래 조회: 기간·통장별 잔액 흐름, 검색어, 취소 포함 여부', async () => {
  const { api, acc, sub } = setup();
  const post = (date, direction, account, subject, amount, memo = '') => api('POST', '/api/transactions', {
    date, direction, accountId: acc(account), subjectId: sub(direction === 'IN' ? 'INCOME' : 'EXPENSE', subject), amount, memo,
  });
  await post('2026-10-02', 'IN', '경상비', '주일헌금', '100000', '10/2 헌금');
  await post('2026-10-04', 'OUT', '경상비', '관리운영비', '30000', '50%_할인 물품');
  const { body: { id } } = await post('2026-10-04', 'IN', '경상비', '감사헌금', '5000');
  await api('POST', `/api/transactions/${id}/void`, { reason: '중복' });
  await api('POST', '/api/transfers', { date: '2026-10-05', fromAccountId: acc('경상비'), toAccountId: acc('교무금'), amount: '1000' });

  let r = (await api('GET', `/api/transactions?from=2026-10-03&to=2026-10-31&accountId=${acc('경상비')}`)).body;
  assert.equal(r.openingBalance, 10100000);
  assert.deepEqual(r.rows.map((x) => x.balanceAfter), [10070000, 10069000]);
  assert.deepEqual(r.totals, { income: 0, expense: 30000, transferIn: 0, transferOut: 1000 });

  r = (await api('GET', `/api/transactions?from=2026-10-01&to=2026-10-31&accountId=${acc('경상비')}&includeVoided=1`)).body;
  assert.deepEqual(r.rows.map((x) => x.balanceAfter), [10100000, 10070000, null, 10069000]);

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

test('수정도 사유 없이 가능 (내부 기록은 "수정")', async () => {
  const { api, acc, sub, db } = setup();
  const base = { date: '2026-10-04', direction: 'IN', accountId: acc('교무금'), subjectId: sub('INCOME', '교무금') };
  const { body: { id } } = await api('POST', '/api/transactions', { ...base, amount: '1000' });
  const r = await api('POST', `/api/transactions/${id}/replace`, { ...base, amount: '2000' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.prepare('SELECT void_reason FROM transactions WHERE id = ?').get(id).void_reason, '수정');
});
