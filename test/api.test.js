import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createDb, d1Adapter, insertTx, closeDate } from './helpers.js';

function client(db) {
  const env = { DB: d1Adapter(db), AUTH_MODE: 'dev', DEV_USER: 'office@test' };
  return async (method, path, body) => {
    const res = await worker.fetch(new Request(`http://local${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }), env);
    return { status: res.status, body: await res.json() };
  };
}

const setupPayload = () => ({
  parish: { parishName: '  새벽성당 ', startDate: '2026-10-01', writerName: '김사무' },
  accounts: [
    { fundCode: 'GENERAL', name: '경상비', bankName: '농협', accountNo: '123', openingBalance: '1,500,000' },
    { fundCode: 'SPECIAL', name: '건축  기금', openingBalance: '0' },
  ],
  subjects: [
    { kind: 'INCOME', name: '교무금' }, { kind: 'INCOME', name: '헌금' }, { kind: 'EXPENSE', name: '운영비' },
  ],
  approvalSteps: ['담당', '신부'],
});

test('최초 설정: 빈 DB 에 한 번에 저장되고 두 번째는 거부', async () => {
  const db = createDb({ seed: false });
  const api = client(db);

  assert.equal((await api('GET', '/api/settings')).body.setupCompleted, false);

  const r = await api('POST', '/api/setup', setupPayload());
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const s = (await api('GET', '/api/settings')).body;
  assert.equal(s.setupCompleted, true);
  assert.equal(s.parish.parishName, '새벽성당');
  assert.deepEqual(s.accounts.map((a) => [a.fundCode, a.name, a.openingBalance, a.sortOrder]),
    [['GENERAL', '경상비', 1500000, 1], ['SPECIAL', '건축 기금', 0, 1]]);
  assert.deepEqual(s.approvalSteps.map((x) => x.title), ['담당', '신부']);
  assert.equal(s.subjects.length, 3);

  const again = await api('POST', '/api/setup', setupPayload());
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'SETUP_DONE');

  const audit = db.prepare("SELECT actor, action FROM audit_log WHERE entity = 'setup'").all();
  assert.deepEqual(audit.map((a) => ({ ...a })), [{ actor: 'office@test', action: 'SETUP' }]);
});

test('최초 설정: 잘못된 입력은 아무것도 저장하지 않음', async () => {
  const db = createDb({ seed: false });
  const api = client(db);
  const cases = [
    [(p) => { p.accounts[0].openingBalance = '100.5'; }, 'BAD_AMOUNT'],
    [(p) => { p.accounts[1].name = '경상비'; }, 'DUPLICATE'],
    [(p) => { p.subjects = p.subjects.filter((s) => s.kind === 'INCOME'); }, 'INVALID_INPUT'],
    [(p) => { p.approvalSteps = []; }, 'INVALID_INPUT'],
    [(p) => { p.parish.startDate = '2026-13-01'; }, 'INVALID_INPUT'],
    [(p) => { p.accounts = []; }, 'INVALID_INPUT'],
  ];
  for (const [mutate, code] of cases) {
    const p = setupPayload();
    mutate(p);
    const r = await api('POST', '/api/setup', p);
    assert.equal(r.status, 400, code);
    assert.equal(r.body.error.code, code);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM setup_lock').get().n, 0);
});

test('설정 변경 전에는 최초 설정이 필요', async () => {
  const api = client(createDb({ seed: false }));
  const r = await api('POST', '/api/accounts', { fundCode: 'GENERAL', name: 'x', openingBalance: '0' });
  assert.equal(r.body.error.code, 'SETUP_REQUIRED');
});

test('통장 추가·수정·삭제와 감사 로그', async () => {
  const db = createDb();
  const api = client(db);

  let r = await api('POST', '/api/accounts', { fundCode: 'SPECIAL', name: '성전건립', bankName: '신협', openingBalance: '5,000,000' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const created = (await api('GET', '/api/settings')).body.accounts.find((a) => a.name === '성전건립');
  assert.equal(created.sortOrder, 6);
  assert.equal(created.openingBalance, 5000000);

  r = await api('PUT', `/api/accounts/${created.id}`, {
    fundCode: 'SPECIAL', name: '성전건립 기금', bankName: '신협', accountNo: '', openingBalance: '5,100,000', isActive: false,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const logs = db.prepare("SELECT action, before_json, after_json FROM audit_log WHERE entity = 'accounts' ORDER BY id").all();
  assert.deepEqual(logs.map((l) => l.action), ['CREATE', 'UPDATE']);
  assert.equal(JSON.parse(logs[0].after_json).name, '성전건립');
  assert.equal(JSON.parse(logs[1].before_json).opening_balance, 5000000);
  assert.equal(JSON.parse(logs[1].after_json).opening_balance, 5100000);
  assert.equal(JSON.parse(logs[1].after_json).is_active, 0);

  r = await api('DELETE', `/api/accounts/${created.id}`);
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1").get().action, 'DELETE');

  r = await api('POST', '/api/accounts', { fundCode: 'GENERAL', name: '경상비', openingBalance: '0' });
  assert.equal(r.body.error.code, 'DUPLICATE');
  r = await api('PUT', '/api/accounts/9999', { fundCode: 'GENERAL', name: 'x', openingBalance: '0', isActive: true });
  assert.equal(r.status, 404);
});

test('거래가 있는 통장은 삭제 불가, 마감 후 초기잔액 변경 불가 (트리거 메시지 전달)', async () => {
  const db = createDb();
  const api = client(db);
  insertTx(db, { date: '2026-10-04', direction: 'IN', account: '교무금', subject: '교무금', amount: 1000 });
  const acc = (await api('GET', '/api/settings')).body.accounts.find((a) => a.name === '교무금');
  assert.equal(acc.txCount, 1);

  let r = await api('DELETE', `/api/accounts/${acc.id}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ACCOUNT_IN_USE');

  closeDate(db, '2026-10-04');
  const base = { fundCode: 'GENERAL', name: '교무금', bankName: '', accountNo: '', isActive: true };
  r = await api('PUT', `/api/accounts/${acc.id}`, { ...base, openingBalance: '1' });
  assert.equal(r.body.error.code, 'OPENING_LOCKED');
  assert.equal((await api('GET', '/api/settings')).body.locks.openingBalance, true);
  // 초기잔액을 그대로 두면 이름 변경은 가능
  r = await api('PUT', `/api/accounts/${acc.id}`, { ...base, name: '교무금 통장', openingBalance: '2,000,000' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // 실패한 요청은 감사 로그를 남기지 않음
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity = 'accounts'").get().n, 1);
});

test('순서 변경: 전체 목록이 일치해야 함', async () => {
  const db = createDb();
  const api = client(db);
  const accounts = (await api('GET', '/api/settings')).body.accounts.filter((a) => a.fundCode === 'GENERAL');
  const reversed = accounts.map((a) => a.id).reverse();
  let r = await api('POST', '/api/accounts/reorder', { fundCode: 'GENERAL', ids: reversed });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = (await api('GET', '/api/settings')).body.accounts.filter((a) => a.fundCode === 'GENERAL');
  assert.deepEqual(after.map((a) => a.id), reversed);

  r = await api('POST', '/api/accounts/reorder', { fundCode: 'GENERAL', ids: reversed.slice(1) });
  assert.equal(r.body.error.code, 'STALE');
});

test('과목 추가·사용중지·삭제, 결재선 변경', async () => {
  const db = createDb();
  const api = client(db);
  let r = await api('POST', '/api/subjects', { kind: 'EXPENSE', name: '차량유지비' });
  assert.equal(r.status, 201);
  const sub = (await api('GET', '/api/settings')).body.subjects.find((s) => s.name === '차량유지비');
  r = await api('PUT', `/api/subjects/${sub.id}`, { kind: 'EXPENSE', name: '차량유지비', isActive: false });
  assert.equal(r.status, 200);
  r = await api('DELETE', `/api/subjects/${sub.id}`);
  assert.equal(r.status, 200);

  r = await api('PUT', '/api/approval-steps', { titles: ['기안', '주임신부'] });
  assert.equal(r.status, 200);
  assert.deepEqual((await api('GET', '/api/settings')).body.approvalSteps.map((s) => s.title), ['기안', '주임신부']);
  r = await api('PUT', '/api/approval-steps', { titles: ['기안', '기안'] });
  assert.equal(r.body.error.code, 'DUPLICATE');
  r = await api('PUT', '/api/approval-steps', { titles: Array.from({ length: 11 }, (_, i) => `단계${i}`) });
  assert.equal(r.status, 400);
});

test('라우팅: JSON 이 아닌 변경 요청 거부, 없는 경로 404, 잘못된 방식 405', async () => {
  const db = createDb();
  const env = { DB: d1Adapter(db), AUTH_MODE: 'dev' };
  let res = await worker.fetch(new Request('http://local/api/subjects', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"kind":"INCOME","name":"x"}',
  }), env);
  assert.equal(res.status, 415);
  res = await worker.fetch(new Request('http://local/api/nothing'), env);
  assert.equal(res.status, 404);
  res = await worker.fetch(new Request('http://local/api/approval-steps'), env);
  assert.equal(res.status, 405);
});

test('open 모드: 로그인 없이 사용, 처리자는 사무실', async () => {
  const db = createDb();
  const env = { DB: d1Adapter(db), AUTH_MODE: 'open' };
  const me = await (await worker.fetch(new Request('http://local/api/me'), env)).json();
  assert.equal(me.email, '사무실');
  const res = await worker.fetch(new Request('http://local/api/subjects', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'INCOME', name: '바자회' }),
  }), env);
  assert.equal(res.status, 201);
  assert.equal(db.prepare('SELECT actor FROM audit_log ORDER BY id DESC LIMIT 1').get().actor, '사무실');
});

test('AUTH_MODE 미설정은 access 로 취급, Access 설정 없이는 거부', async () => {
  const noMode = await worker.fetch(new Request('http://local/api/settings'), { DB: d1Adapter(createDb()) });
  assert.equal((await noMode.json()).error.code, 'ACCESS_NOT_CONFIGURED');

  const env = { DB: d1Adapter(createDb()), AUTH_MODE: 'access' };
  const res = await worker.fetch(new Request('http://local/api/settings'), env);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, 'ACCESS_NOT_CONFIGURED');
  const res2 = await worker.fetch(new Request('http://local/api/settings'),
    { ...env, ACCESS_TEAM_DOMAIN: 'https://x.cloudflareaccess.com', ACCESS_AUD: 'aud' });
  assert.equal(res2.status, 401);
});
