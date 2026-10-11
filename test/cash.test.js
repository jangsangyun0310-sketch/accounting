// 사무실 현금: 현금 등록(은행·계좌번호 없음), 결산서에 현금 표시, 백업·복구 (예전 백업도)
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

test('현금 등록 → 거래·이체 → 결산서에 현금 표시', async () => {
  const { api } = setup();
  const s0 = (await api('GET', '/api/settings')).body;
  const bank = s0.accounts.find((a) => a.fundCode === 'GENERAL' && a.isActive);
  const r = await api('POST', '/api/accounts', { fundCode: 'GENERAL', name: '일반회계 현금', bankName: '농협', accountNo: '1-2', openingBalance: 0, isCash: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const cash = (await api('GET', '/api/settings')).body.accounts.find((a) => a.name === '일반회계 현금');
  assert.equal(cash.isCash, true);
  assert.equal(cash.bankName, '');
  assert.equal(cash.accountNo, '');
  assert.equal((await api('GET', '/api/settings')).body.accounts.find((a) => a.id === bank.id).isCash, false);

  const date = s0.parish.startDate;
  const subject = s0.subjects.find((x) => x.kind === 'INCOME' && x.parentId != null && x.isActive)
    ?? s0.subjects.find((x) => x.kind === 'INCOME' && x.isActive);
  const tx = await api('POST', '/api/transactions', { date, direction: 'IN', accountId: cash.id, subjectId: subject.id, amount: 920000, memo: '주일헌금' });
  assert.equal(tx.status, 201, JSON.stringify(tx.body));
  const tr = await api('POST', '/api/transfers', { date, fromAccountId: cash.id, toAccountId: bank.id, amount: 800000, memo: '입금' });
  assert.equal(tr.status, 201, JSON.stringify(tr.body));

  const day = (await api('GET', `/api/reports/daily?date=${date}`)).body;
  const c = day.accounts.find((a) => a.id === cash.id);
  assert.equal(c.isCash, true);
  assert.equal(c.end, 120000);

  // 통장별 내역: 현금이 맨 위
  const acc = (await api('GET', `/api/reports/accounts?from=${date}&to=${date}`)).body;
  assert.equal(acc.accounts[0].id, cash.id);
  assert.equal(acc.accounts[0].isCash, true);
});

test('현금이 백업·복구되고, 현금 칸이 없던 예전 백업도 복구된다 (예전 금고 확인 기록도 그대로)', async () => {
  const a = setup();
  const s0 = (await a.api('GET', '/api/settings')).body;
  await a.api('POST', '/api/accounts', { fundCode: 'SPECIAL', name: '특별회계 현금', openingBalance: 0, isCash: true });
  const cash = (await a.api('GET', '/api/settings')).body.accounts.find((x) => x.isCash);
  // 금고 확인 기능은 뺐지만 예전에 저장한 기록은 장부에 남아 백업·복구된다
  a.db.prepare("INSERT INTO cash_counts (count_date, account_id, counted, updated_at, updated_by) VALUES (?, ?, 0, 'x', 'x')").run(s0.parish.startDate, cash.id);
  const backup = await (await worker.fetch(new Request('http://local/api/backup'), { DB: d1Adapter(a.db), AUTH_MODE: 'dev' })).json();
  assert.equal(backup.counts.cash_counts, 1);

  const b = setup(createDb({ seed: false }));
  const r = await b.api('POST', '/api/restore', backup);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await b.api('GET', '/api/settings')).body.accounts.find((x) => x.id === cash.id).isCash, true);


  const old = structuredClone(backup);
  delete old.tables.cash_counts;
  delete old.counts.cash_counts;
  old.tables.accounts = old.tables.accounts.filter((x) => !x.is_cash).map(({ is_cash, ...x }) => x);
  old.counts.accounts = old.tables.accounts.length;
  old.checksum = await sha256Hex(JSON.stringify(old.tables));
  const c = setup(createDb({ seed: false }));
  const rc = await c.api('POST', '/api/restore', old);
  assert.equal(rc.status, 200, JSON.stringify(rc.body));
  assert.ok((await c.api('GET', '/api/settings')).body.accounts.every((x) => x.isCash === false));
});
