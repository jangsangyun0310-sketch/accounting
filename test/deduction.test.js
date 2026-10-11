// 수입 차감(봉헌권 등): 차감 허용 과목에만, 결산·예산·조회에서 마이너스 수입, 백업·복구 / 주일미사 1인당 헌금 줄
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, d1Adapter, worker } from './helpers.js';
import { sha256Hex } from '../public/core/lib/backup.js';

function setup(db = createDb()) {
  const env = { DB: d1Adapter(db), AUTH_MODE: 'dev', DEV_USER: 'office@test' };
  const api = async (method, path, body) => {
    const res = await worker.fetch(new Request(`http://local${path}`, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    }), env);
    return { status: res.status, body: await res.json() };
  };
  return { db, api };
}

/** 주일헌금 · 봉헌권 수입 과목을 만들고 봉헌권에 차감 허용 */
async function prepare(api) {
  await api('POST', '/api/subjects', { kind: 'INCOME', name: '주일헌금' });
  await api('POST', '/api/subjects', { kind: 'INCOME', name: '봉헌권' });
  const s = (await api('GET', '/api/settings')).body;
  const offering = s.subjects.find((x) => x.name === '주일헌금');
  const ticket = s.subjects.find((x) => x.name === '봉헌권');
  const r = await api('PUT', `/api/subjects/${ticket.id}`, { kind: 'INCOME', name: '봉헌권', isActive: true, allowDeduction: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const account = s.accounts.find((a) => a.fundCode === 'GENERAL' && a.isActive);
  return { s, offering, ticket, account, start: s.parish.startDate };
}

test('수입 차감: 허용한 과목만, 일일결산 수입 내역에 − 로, 수입 합계·잔액·예산 집행·조회 합계는 순액', async () => {
  const { api } = setup();
  const { offering, ticket, account, start } = await prepare(api);
  assert.equal((await api('GET', '/api/settings')).body.subjects.find((x) => x.id === ticket.id).allowDeduction, true);

  const add = (body) => api('POST', '/api/transactions', { date: start, accountId: account.id, ...body });
  assert.equal((await add({ direction: 'IN', subjectId: offering.id, amount: 2900000, memo: '주일헌금 (봉헌권 포함)' })).status, 201);
  const d = await add({ direction: 'OUT', subjectId: ticket.id, amount: 400000, memo: '봉헌권 차감' });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  // 차감을 허용하지 않은 수입 과목은 거부
  assert.equal((await add({ direction: 'OUT', subjectId: offering.id, amount: 1 })).status, 400);

  const day = (await api('GET', `/api/reports/daily?date=${start}`)).body;
  const ded = day.income.rows.find((x) => x.id === d.body.id);
  assert.equal(ded.amount, -400000);
  assert.equal(ded.deduction, true);
  assert.equal(day.income.total, 2500000);
  assert.equal(day.expense.rows.some((x) => x.id === d.body.id), false);
  const g = day.funds.find((f) => f.code === 'GENERAL');
  assert.equal(g.income, 2500000);
  assert.equal(g.expense, 0);

  const year = start.slice(0, 4);
  const period = (await api('GET', `/api/reports/period?type=year&year=${year}`)).body;
  assert.equal(period.income.rows.find((x) => x.subjectId === ticket.id).total, -400000);
  assert.equal(period.total.income, 2500000);

  await api('PUT', '/api/budgets', { year: Number(year), items: [{ subjectId: ticket.id, amount: 1000000 }] });
  const budget = (await api('GET', `/api/budgets?year=${year}`)).body;
  const flat = JSON.stringify(budget);
  assert.ok(flat.includes('-400000'), '봉헌권 집행액은 −400,000');

  const q = (await api('GET', `/api/transactions?from=${start}&to=${start}&kind=IN`)).body;
  assert.equal(q.rows.length, 2);
  assert.equal(q.totals.income, 2500000);
  assert.equal(q.totals.expense, 0);
  assert.equal((await api('GET', `/api/transactions?from=${start}&to=${start}&kind=OUT`)).body.rows.length, 0);

  // 차감 거래가 있으면 차감 허용을 끌 수 없다
  assert.notEqual((await api('PUT', `/api/subjects/${ticket.id}`, { kind: 'INCOME', name: '봉헌권', isActive: true, allowDeduction: false })).status, 200);
});

test('수입 차감이 있는 장부도 백업·복구되고, 차감 칸이 없던 예전 백업도 복구된다', async () => {
  const a = setup();
  const { ticket, account, start } = await prepare(a.api);
  await a.api('POST', '/api/transactions', { date: start, accountId: account.id, direction: 'OUT', subjectId: ticket.id, amount: 1000 });
  const backup = await (await worker.fetch(new Request('http://local/api/backup'), { DB: d1Adapter(a.db), AUTH_MODE: 'dev' })).json();
  const b = setup(createDb({ seed: false }));
  const r = await b.api('POST', '/api/restore', backup);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await b.api('GET', `/api/reports/daily?date=${start}`)).body.income.total, -1000);

  const old = structuredClone(backup);
  old.tables.transactions = old.tables.transactions.filter((t) => t.subject_id !== ticket.id);
  old.counts.transactions = old.tables.transactions.length;
  old.tables.budget_subjects = old.tables.budget_subjects.map(({ allow_deduction, ...s }) => s);
  old.tables.journal_settings = (old.tables.journal_settings ?? []).map(({ offering_subject_id, ...s }) => s);
  old.tables.audit_log = [];
  old.counts.audit_log = 0;
  old.checksum = await sha256Hex(JSON.stringify(old.tables));
  const c = setup(createDb({ seed: false }));
  const rc = await c.api('POST', '/api/restore', old);
  assert.equal(rc.status, 200, JSON.stringify(rc.body));
});

test('주일 사목일지: 토요일 주일미사 인원과 토·일 주일헌금(봉헌권 포함) 합계, 주일헌금 과목은 설정에서', async () => {
  const { api } = setup();
  const { offering, ticket, account, start } = await prepare(api);
  // 운영 개시일 이후 첫 토요일·주일
  let sat = start;
  while (new Date(`${sat}T00:00:00Z`).getUTCDay() !== 6) sat = new Date(Date.parse(`${sat}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const sun = new Date(Date.parse(`${sat}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

  assert.equal((await api('GET', `/api/journal?date=${sat}`)).body.sunday, null); // 토요일 일지에는 없음
  assert.deepEqual((await api('GET', `/api/journal?date=${sun}`)).body.sunday, { saturdayAttendance: 0, offering: 0, subjectName: null });

  await api('PUT', '/api/journal', { date: sat, masses: [
    { time: '18:00', name: '주일미사 (학생)', kind: 'SUNDAY', attendance: 320 },
    { time: '10:00', name: '평일미사', kind: 'WEEKDAY', attendance: 40 },
  ] });
  const add = (date, direction, subjectId, amount) => api('POST', '/api/transactions', { date, accountId: account.id, direction, subjectId, amount });
  await add(sat, 'IN', offering.id, 600000);
  await add(sun, 'IN', offering.id, 2300000);
  await add(sun, 'OUT', ticket.id, 400000); // 봉헌권 차감은 평균에서 빼지 않는다
  assert.equal((await api('PUT', '/api/journal-settings/offering', { subjectId: offering.id })).status, 200);
  assert.equal((await api('PUT', '/api/journal-settings/offering', { subjectId: 999999 })).status, 400);
  assert.equal((await api('GET', '/api/settings')).body.journalStart.offeringSubjectId, offering.id);

  assert.deepEqual((await api('GET', `/api/journal?date=${sun}`)).body.sunday, { saturdayAttendance: 320, offering: 2900000, subjectName: '주일헌금' });
});
