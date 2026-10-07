// 계정 관리 (설정 → 함께 쓰는 사람, 초기화 / 탈퇴)
//   GET  /account/members        : 이 성당을 함께 쓰는 사람과 등록만 된 이메일
//   POST /account/members        : 사람 추가 { email }
//   POST /account/members/remove : 사람 빼기 / 등록 취소 { email }. 마지막 한 사람은 뺄 수 없다
//   POST /account/reset-ledger   : 장부 초기화. 성당 이름을 그대로 적어야 하고, 최신 백업이 있어야 한다
//   POST /account/withdraw       : 탈퇴. 이 성당의 장부·성당 정보·로그인 정보를 모두 지운다
// 함께 쓰는 사람은 모두 같은 권한이다 (보기만 하는 권한은 보류, 2026-10-08).
// 초기화·탈퇴는 실수로 누르는 일을 막으려고 성당 이름을 그대로 다시 적게 한다.

const SESSION_COOKIE = '__Host-bs_session';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handleAccount(request, env, url, session) {
  const route = `${request.method} ${url.pathname}`;
  if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) return error(403, 'FORBIDDEN', '허용되지 않은 요청입니다.');
  if (!session) return error(401, 'LOGIN_REQUIRED', '로그인이 필요합니다. 다시 로그인해 주세요.');
  if (!session.parish) return error(403, 'PARISH_REQUIRED', '등록된 성당이 없습니다.');
  if (route === 'GET /account/members') return listMembers(env, session);
  if (request.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 요청 방식입니다.');

  const body = await request.json().catch(() => ({}));
  switch (url.pathname) {
    case '/account/members': return addMember(env, session, body);
    case '/account/members/remove': return removeMember(env, session, body);
    case '/account/reset-ledger': return resetLedger(env, session, body);
    case '/account/withdraw': return withdraw(env, session, body);
    default: return error(404, 'NOT_FOUND', '없는 주소입니다.');
  }
}

// ---------------------------------------------------------------- 함께 쓰는 사람

async function listMembers(env, session) {
  const { results: users } = await env.DB.prepare(
    'SELECT email, name, last_login_at FROM users WHERE parish_id = ? ORDER BY created_at'
  ).bind(session.parish.id).all();
  const { results: invites } = await env.DB.prepare(
    'SELECT email, created_at, created_by FROM invites WHERE parish_id = ? ORDER BY created_at'
  ).bind(session.parish.id).all();
  return json({
    me: session.user.email,
    members: users.map((u) => ({ email: u.email, name: u.name, lastLoginAt: u.last_login_at })),
    invites: invites.map((i) => ({ email: i.email, createdAt: i.created_at, createdBy: i.created_by })),
  });
}

async function addMember(env, session, body) {
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) return error(400, 'BAD_EMAIL', '이메일 주소를 확인해 주세요. (예: name@gmail.com)');

  const user = await env.DB.prepare('SELECT id, parish_id FROM users WHERE lower(email) = ?').bind(email).first();
  if (user?.parish_id === session.parish.id) return error(409, 'ALREADY_MEMBER', '이미 이 성당을 함께 쓰는 사람입니다.');
  if (user?.parish_id) return error(409, 'OTHER_PARISH', '이 계정은 이미 다른 성당에서 쓰고 있습니다. 그 성당에서 먼저 빠져야 합니다.');
  const invite = await env.DB.prepare('SELECT parish_id FROM invites WHERE email = ?').bind(email).first();
  if (invite?.parish_id === session.parish.id) return error(409, 'ALREADY_INVITED', '이미 등록된 이메일입니다. 그 계정으로 로그인하면 연결됩니다.');
  if (invite) return error(409, 'OTHER_PARISH', '이 이메일은 다른 성당에 등록되어 있습니다.');

  if (user) {
    // 가입은 했지만 아직 성당이 없는 사람: 바로 연결
    await env.DB.prepare('UPDATE users SET parish_id = ? WHERE id = ? AND parish_id IS NULL')
      .bind(session.parish.id, user.id).run();
    return json({ ok: true, connected: true }, 201);
  }
  await env.DB.prepare('INSERT INTO invites (email, parish_id, created_at, created_by) VALUES (?, ?, ?, ?)')
    .bind(email, session.parish.id, new Date().toISOString(), session.user.email).run();
  return json({ ok: true, connected: false }, 201);
}

async function removeMember(env, session, body) {
  const email = String(body?.email ?? '').trim().toLowerCase();
  const parishId = session.parish.id;

  const invite = await env.DB.prepare('SELECT email FROM invites WHERE email = ? AND parish_id = ?').bind(email, parishId).first();
  if (invite) {
    await env.DB.prepare('DELETE FROM invites WHERE email = ?').bind(email).run();
    return json({ ok: true, removed: 'invite' });
  }

  const user = await env.DB.prepare('SELECT id FROM users WHERE lower(email) = ? AND parish_id = ?').bind(email, parishId).first();
  if (!user) return error(404, 'NOT_MEMBER', '이 성당을 함께 쓰는 사람이 아닙니다.');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE parish_id = ?').bind(parishId).first('n');
  if (count <= 1) return error(409, 'LAST_MEMBER', '마지막 한 사람은 뺄 수 없습니다. 새 사무장을 먼저 추가하세요. (성당을 그만 쓰려면 [초기화 / 탈퇴])');
  // 성당에서만 빠진다 (구글 계정 기록은 남아 다시 추가할 수 있다). 로그인해 둔 곳은 모두 풀린다.
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET parish_id = NULL WHERE id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  return json({ ok: true, removed: 'member', self: user.id === session.user.id });
}

// ---------------------------------------------------------------- 초기화 / 탈퇴

function nameMismatch(session, body) {
  const typed = String(body?.parishName ?? '').replace(/\s+/g, ' ').trim();
  return typed === session.parish.name ? null
    : error(400, 'NAME_MISMATCH', `확인을 위해 성당 이름 "${session.parish.name}"을(를) 그대로 적어 주세요.`);
}

const ledgerOf = (env, session) => env.LEDGER.get(env.LEDGER.idFromName(session.parish.id));

async function resetLedger(env, session, body) {
  const mismatch = nameMismatch(session, body);
  if (mismatch) return mismatch;
  return ledgerOf(env, session).fetch(new Request('https://ledger/__admin/reset', { method: 'POST' }));
}

async function withdraw(env, session, body) {
  const mismatch = nameMismatch(session, body);
  if (mismatch) return mismatch;
  // 장부부터 지운다. 장부를 못 지우면 계정도 남겨 둔다 (다시 시도할 수 있게)
  const wiped = await ledgerOf(env, session).fetch(new Request('https://ledger/__admin/wipe', { method: 'POST' }));
  if (!wiped.ok) return error(500, 'WIPE_FAILED', '장부를 지우지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
  const parishId = session.parish.id;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE parish_id = ?)').bind(parishId),
    env.DB.prepare('DELETE FROM users WHERE parish_id = ?').bind(parishId),
    env.DB.prepare('DELETE FROM invites WHERE parish_id = ?').bind(parishId),
    env.DB.prepare('DELETE FROM parishes WHERE id = ?').bind(parishId),
  ]);
  const res = json({ ok: true });
  res.headers.append('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return res;
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

function error(status, code, message) {
  return json({ error: { code, message } }, status);
}
