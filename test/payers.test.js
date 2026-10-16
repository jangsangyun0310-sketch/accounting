// 개인별 납부: 특별회계 수입에만 납부자, 수정·삭제 때 함께, 마감 후에도 이름만 고치기, 연간 사람별 집계, 백업·복구
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

async function base(api) {
  const s = (await api('GET', '/api/settings')).body;
  const special = s.accounts.find((a) => a.fundCode === 'SPECIAL' && a.isActive);
  const general = s.accounts.find((a) => a.fundCode === 'GENERAL' && a.isActive);
  const income = s.subjects.find((x) => x.kind === 'INCOME' && x.isActive);
  const expense = s.subjects.find((x) => x.kind === 'EXPENSE' && x.isActive);
  return { date: s.parish.startDate, special, general, income, expense };
}

test('납부자: 특별회계 수입에만 저장, 수정하면 바뀌고 지우면 함께 지워짐, 조회·검색에 나옴', async () => {
  const { api } = setup();
  const b = await base(api);
  const add = (accountId, direction, payer, amount = 10000) => api('POST', '/api/transactions',
    { date: b.date, direction, accountId, subjectId: (direction === 'IN' ? b.income : b.expense).id, amount, payer });
  const r1 = await add(b.special.id, 'IN', ' 홍길동(베드로) ');
  const r2 = await add(b.general.id, 'IN', '김일반');   // 일반회계 → 이름 안 들어감
  const r3 = await add(b.special.id, 'OUT', '박지출');   // 지출 → 안 들어감
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  const day = (await api('GET', `/api/day?date=${b.date}`)).body;
  const byId = Object.fromEntries(day.transactions.map((t) => [t.id, t.payer]));
  assert.deepEqual([byId[r1.body.id], byId[r2.body.id], byId[r3.body.id]], ['홍길동(베드로)', '', '']);

  // 수정: 이름 바꾸기, 비우기
  const upd = await api('PUT', `/api/transactions/${r1.body.id}`, { date: b.date, direction: 'IN', accountId: b.special.id, subjectId: b.income.id, amount: 20000, payer: '홍길동(3구역)' });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  let t = (await api('GET', `/api/day?date=${b.date}`)).body.transactions.find((x) => x.id === r1.body.id);
  assert.equal(t.payer, '홍길동(3구역)');
  const q = (await api('GET', `/api/transactions?from=${b.date}&to=${b.date}&q=3구역`)).body;
  assert.deepEqual(q.rows.map((x) => x.id), [r1.body.id]);
  assert.deepEqual((await api('GET', '/api/payers')).body.payers, ['홍길동(3구역)']);

  await api('DELETE', `/api/transactions/${r1.body.id}`);
  assert.deepEqual((await api('GET', '/api/payers')).body.payers, []);
});

test('마감한 날도 납부자 이름만 고칠 수 있고, 특별회계 수입이 아니면 거부', async () => {
  const { api } = setup();
  const b = await base(api);
  const r = await api('POST', '/api/transactions', { date: b.date, direction: 'IN', accountId: b.special.id, subjectId: b.income.id, amount: 50000, payer: '홍길동' });
  const g = await api('POST', '/api/transactions', { date: b.date, direction: 'IN', accountId: b.general.id, subjectId: b.income.id, amount: 1000 });
  assert.equal((await api('POST', `/api/closings/${b.date}/close`, {})).status, 200);
  // 금액 수정은 막히고
  assert.notEqual((await api('PUT', `/api/transactions/${r.body.id}`, { date: b.date, direction: 'IN', accountId: b.special.id, subjectId: b.income.id, amount: 1 })).status, 200);
  // 이름만은 된다
  assert.equal((await api('PUT', `/api/transactions/${r.body.id}/payer`, { payer: '홍길동(베드로)' })).status, 200);
  const t = (await api('GET', `/api/day?date=${b.date}`)).body.transactions.find((x) => x.id === r.body.id);
  assert.equal(t.payer, '홍길동(베드로)');
  assert.equal(t.amount, 50000);
  assert.equal((await api('PUT', `/api/transactions/${g.body.id}/payer`, { payer: '김일반' })).status, 400);
  // 봉헌자는 필수라 비울 수 없다
  assert.equal((await api('PUT', `/api/transactions/${r.body.id}/payer`, { payer: '' })).status, 400);
  assert.equal((await api('GET', `/api/day?date=${b.date}`)).body.transactions.find((x) => x.id === r.body.id).payer, '홍길동(베드로)');
});

test('개인별 납부: 연도 안 특별회계 수입을 사람별로, 종류별 합계, 비슷한 이름 표시, 백업·복구', async () => {
  const { api, db } = setup();
  const b = await base(api);
  const add = (payer, amount) => api('POST', '/api/transactions', { date: b.date, direction: 'IN', accountId: b.special.id, subjectId: b.income.id, amount, payer });
  await add('홍길동(베드로)', 100000);
  await add('홍길동(베드로)', 200000);
  await add('홍길동', 50000);
  await add('김마리아', 30000);
  // 이름 없는 특별회계 수입은 저장되지 않는다
  assert.equal((await api('POST', '/api/transactions', { date: b.date, direction: 'IN', accountId: b.special.id, subjectId: b.income.id, amount: 999 })).status, 400);
  const year = b.date.slice(0, 4);
  const r = (await api('GET', `/api/reports/donors?year=${year}`)).body;
  assert.deepEqual(r.people.map((p) => [p.payer, p.count, p.total]), [['김마리아', 1, 30000], ['홍길동', 1, 50000], ['홍길동(베드로)', 2, 300000]]);
  const hong = r.people.find((p) => p.payer === '홍길동(베드로)');
  assert.deepEqual(hong.bySubject, [{ name: b.special.name, count: 2, total: 300000 }]); // 헌금 종류 = 통장
  assert.deepEqual(hong.similar, ['홍길동']);
  assert.deepEqual(r.people.find((p) => p.payer === '김마리아').similar, []);
  assert.equal(r.total, 380000);
  assert.deepEqual((await api('GET', `/api/reports/donors?year=${Number(year) + 1}`)).body.people, []);

  const backup = await (await worker.fetch(new Request('http://local/api/backup'), { DB: d1Adapter(db), AUTH_MODE: 'dev' })).json();
  assert.equal(backup.counts.tx_payers, 4);
  const c = setup(createDb({ seed: false }));
  const rr = await c.api('POST', '/api/restore', backup);
  assert.equal(rr.status, 200, JSON.stringify(rr.body));
  assert.equal((await c.api('GET', `/api/reports/donors?year=${year}`)).body.total, 380000);

  const old = structuredClone(backup);
  delete old.tables.tx_payers;
  delete old.counts.tx_payers;
  old.checksum = await sha256Hex(JSON.stringify(old.tables));
  const d = setup(createDb({ seed: false }));
  assert.equal((await d.api('POST', '/api/restore', old)).status, 200);
  assert.deepEqual((await d.api('GET', `/api/reports/donors?year=${year}`)).body.people, []);
});

test('과목 없이 입력: 특별회계 수입 · 지출 기본 과목을 한 번만 만들어 쓰고, 수정해도 그대로', async () => {
  const { api, db } = setup();
  const b = await base(api);
  const r1 = await api('POST', '/api/transactions', { date: b.date, direction: 'IN', accountId: b.special.id, amount: 10000, payer: '김요셉' });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  const r2 = await api('POST', '/api/transactions', { date: b.date, direction: 'IN', accountId: b.special.id, amount: 20000, payer: '이마리아' });
  const r3 = await api('POST', '/api/transactions', { date: b.date, direction: 'OUT', accountId: b.special.id, amount: 5000, memo: '장학금' });
  assert.equal(r3.status, 201, JSON.stringify(r3.body));
  const subjects = db.prepare("SELECT kind, name FROM budget_subjects WHERE name LIKE '특별회계%' ORDER BY kind").all().map((x) => ({ ...x }));
  assert.deepEqual(subjects, [{ kind: 'EXPENSE', name: '특별회계 지출' }, { kind: 'INCOME', name: '특별회계 수입' }]);
  const used = db.prepare('SELECT COUNT(DISTINCT subject_id) AS n FROM transactions WHERE id IN (?, ?)').get(r1.body.id, r2.body.id).n;
  assert.equal(used, 1);
  // 수정할 때도 과목 없이, 봉헌자는 그대로 필수
  assert.equal((await api('PUT', `/api/transactions/${r1.body.id}`, { date: b.date, direction: 'IN', accountId: b.special.id, amount: 15000 })).status, 400);
  assert.equal((await api('PUT', `/api/transactions/${r1.body.id}`, { date: b.date, direction: 'IN', accountId: b.special.id, amount: 15000, payer: '김요셉' })).status, 200);
});
