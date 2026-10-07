// 구글 로그인 · 세션 · 성당 등록 · 화면 접근 제한 (src/)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { d1Adapter } from './helpers.js';
import worker from '../src/router.js';
import { safeNext } from '../src/auth.js';

const ORIGIN = 'https://bondang.test';
const CLIENT_ID = 'client-123.apps.googleusercontent.com';

let db;
let env;
const realFetch = globalThis.fetch;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const m of ['0001_accounts.sql', '0002_members.sql']) db.exec(readFileSync(new URL(`../src/migrations/${m}`, import.meta.url), 'utf8'));
  env = {
    DB: d1Adapter(db),
    ASSETS: { fetch: async (req) => new Response(`asset:${new URL(req.url).pathname}`) },
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: 'secret',
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

async function call(path, { method = 'GET', cookies = {}, body, origin } = {}) {
  const headers = new Headers();
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookie) headers.set('cookie', cookie);
  if (origin) headers.set('origin', origin);
  if (body) headers.set('content-type', 'application/json');
  return worker.fetch(new Request(ORIGIN + path, { method, headers, body: body && JSON.stringify(body) }), env);
}

/** 응답의 Set-Cookie 를 { 이름: 값 } 으로 */
function setCookies(res) {
  const out = {};
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

/** 구글 토큰 주소를 흉내: 받은 요청을 기록하고 id_token 을 돌려준다 */
function mockGoogle(claims) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: new URLSearchParams(init.body) });
    return new Response(JSON.stringify({ id_token: `h.${b64(claims(calls.at(-1)))}.s` }));
  };
  return calls;
}

/** 구글 로그인 전체 과정 → 세션 쿠키 */
async function googleLogin({ sub = 'g-1', email = 'office@example.com', next } = {}) {
  const start = await call(`/auth/google${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  const to = new URL(start.headers.get('location'));
  const oauth = setCookies(start)['__Host-bs_oauth'];
  const { nonce } = JSON.parse(Buffer.from(oauth, 'base64url').toString());
  mockGoogle(() => ({
    iss: 'https://accounts.google.com', aud: CLIENT_ID, sub, email, email_verified: true, name: '김사무',
    exp: Math.floor(Date.now() / 1000) + 3600, nonce,
  }));
  const back = await call(`/auth/google/callback?state=${to.searchParams.get('state')}&code=abc`, {
    cookies: { '__Host-bs_oauth': oauth },
  });
  return { back, session: setCookies(back)['__Host-bs_session'] };
}

test('로그인하지 않으면 화면 대신 로그인 화면으로 (돌아올 주소 포함)', async () => {
  const res = await call('/entry?date=2026-10-04');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login?next=%2Fentry%3Fdate%3D2026-10-04');
  assert.equal(await (await call('/login')).text(), 'asset:/login');
});

test('구글 로그인 시작: PKCE·state·nonce 를 붙여 구글로 보낸다', async () => {
  const res = await call('/auth/google?next=/report');
  const to = new URL(res.headers.get('location'));
  assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(to.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(to.searchParams.get('redirect_uri'), `${ORIGIN}/auth/google/callback`);
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(to.searchParams.get('state') && to.searchParams.get('nonce'));
  const cookie = res.headers.getSetCookie()[0];
  assert.match(cookie, /^__Host-bs_oauth=.+; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
});

test('처음 로그인 → 사용자 생성 → 성당 등록 화면 → 등록 후 화면 사용', async () => {
  const { back, session } = await googleLogin({ next: '/entry' });
  assert.equal(back.headers.get('location'), '/entry');
  assert.ok(session);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  // 토큰 원문은 DB 에 없다
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions WHERE token_hash = ?').get(session).n, 0);

  const cookies = { '__Host-bs_session': session };
  assert.equal((await call('/entry', { cookies })).headers.get('location'), '/signup');
  assert.equal(await (await call('/signup', { cookies })).text(), 'asset:/signup');

  const me = await (await call('/auth/me', { cookies })).json();
  assert.equal(me.user.email, 'office@example.com');
  assert.equal(me.parish, null);

  const noAgree = await call('/auth/parish', { method: 'POST', cookies, origin: ORIGIN, body: { name: '예시성당' } });
  assert.equal(noAgree.status, 400);
  const made = await call('/auth/parish', { method: 'POST', cookies, origin: ORIGIN, body: { name: '  예시   성당 ', agree: true } });
  assert.equal(made.status, 201);
  assert.equal((await made.json()).parish.name, '예시 성당');

  assert.equal(await (await call('/entry', { cookies })).text(), 'asset:/entry');
  assert.equal((await call('/login', { cookies })).headers.get('location'), '/');
  assert.equal((await call('/signup', { cookies })).headers.get('location'), '/');
  const again = await call('/auth/parish', { method: 'POST', cookies, origin: ORIGIN, body: { name: '다른성당', agree: true } });
  assert.equal(again.status, 409);
});

test('같은 구글 계정으로 다시 로그인하면 같은 사용자', async () => {
  await googleLogin({ email: 'old@example.com' });
  await googleLogin({ email: 'new@example.com' });
  const rows = db.prepare('SELECT email FROM users').all();
  assert.deepEqual(rows.map((r) => r.email), ['new@example.com']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 2); // 사무실 PC·집 PC 각각
});

test('state 가 다르거나 로그인 쿠키가 없으면 거부', async () => {
  const start = await call('/auth/google');
  const oauth = setCookies(start)['__Host-bs_oauth'];
  const forged = await call('/auth/google/callback?state=other&code=abc', { cookies: { '__Host-bs_oauth': oauth } });
  assert.equal(forged.headers.get('location'), '/login?error=expired');
  const noCookie = await call('/auth/google/callback?state=x&code=abc');
  assert.equal(noCookie.headers.get('location'), '/login?error=expired');
});

test('id_token 내용이 맞지 않으면 거부 (다른 앱용·nonce 불일치·이메일 미확인)', async () => {
  const cases = [
    [{ aud: 'other-app' }, 'google'],
    [{ nonce: 'wrong' }, 'google'],
    [{ exp: Math.floor(Date.now() / 1000) - 10 }, 'google'],
    [{ email_verified: false }, 'email'],
  ];
  for (const [override, error] of cases) {
    const start = await call('/auth/google');
    const oauth = setCookies(start)['__Host-bs_oauth'];
    const { state, nonce } = JSON.parse(Buffer.from(oauth, 'base64url').toString());
    mockGoogle(() => ({
      iss: 'accounts.google.com', aud: CLIENT_ID, sub: 's', email: 'a@b.c', email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600, nonce, ...override,
    }));
    const res = await call(`/auth/google/callback?state=${state}&code=abc`, { cookies: { '__Host-bs_oauth': oauth } });
    assert.equal(res.headers.get('location'), `/login?error=${error}`, JSON.stringify(override));
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
});

test('구글에 보내는 토큰 요청에 code_verifier 와 비밀키가 들어간다', async () => {
  const start = await call('/auth/google');
  const oauth = setCookies(start)['__Host-bs_oauth'];
  const saved = JSON.parse(Buffer.from(oauth, 'base64url').toString());
  const calls = mockGoogle(() => ({
    iss: 'accounts.google.com', aud: CLIENT_ID, sub: 's', email: 'a@b.c', email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600, nonce: saved.nonce,
  }));
  await call(`/auth/google/callback?state=${saved.state}&code=the-code`, { cookies: { '__Host-bs_oauth': oauth } });
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(calls[0].body.get('code'), 'the-code');
  assert.equal(calls[0].body.get('code_verifier'), saved.verifier);
  assert.equal(calls[0].body.get('client_secret'), 'secret');
});

test('로그아웃하면 세션이 지워지고 다시 로그인해야 한다', async () => {
  const { session } = await googleLogin();
  const cookies = { '__Host-bs_session': session };
  const blocked = await call('/auth/logout', { method: 'POST', cookies, origin: 'https://evil.test' });
  assert.equal(blocked.status, 403);
  const out = await call('/auth/logout', { method: 'POST', cookies, origin: ORIGIN });
  assert.equal(out.status, 200);
  assert.match(out.headers.getSetCookie()[0], /^__Host-bs_session=; .*Max-Age=0/);
  assert.equal((await call('/auth/me', { cookies })).status, 401);
});

test('만료된 세션은 쓸 수 없다', async () => {
  const { session } = await googleLogin();
  db.exec("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
  assert.equal((await call('/auth/me', { cookies: { '__Host-bs_session': session } })).status, 401);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
});

test('시험 로그인은 내 컴퓨터(localhost)에서 DEV_LOGIN=1 일 때만', async () => {
  env.DEV_LOGIN = '1';
  assert.equal((await call('/auth/dev-login?email=a@b.c')).status, 404); // 배포 주소에서는 안 됨
  const local = await worker.fetch(new Request('http://localhost:8787/auth/dev-login?email=a@b.c&next=/entry'), env);
  assert.equal(local.status, 302);
  assert.equal(local.headers.get('location'), '/entry');
  delete env.DEV_LOGIN;
  assert.equal((await worker.fetch(new Request('http://localhost:8787/auth/dev-login?email=a@b.c'), env)).status, 404);
});

test('구글 설정이 없으면 로그인 화면에 안내', async () => {
  env.GOOGLE_CLIENT_ID = '';
  assert.equal((await call('/auth/google')).headers.get('location'), '/login?error=config');
});

test('돌아갈 주소는 이 사이트 안만', () => {
  assert.equal(safeNext('/entry?x=1'), '/entry?x=1');
  assert.equal(safeNext('//evil.test'), '/');
  assert.equal(safeNext('/\\evil.test'), '/');
  assert.equal(safeNext('https://evil.test'), '/');
  assert.equal(safeNext(null), '/');
});

test('개인정보처리방침은 로그인 없이 누구나 볼 수 있다', async () => {
  assert.equal(await (await call('/privacy')).text(), 'asset:/privacy');
});
