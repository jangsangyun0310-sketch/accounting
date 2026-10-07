// 예산 대비 집행: 예산 저장·집행액·집행률, 이체 제외, 백업·복구 (예산 표가 없던 예전 백업도 복구)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, d1Adapter, accountId, subjectId, worker } from './helpers.js';
import { sha256Hex } from '../public/core/lib/backup.js';

function setup(db = createDb()) {
  const env = { DB: d1Adapter(db), AUTH_MODE: 'dev', DEV_USER: 'office@test' };
  const api = async (method, path, body) => {
    const res = await worker.fetch(new Request(`http://local${path}`, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    }), env);
    return { status: res.status, body: await res.json() };
  };
  const tx = (date, direction, account, subject, amount) => api('POST', '/api/transactions', {
    date, direction, accountId: accountId(db, account),
    subjectId: subjectId(db, direction === 'IN' ? 'INCOME' : 'EXPENSE', subject), amount: String(amount),
  });
  return { db, api, tx };
}

test('예산 저장 → 과목별 집행액·집행률, 이체는 집행에 넣지 않음, 0 은 예산 없음', async () => {
  const { db, api, tx } = setup();
  const r = await api('PUT', '/api/budgets', { year: 2026, items: [
    { subjectId: subjectId(db, 'INCOME', '교무금'), amount: '10,000,000' },
    { subjectId: subjectId(db, 'EXPENSE', '전례비'), amount: 2000000 },
    { subjectId: subjectId(db, 'EXPENSE', '인건비'), amount: '0' },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.count, 2);
  await tx('2026-10-02', 'IN', '교무금', '교무금', 2500000);
  await tx('2026-10-02', 'OUT', '경상비', '전례비', 500000);
  await api('POST', '/api/transfers', { date: '2026-10-02', fromAccountId: 1, toAccountId: 2, amount: '300000' });

  const b = (await api('GET', '/api/budgets?year=2026')).body;
  const row = (group, name) => b[group].items.find((x) => x.name === name);
  assert.deepEqual([row('income', '교무금').budget, row('income', '교무금').actual, row('income', '교무금').rate], [10000000, 2500000, 25]);
  assert.deepEqual([row('expense', '전례비').actual, row('expense', '전례비').remaining, row('expense', '전례비').rate], [500000, 1500000, 25]);
  assert.equal(row('expense', '인건비').budget, 0);
  assert.equal(row('expense', '인건비').rate, null);
  assert.equal(b.income.actual, 2500000); // 이체 300,000 은 들어가지 않는다
  assert.equal(b.expense.budget, 2000000);

  // 다른 해는 따로
  assert.equal((await api('GET', '/api/budgets?year=2027')).body.income.budget, 0);
});

test('예산 입력 검증: 없는 과목, 소수·음수, 잘못된 연도', async () => {
  const { db, api } = setup();
  assert.equal((await api('PUT', '/api/budgets', { year: 2026, items: [{ subjectId: 9999, amount: 1 }] })).body.error.code, 'STALE');
  assert.equal((await api('PUT', '/api/budgets', { year: 2026, items: [{ subjectId: subjectId(db, 'INCOME', '교무금'), amount: '1.5' }] })).body.error.code, 'BAD_AMOUNT');
  assert.equal((await api('PUT', '/api/budgets', { year: 1999, items: [] })).body.error.code, 'BAD_YEAR');
  assert.equal((await api('GET', '/api/budgets?year=abc')).body.error.code, 'BAD_YEAR');
});

test('예산은 백업에 들어가고 복구되며, 예산 표가 없던 예전 백업 파일도 복구된다', async () => {
  const a = setup();
  await a.api('PUT', '/api/budgets', { year: 2026, items: [{ subjectId: subjectId(a.db, 'INCOME', '교무금'), amount: 5000000 }] });
  const backup = await (await worker.fetch(new Request('http://local/api/backup'), { DB: d1Adapter(a.db), AUTH_MODE: 'dev' })).json();
  assert.equal(backup.counts.budgets, 1);

  const b = setup(createDb({ seed: false }));
  assert.equal((await b.api('POST', '/api/restore', backup)).status, 200);
  assert.equal((await b.api('GET', '/api/budgets?year=2026')).body.income.budget, 5000000);

  // 예전 백업: budgets 표 없이 검사값을 만든 파일
  const old = structuredClone(backup);
  delete old.tables.budgets;
  delete old.counts.budgets;
  old.checksum = await sha256Hex(JSON.stringify(old.tables));
  const c = setup(createDb({ seed: false }));
  const restored = await c.api('POST', '/api/restore', old);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal((await c.api('GET', '/api/budgets?year=2026')).body.income.budget, 0);

  // 모르는 표가 끼어 있으면 거부
  const odd = structuredClone(backup);
  odd.tables.something = [];
  odd.checksum = await sha256Hex(JSON.stringify(odd.tables));
  assert.equal((await setup(createDb({ seed: false })).api('POST', '/api/restore', odd)).body.error.code, 'BACKUP_INVALID');
});

test('과목을 지우면 그 과목 예산도 함께 지워진다', async () => {
  const { db, api } = setup();
  const sid = subjectId(db, 'EXPENSE', '기타지출');
  await api('PUT', '/api/budgets', { year: 2026, items: [{ subjectId: sid, amount: 100000 }] });
  assert.equal((await api('DELETE', `/api/subjects/${sid}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budgets').get().n, 0);
});
