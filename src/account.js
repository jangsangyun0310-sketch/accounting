// 계정 관리 (설정 → 계정)
//   POST /account/reset-ledger : 장부 비우기. 성당 이름을 그대로 적어야 하고, 최신 백업이 있어야 한다
//   POST /account/withdraw     : 탈퇴. 이 성당의 장부·성당 정보·로그인 정보를 모두 지운다
// 실수로 누르는 일을 막으려고 둘 다 성당 이름을 그대로 다시 적게 한다.

const SESSION_COOKIE = '__Host-bs_session';

export async function handleAccount(request, env, url, session) {
  if (request.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 요청 방식입니다.');
  if (request.headers.get('origin') !== url.origin) return error(403, 'FORBIDDEN', '허용되지 않은 요청입니다.');
  if (!session) return error(401, 'LOGIN_REQUIRED', '로그인이 필요합니다. 다시 로그인해 주세요.');
  if (!session.parish) return error(403, 'PARISH_REQUIRED', '등록된 성당이 없습니다.');

  const body = await request.json().catch(() => ({}));
  const typed = String(body?.parishName ?? '').replace(/\s+/g, ' ').trim();
  if (typed !== session.parish.name) {
    return error(400, 'NAME_MISMATCH', `확인을 위해 성당 이름 "${session.parish.name}"을(를) 그대로 적어 주세요.`);
  }
  const ledger = env.LEDGER.get(env.LEDGER.idFromName(session.parish.id));

  if (url.pathname === '/account/reset-ledger') {
    return ledger.fetch(new Request('https://ledger/__admin/reset', { method: 'POST' }));
  }

  if (url.pathname === '/account/withdraw') {
    // 장부부터 지운다. 장부를 못 지우면 계정도 남겨 둔다 (다시 시도할 수 있게)
    const wiped = await ledger.fetch(new Request('https://ledger/__admin/wipe', { method: 'POST' }));
    if (!wiped.ok) return error(500, 'WIPE_FAILED', '장부를 지우지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    const parishId = session.parish.id;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE parish_id = ?)').bind(parishId),
      env.DB.prepare('DELETE FROM users WHERE parish_id = ?').bind(parishId),
      env.DB.prepare('DELETE FROM parishes WHERE id = ?').bind(parishId),
    ]);
    const res = Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
    res.headers.append('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    return res;
  }

  return error(404, 'NOT_FOUND', '없는 주소입니다.');
}

function error(status, code, message) {
  return Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } });
}
