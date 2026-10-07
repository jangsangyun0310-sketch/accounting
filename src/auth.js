// 구글 로그인 · 로그인 세션 · 성당 등록
//   /auth/google           구글 로그인 화면으로 보냄 (PKCE + state + nonce)
//   /auth/google/callback  구글에서 돌아옴 → 사용자 찾기/만들기 → 세션 쿠키
//   /auth/me               지금 로그인한 사용자와 성당
//   /auth/parish           (POST) 처음 가입한 사용자의 성당 등록
//   /auth/logout           (POST) 로그아웃
//   /auth/dev-login        내 컴퓨터(localhost)에서 DEV_LOGIN=1 일 때만: 구글 없이 시험 로그인

const SESSION_COOKIE = '__Host-bs_session';
const OAUTH_COOKIE = '__Host-bs_oauth';
const SESSION_DAYS = 30;
const OAUTH_MINUTES = 10;

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

export async function handleAuth(request, env, url) {
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case 'GET /auth/google': return startGoogle(env, url);
    case 'GET /auth/google/callback': return googleCallback(request, env, url);
    case 'GET /auth/me': return me(request, env);
    case 'POST /auth/parish': return sameOrigin(request, url) ?? createParish(request, env);
    case 'POST /auth/logout': return sameOrigin(request, url) ?? logout(request, env);
    case 'GET /auth/dev-login': return devLogin(env, url);
    default: return json({ error: { code: 'NOT_FOUND', message: '없는 주소입니다.' } }, 404);
  }
}

// ---------------------------------------------------------------- 세션

/**
 * 요청의 세션 쿠키로 { user, parish } 를 찾는다. 없거나 만료면 null.
 * 아직 성당이 없는 사용자의 이메일이 어느 성당에 등록되어 있으면(함께 쓰는 사람) 여기서 그 성당에 연결한다.
 */
export async function getSession(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const find = () => env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.parish_id, p.name AS parish_name, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN parishes p ON p.id = u.parish_id
      WHERE s.token_hash = ?`
  ).bind(tokenHash).first();
  let row = await find();
  if (!row) return null;
  if (row.expires_at <= new Date().toISOString()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  if (!row.parish_id && await acceptInvite(env, row.id, row.email)) row = await find();
  return {
    user: { id: row.id, email: row.email, name: row.name },
    parish: row.parish_id ? { id: row.parish_id, name: row.parish_name } : null,
  };
}

/** 이 이메일로 등록된 성당이 있으면 사용자를 그 성당에 연결하고 등록을 지운다. 연결했으면 true */
async function acceptInvite(env, userId, email) {
  const invite = await env.DB.prepare('SELECT parish_id FROM invites WHERE email = ?').bind(email.toLowerCase()).first();
  if (!invite) return false;
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET parish_id = ? WHERE id = ? AND parish_id IS NULL').bind(invite.parish_id, userId),
    env.DB.prepare('DELETE FROM invites WHERE email = ?').bind(email.toLowerCase()),
  ]);
  return true;
}

/** 로그인 성공: 세션을 만들고 쿠키를 붙여 next 로 보낸다 */
async function signIn(env, userId, next) {
  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400_000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(userId, now.toISOString()),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(token), userId, now.toISOString(), expires.toISOString()),
  ]);
  return redirect(next, [
    cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400),
    cookie(OAUTH_COOKIE, '', 0),
  ]);
}

/** 구글 계정 고유번호로 사용자를 찾고, 없으면 만든다. 사용자 ID */
async function upsertUser(env, { sub, email, name }) {
  const now = new Date().toISOString();
  const found = await env.DB.prepare('SELECT id FROM users WHERE google_sub = ?').bind(sub).first();
  if (found) {
    await env.DB.prepare('UPDATE users SET email = ?, name = ?, last_login_at = ? WHERE id = ?')
      .bind(email, name ?? null, now, found.id).run();
    return found.id;
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, google_sub, email, name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, sub, email, name ?? null, now, now).run();
  return id;
}

// ---------------------------------------------------------------- 구글 로그인

async function startGoogle(env, url) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return loginError('config');
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const next = safeNext(url.searchParams.get('next'));
  const auth = new URL(GOOGLE_AUTH);
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  const saved = base64url(new TextEncoder().encode(JSON.stringify({ state, nonce, verifier, next })));
  return redirect(auth.toString(), [cookie(OAUTH_COOKIE, saved, OAUTH_MINUTES * 60)]);
}

async function googleCallback(request, env, url) {
  let saved;
  try {
    saved = JSON.parse(new TextDecoder().decode(unbase64url(readCookie(request, OAUTH_COOKIE) ?? '')));
  } catch {
    saved = null;
  }
  // 다른 사이트가 꾸며 보낸 요청이 아닌지: 로그인을 시작할 때 쿠키에 둔 state 와 같아야 한다
  if (!saved?.state || saved.state !== url.searchParams.get('state')) return loginError('expired');
  if (url.searchParams.get('error')) return loginError('denied');
  const code = url.searchParams.get('code');
  if (!code) return loginError('denied');

  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/google/callback`,
      grant_type: 'authorization_code',
      code_verifier: saved.verifier,
    }),
  });
  if (!res.ok) {
    // 구글이 알려 준 이유만 남긴다 (예: invalid_client = 보안 비밀이 틀림, redirect_uri_mismatch)
    const detail = await res.json().catch(() => ({}));
    console.warn('google token error', res.status, detail.error, detail.error_description);
    return loginError('google');
  }
  const { id_token: idToken } = await res.json();

  // id_token 은 구글 토큰 주소에서 비밀키로 직접 받은 것이라 서명 대신 내용만 확인한다 (OpenID Connect 3.1.3.7)
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(unbase64url(idToken.split('.')[1])));
  } catch {
    return loginError('google');
  }
  const valid = GOOGLE_ISSUERS.includes(claims.iss) && claims.aud === env.GOOGLE_CLIENT_ID
    && claims.exp * 1000 > Date.now() && claims.nonce === saved.nonce && claims.sub;
  if (!valid) {
    console.warn('google id_token rejected', {
      iss: GOOGLE_ISSUERS.includes(claims.iss), aud: claims.aud === env.GOOGLE_CLIENT_ID,
      exp: claims.exp * 1000 > Date.now(), nonce: claims.nonce === saved.nonce, sub: !!claims.sub,
    });
    return loginError('google');
  }
  if (!claims.email || claims.email_verified !== true) return loginError('email');

  const userId = await upsertUser(env, { sub: claims.sub, email: claims.email, name: claims.name });
  return signIn(env, userId, saved.next);
}

/** 내 컴퓨터에서 시험할 때만: 구글 없이 이메일로 로그인 */
async function devLogin(env, url) {
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  const email = url.searchParams.get('email');
  if (env.DEV_LOGIN !== '1' || !local || !email) {
    return json({ error: { code: 'NOT_FOUND', message: '없는 주소입니다.' } }, 404);
  }
  const userId = await upsertUser(env, { sub: `dev:${email}`, email, name: email.split('@')[0] });
  return signIn(env, userId, safeNext(url.searchParams.get('next')));
}

// ---------------------------------------------------------------- API

async function me(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: { code: 'LOGIN_REQUIRED', message: '로그인이 필요합니다.' } }, 401);
  return json(session);
}

async function createParish(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: { code: 'LOGIN_REQUIRED', message: '로그인이 필요합니다.' } }, 401);
  if (session.parish) return json({ error: { code: 'ALREADY_JOINED', message: '이미 성당이 등록되어 있습니다.' } }, 409);
  const body = await request.json().catch(() => ({}));
  const name = String(body?.name ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return json({ error: { code: 'NAME_REQUIRED', message: '성당 이름을 적어 주세요.' } }, 400);
  if (name.length > 50) return json({ error: { code: 'NAME_TOO_LONG', message: '성당 이름은 50자까지 쓸 수 있습니다.' } }, 400);
  if (body?.agree !== true) {
    return json({ error: { code: 'AGREE_REQUIRED', message: '정보 보관에 동의해야 사용할 수 있습니다.' } }, 400);
  }
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO parishes (id, name, created_at) VALUES (?, ?, ?)').bind(id, name, new Date().toISOString()),
    env.DB.prepare('UPDATE users SET parish_id = ? WHERE id = ? AND parish_id IS NULL').bind(id, session.user.id),
  ]);
  return json({ parish: { id, name } }, 201);
}

async function logout(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  const res = json({ ok: true });
  res.headers.append('set-cookie', cookie(SESSION_COOKIE, '', 0));
  return res;
}

// ---------------------------------------------------------------- 도구

/** 다른 사이트에서 보낸 POST 를 막는다 (쿠키 SameSite=Lax 와 함께 이중 확인) */
function sameOrigin(request, url) {
  if (request.headers.get('origin') === url.origin) return null;
  return json({ error: { code: 'FORBIDDEN', message: '허용되지 않은 요청입니다.' } }, 403);
}

/** 로그인 뒤 돌아갈 곳: 이 사이트 안의 경로만 허용 */
export function safeNext(next) {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/';
}

function loginError(code) {
  return redirect(`/login?error=${code}`, [cookie(OAUTH_COOKIE, '', 0)]);
}

export function redirect(location, cookies = []) {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request, name) {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(text) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}
