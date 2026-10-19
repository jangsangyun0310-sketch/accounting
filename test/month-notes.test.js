// 월말결산서: 통장별 내용 목록(자동 완성), 비고 저장 · 지우기 · 잘못된 입력, 백업 · 복구
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, d1Adapter, worker } from './helpers.js';

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

test('내용 목록: 그 통장에서 쓴 내용만, 많이 쓴 순, 빈 내용 빼고', async () => {
  const { api } = setup();
  const s = (await api('GET', '/api/settings')).body;
  const [a, b] = s.accounts.filter((x) => x.fundCode === 'SPECIAL' && x.isActive);
  const add = (accountId, memo) => api('POST', '/api/transactions',
    { date: s.parish.startDate, direction: 'OUT', accountId, amount: '1000', memo });
  await add(a.id, '재산세');
  await add(a.id, '관리  운영비');
  await add(a.id, '관리 운영비');
  await add(a.id, '');
  await add(b.id, '교구 납부');
  const r = await api('GET', `/api/memos?accountId=${a.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.memos, ['관리 운영비', '재산세']); // 띄어쓰기는 하나로 맞춰 저장되어 한 줄
  assert.equal((await api('GET', '/api/memos')).status, 400);
});

test('월말결산서 비고: 달마다 통째로 저장, 빈 비고는 지움, 잘못된 달 거부, 백업 · 복구', async () => {
  const { api } = setup();
  const s = (await api('GET', '/api/settings')).body;
  const acc = s.accounts.find((x) => x.fundCode === 'SPECIAL');
  const put = (month, notes) => api('PUT', '/api/reports/month-notes', { month, notes });

  let r = await put('2026-06', [
    { accountId: acc.id, key: 'IN:발전기금', note: ' 자선주일 ' },
    { accountId: acc.id, key: 'OUT_SUM', note: '' },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.count, 1);
  await put('2026-07', [{ accountId: acc.id, key: 'IN_SUM', note: '7월' }]);
  r = await api('GET', '/api/reports/month-notes?month=2026-06');
  assert.deepEqual(r.body.notes, [{ accountId: acc.id, key: 'IN:발전기금', note: '자선주일' }]);

  // 다시 저장하면 그 달만 바뀐다
  await put('2026-06', [{ accountId: acc.id, key: 'OUT:재산세', note: '상반기분' }]);
  assert.deepEqual((await api('GET', '/api/reports/month-notes?month=2026-06')).body.notes.map((n) => n.key), ['OUT:재산세']);
  assert.equal((await api('GET', '/api/reports/month-notes?month=2026-07')).body.notes.length, 1);

  assert.equal((await put('2026-13', [])).status, 400);
  assert.equal((await api('GET', '/api/reports/month-notes?month=26-06')).status, 400);
  assert.equal((await put('2026-06', [{ accountId: acc.id, key: 'X', note: '가'.repeat(61) }])).status, 400);

  // 백업에 들어가고, 빈 장부에 복구하면 그대로
  const backup = (await api('GET', '/api/backup')).body;
  assert.equal(backup.tables.month_notes.length, 2);
  const other = setup(createDb({ seed: false }));
  const restored = await other.api('POST', '/api/restore', backup);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal((await other.api('GET', '/api/reports/month-notes?month=2026-07')).body.notes[0].note, '7월');
});
