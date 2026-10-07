// 서버 장부: 성당별 저장소(Durable Object SQLite) 위에서 장부 엔진이 그대로 동작하는지, Worker 가 성당을 섞지 않는지
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleApi } from '../public/core/engine.js';
import { MIGRATIONS } from '../public/core/migrations.js';
import { applyMigrations, backupIsCurrent, resetLedger, storageD1 } from '../src/ledger-core.js';
import { d1Adapter } from './helpers.js';
import router from '../src/router.js';

const FILES = MIGRATIONS.map((name) => ({ name, sql: readFileSync(new URL(`../public/migrations/${name}`, import.meta.url), 'utf8') }));

/** Durable Object 의 ctx.storage 흉내 (sql.exec / transactionSync). 외래키는 DO 처럼 항상 검사 */
function fakeStorage() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const cursor = (rows) => ({ toArray: () => rows, one: () => rows[0] });
  return {
    db,
    sql: {
      exec(query, ...params) {
        if (!params.length && query.trim().replace(/;\s*$/, '').includes(';')) {
          db.exec(query); // 여러 문장 (표 구조 파일)
          return cursor([]);
        }
        return cursor(db.prepare(query).all(...params).map((r) => ({ ...r })));
      },
    },
    // Durable Object 의 deleteAll: SQL 자료까지 모두 지운다
    async deleteAll() {
      db.exec('PRAGMA foreign_keys = OFF');
      for (const { type, name } of db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'view')").all()) {
        db.exec(`DROP ${type.toUpperCase()} IF EXISTS "${name}"`);
      }
      db.exec('PRAGMA foreign_keys = ON');
    },
    transactionSync(fn) {
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

/** 저장소 하나 = 성당 하나. Ledger.fetch 와 같이 handleApi 를 부른다 */
function ledger(actor = 'office@example.com') {
  const storage = fakeStorage();
  applyMigrations(storage, FILES);
  const env = { DB: storageD1(storage), AUTH_MODE: 'server', ACTOR: actor };
  const api = async (method, path, body) => {
    const res = await handleApi(new Request(`http://local${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }), env);
    return { status: res.status, body: await res.json() };
  };
  return { storage, api };
}

const setupPayload = () => ({
  parish: { parishName: '예시성당', startDate: '2026-10-01', writerName: '사무장' },
  accounts: [
    { fundCode: 'GENERAL', name: '경상비', openingBalance: '1,000,000' },
    { fundCode: 'SPECIAL', name: '건축 기금', openingBalance: '0' },
  ],
  subjects: [{ kind: 'INCOME', name: '교무금' }, { kind: 'EXPENSE', name: '운영비' }],
  approvalSteps: ['기안', '주임신부'],
});

test('서버 장부 엔진의 표 구조 목록이 브라우저 엔진과 같다 (src/ledger.js)', () => {
  const source = readFileSync(new URL('../src/ledger.js', import.meta.url), 'utf8');
  const listed = [...source.matchAll(/\{ name: '([^']+)', sql: m\d+ \}/g)].map((m) => m[1]);
  const imported = [...source.matchAll(/from '\.\.\/public\/migrations\/([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(listed, MIGRATIONS);
  assert.deepEqual(imported, MIGRATIONS);
});

test('표 구조는 한 번만 적용되고, 다시 열어도 그대로', () => {
  const { storage } = ledger();
  applyMigrations(storage, FILES);
  const names = storage.db.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map((r) => r.name);
  assert.deepEqual(names, MIGRATIONS);
});

test('서버 장부: 최초 설정 → 거래 → 마감 → 마감된 날짜 보호 → 백업, 처리자는 로그인 이메일', async () => {
  const { storage, api } = ledger('office@example.com');
  assert.equal((await api('POST', '/api/setup', setupPayload())).status, 200);
  const s = (await api('GET', '/api/settings')).body;
  const account = s.accounts.find((a) => a.name === '경상비').id;
  const income = s.subjects.find((x) => x.name === '교무금').id;

  const tx = await api('POST', '/api/transactions', {
    date: '2026-10-01', direction: 'IN', accountId: account, subjectId: income, amount: '150,000', memo: '김베드로',
  });
  assert.equal(tx.status, 201, JSON.stringify(tx.body));
  const bal = (await api('GET', '/api/balances?date=2026-10-01')).body;
  assert.equal(bal.total, 1_150_000);

  assert.equal((await api('POST', '/api/closings/2026-10-01/close', {})).status, 200);
  const blocked = await api('POST', '/api/transactions', {
    date: '2026-10-01', direction: 'IN', accountId: account, subjectId: income, amount: '1000',
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'DATE_CLOSED');

  const actors = storage.db.prepare('SELECT DISTINCT actor FROM audit_log').all().map((r) => r.actor);
  assert.deepEqual(actors, ['office@example.com']);
  assert.equal((await api('GET', '/api/health')).body.migration, MIGRATIONS.at(-1));
});

test('서버 장부: 백업 파일을 다른 빈 장부에 복구하면 같은 잔액 (한 번에 전부 저장)', async () => {
  const a = ledger();
  await a.api('POST', '/api/setup', setupPayload());
  const s = (await a.api('GET', '/api/settings')).body;
  await a.api('POST', '/api/transactions', {
    date: '2026-10-02', direction: 'OUT', accountId: s.accounts[0].id,
    subjectId: s.subjects.find((x) => x.kind === 'EXPENSE').id, amount: '30000', memo: '전기요금',
  });
  const backup = await handleApi(new Request('http://local/api/backup'), { DB: storageD1(a.storage), AUTH_MODE: 'server', ACTOR: 'x' });
  const file = await backup.json();

  const b = ledger();
  const restored = await b.api('POST', '/api/restore', file);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal((await b.api('GET', '/api/balances?date=2026-10-02')).body.total, 970_000);
  // 데이터가 있는 장부에는 복구 불가
  assert.equal((await b.api('POST', '/api/restore', file)).body.error.code, 'RESTORE_NOT_EMPTY');
});

// ---------------------------------------------------------------- Worker: 성당별로 나눠 보내기

function routerEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const m of ['0001_accounts.sql', '0002_members.sql']) db.exec(readFileSync(new URL(`../src/migrations/${m}`, import.meta.url), 'utf8'));
  const calls = [];
  const env = {
    DB: d1Adapter(db),
    ASSETS: { fetch: async () => new Response('asset') },
    DEV_LOGIN: '1',
    LEDGER: {
      idFromName: (name) => ({ name }),
      get: (id) => ({
        fetch: async (req) => {
          calls.push({ parish: id.name, url: req.url, method: req.method, actor: req.headers.get('x-bondang-actor'), cookie: req.headers.get('cookie') });
          return new Response('{}', { headers: { 'content-type': 'application/json' } });
        },
      }),
    },
  };
  return { db, env, calls };
}

async function devSession(env, email, parishName) {
  const res = await router.fetch(new Request(`http://localhost:8787/auth/dev-login?email=${email}`), env);
  const token = /__Host-bs_session=([^;]+)/.exec(res.headers.getSetCookie().join('\n'))[1];
  const cookie = `__Host-bs_session=${token}`;
  if (parishName) {
    await router.fetch(new Request('http://localhost:8787/auth/parish', {
      method: 'POST', headers: { cookie, origin: 'http://localhost:8787', 'content-type': 'application/json' },
      body: JSON.stringify({ name: parishName, agree: true }),
    }), env);
  }
  return cookie;
}

test('장부 요청: 로그인 안 하면 401, 성당 등록 전이면 403', async () => {
  const { env, calls } = routerEnv();
  const anon = await router.fetch(new Request('http://localhost:8787/api/settings'), env);
  assert.equal(anon.status, 401);
  const cookie = await devSession(env, 'new@example.com');
  const noParish = await router.fetch(new Request('http://localhost:8787/api/settings', { headers: { cookie } }), env);
  assert.equal(noParish.status, 403);
  assert.equal(calls.length, 0);
});

test('장부 요청은 로그인한 사용자의 성당 저장소로만 가고, 처리자 머리글은 위조할 수 없다', async () => {
  const { db, env, calls } = routerEnv();
  const a = await devSession(env, 'a@example.com', '가성당');
  const b = await devSession(env, 'b@example.com', '나성당');
  const parishOf = (email) => db.prepare('SELECT parish_id FROM users WHERE email = ?').get(email).parish_id;

  await router.fetch(new Request('http://localhost:8787/api/settings', {
    headers: { cookie: a, 'x-bondang-actor': 'b@example.com' },
  }), env);
  await router.fetch(new Request('http://localhost:8787/api/transactions', {
    method: 'POST', headers: { cookie: b, origin: 'http://localhost:8787', 'content-type': 'application/json' }, body: '{}',
  }), env);

  assert.deepEqual(calls.map((c) => [c.parish, c.actor, c.cookie]), [
    [parishOf('a@example.com'), 'a@example.com', null],
    [parishOf('b@example.com'), 'b@example.com', null],
  ]);
  assert.notEqual(parishOf('a@example.com'), parishOf('b@example.com'));
});

test('다른 사이트에서 보낸 장부 변경 요청은 거부', async () => {
  const { env, calls } = routerEnv();
  const cookie = await devSession(env, 'a@example.com', '가성당');
  const res = await router.fetch(new Request('http://localhost:8787/api/transactions', {
    method: 'POST', headers: { cookie, origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}',
  }), env);
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test('장부 비우기: 최신 백업이 있어야 하고, 비우면 최초 설정부터 다시', async () => {
  const { storage, api } = ledger();
  assert.equal(backupIsCurrent(storage), true); // 빈 장부는 백업 없이 비울 수 있다
  await api('POST', '/api/setup', setupPayload());
  assert.equal(backupIsCurrent(storage), false); // 백업한 적 없음

  const env = { DB: storageD1(storage), AUTH_MODE: 'server', ACTOR: 'x' };
  await handleApi(new Request('http://local/api/backup'), env);
  assert.equal(backupIsCurrent(storage), true);

  const s = (await api('GET', '/api/settings')).body;
  await new Promise((r) => setTimeout(r, 5)); // 백업 시각 이후의 변경
  await api('POST', '/api/transactions', {
    date: '2026-10-01', direction: 'IN', accountId: s.accounts[0].id, subjectId: s.subjects[0].id, amount: '1000',
  });
  assert.equal(backupIsCurrent(storage), false); // 백업 이후 바뀜

  await resetLedger(storage, FILES);
  assert.equal((await api('GET', '/api/settings')).body.setupCompleted, false);
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 0);
  assert.deepEqual(storage.db.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map((r) => r.name), MIGRATIONS);
  assert.equal((await api('POST', '/api/setup', setupPayload())).status, 200); // 다시 시작할 수 있다
});

test('계정: 장부 비우기·탈퇴는 성당 이름을 그대로 적어야 하고, 다른 사이트 요청·GET 은 거부', async () => {
  const { env, calls } = routerEnv();
  const cookie = await devSession(env, 'a@example.com', '가성당');
  const post = (path, body, origin = 'http://localhost:8787') => router.fetch(new Request(`http://localhost:8787${path}`, {
    method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env);

  assert.equal((await post('/account/reset-ledger', { parishName: '나성당' })).status, 400);
  assert.equal((await post('/account/reset-ledger', { parishName: '가성당' }, 'https://evil.test')).status, 403);
  assert.equal((await router.fetch(new Request('http://localhost:8787/account/withdraw', { headers: { cookie } }), env)).status, 405);
  assert.equal(calls.length, 0);

  const reset = await post('/account/reset-ledger', { parishName: ' 가성당 ' });
  assert.equal(reset.status, 200);
  assert.equal(new URL(calls[0].url).pathname, '/__admin/reset');
});

test('탈퇴: 장부를 지우고 성당·사용자·로그인 정보를 지운다 (다른 성당은 그대로)', async () => {
  const { db, env, calls } = routerEnv();
  const a = await devSession(env, 'a@example.com', '가성당');
  await devSession(env, 'b@example.com', '나성당');
  const parishA = db.prepare("SELECT parish_id FROM users WHERE email = 'a@example.com'").get().parish_id;

  const res = await router.fetch(new Request('http://localhost:8787/account/withdraw', {
    method: 'POST', headers: { cookie: a, origin: 'http://localhost:8787', 'content-type': 'application/json' },
    body: JSON.stringify({ parishName: '가성당' }),
  }), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.getSetCookie()[0], /^__Host-bs_session=; .*Max-Age=0/);
  assert.deepEqual(calls.map((c) => [c.parish, new URL(c.url).pathname]), [[parishA, '/__admin/wipe']]);

  assert.deepEqual(db.prepare('SELECT name FROM parishes').all().map((r) => r.name), ['나성당']);
  assert.deepEqual(db.prepare('SELECT email FROM users').all().map((r) => r.email), ['b@example.com']);
  assert.equal((await router.fetch(new Request('http://localhost:8787/api/settings', { headers: { cookie: a } }), env)).status, 401);
});

// ---------------------------------------------------------------- 함께 쓰는 사람

async function memberCall(env, cookie, method, path, body) {
  const res = await router.fetch(new Request(`http://localhost:8787${path}`, {
    method, headers: { cookie, origin: 'http://localhost:8787', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: res.status, body: await res.json() };
}

test('함께 쓰는 사람: 이메일을 등록해 두면 그 구글 계정으로 로그인할 때 같은 성당에 연결된다', async () => {
  const { db, env, calls } = routerEnv();
  const old = await devSession(env, 'old@example.com', '가성당');
  const added = await memberCall(env, old, 'POST', '/account/members', { email: ' New@Example.com ' });
  assert.equal(added.status, 201);
  assert.equal(added.body.connected, false);
  assert.deepEqual((await memberCall(env, old, 'GET', '/account/members')).body.invites.map((i) => i.email), ['new@example.com']);

  // 새 사무장이 처음 로그인 → 성당 등록 화면 없이 바로 같은 성당
  const fresh = await devSession(env, 'new@example.com');
  const page = await router.fetch(new Request('http://localhost:8787/entry', { headers: { cookie: fresh } }), env);
  assert.equal(await page.text(), 'asset');
  await router.fetch(new Request('http://localhost:8787/api/settings', { headers: { cookie: fresh } }), env);
  const parishOf = (email) => db.prepare('SELECT parish_id FROM users WHERE email = ?').get(email).parish_id;
  assert.equal(calls.at(-1).parish, parishOf('old@example.com'));
  assert.equal(parishOf('new@example.com'), parishOf('old@example.com'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invites').get().n, 0);

  // 새 사무장이 전 사무장을 뺀다 → 전 사무장은 바로 로그아웃
  const removed = await memberCall(env, fresh, 'POST', '/account/members/remove', { email: 'old@example.com' });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.self, false);
  assert.equal((await router.fetch(new Request('http://localhost:8787/api/settings', { headers: { cookie: old } }), env)).status, 401);
  assert.equal(parishOf('old@example.com'), null);

  // 마지막 한 사람은 뺄 수 없다
  const last = await memberCall(env, fresh, 'POST', '/account/members/remove', { email: 'new@example.com' });
  assert.equal(last.body.error.code, 'LAST_MEMBER');
});

test('함께 쓰는 사람: 이미 가입한(성당 없는) 계정은 바로 연결, 다른 성당 계정·중복은 거부, 등록 취소', async () => {
  const { db, env } = routerEnv();
  const a = await devSession(env, 'a@example.com', '가성당');
  await devSession(env, 'b@example.com', '나성당');
  await devSession(env, 'lonely@example.com'); // 가입만 하고 성당 없음

  const now = await memberCall(env, a, 'POST', '/account/members', { email: 'lonely@example.com' });
  assert.equal(now.body.connected, true);
  assert.equal((await memberCall(env, a, 'POST', '/account/members', { email: 'lonely@example.com' })).body.error.code, 'ALREADY_MEMBER');
  assert.equal((await memberCall(env, a, 'POST', '/account/members', { email: 'b@example.com' })).body.error.code, 'OTHER_PARISH');
  assert.equal((await memberCall(env, a, 'POST', '/account/members', { email: 'not-an-email' })).body.error.code, 'BAD_EMAIL');

  await memberCall(env, a, 'POST', '/account/members', { email: 'later@example.com' });
  assert.equal((await memberCall(env, a, 'POST', '/account/members', { email: 'later@example.com' })).body.error.code, 'ALREADY_INVITED');
  const cancel = await memberCall(env, a, 'POST', '/account/members/remove', { email: 'later@example.com' });
  assert.equal(cancel.body.removed, 'invite');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invites').get().n, 0);

  // 다른 성당 사람은 뺄 수 없다
  assert.equal((await memberCall(env, a, 'POST', '/account/members/remove', { email: 'b@example.com' })).body.error.code, 'NOT_MEMBER');
});

test('탈퇴하면 함께 쓰는 사람과 등록된 이메일도 모두 지워진다', async () => {
  const { db, env } = routerEnv();
  const a = await devSession(env, 'a@example.com', '가성당');
  await devSession(env, 'b@example.com');
  await memberCall(env, a, 'POST', '/account/members', { email: 'b@example.com' });
  await memberCall(env, a, 'POST', '/account/members', { email: 'c@example.com' });
  const out = await memberCall(env, a, 'POST', '/account/withdraw', { parishName: '가성당' });
  assert.equal(out.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invites').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM parishes').get().n, 0);
});
