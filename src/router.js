// 본당살림 요청 처리 (Worker 진입점 src/index.js 가 내보낸다. 테스트도 이 파일을 쓴다)
//   /auth/*   : 구글 로그인 · 세션 · 성당 등록 (src/auth.js)
//   /api/*    : 장부. 로그인한 사용자의 성당 저장소(src/ledger.js)로만 보낸다
//   /account/*: 장부 비우기 · 탈퇴 (src/account.js)
//   /login    : 로그인 화면 (누구나)
//   /signup   : 성당 등록 화면 (로그인했지만 아직 성당이 없는 사용자)
//   그 밖 화면 : 로그인하고 성당이 등록된 사용자만. 아니면 로그인·성당 등록 화면으로 보낸다.
// css·js·그림 같은 프로그램 파일은 wrangler.jsonc 의 run_worker_first 에서 빼서 Worker 를 거치지 않는다.
import { getSession, handleAuth, redirect } from './auth.js';
import { handleAccount } from './account.js';

const PUBLIC_PAGES = new Set(['/login', '/login.html']);
// 로그인과 관계없이 누구나 보는 화면 (구글 로그인 설정·스토어 등록에 주소가 필요)
const OPEN_PAGES = new Set(['/privacy', '/privacy.html']);
const SIGNUP_PAGES = new Set(['/signup', '/signup.html']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/auth/')) return handleAuth(request, env, url);
    if (OPEN_PAGES.has(url.pathname)) return env.ASSETS.fetch(request);

    const session = await getSession(request, env);
    if (url.pathname.startsWith('/api/')) return ledgerApi(request, env, url, session);
    if (url.pathname.startsWith('/account/')) return handleAccount(request, env, url, session);

    if (PUBLIC_PAGES.has(url.pathname)) {
      return session?.parish ? redirect('/') : env.ASSETS.fetch(request);
    }
    if (!session) return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    if (SIGNUP_PAGES.has(url.pathname)) {
      return session.parish ? redirect('/') : env.ASSETS.fetch(request);
    }
    if (!session.parish) return redirect('/signup');
    return env.ASSETS.fetch(request);
  },
};

/** 장부 요청: 로그인한 사용자의 성당 저장소로 넘긴다 */
async function ledgerApi(request, env, url, session) {
  if (!session) return apiError(401, 'LOGIN_REQUIRED', '로그인이 필요합니다. 다시 로그인해 주세요.');
  if (!session.parish) return apiError(403, 'PARISH_REQUIRED', '성당을 먼저 등록해 주세요.');
  if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) {
    return apiError(403, 'FORBIDDEN', '허용되지 않은 요청입니다.');
  }
  const headers = new Headers(request.headers);
  headers.delete('cookie'); // 저장소에는 로그인 쿠키를 넘기지 않는다
  headers.set('x-bondang-actor', session.user.email); // 바깥에서 보낸 같은 이름의 머리글은 덮어쓴다
  const stub = env.LEDGER.get(env.LEDGER.idFromName(session.parish.id));
  return stub.fetch(new Request(request, { headers }));
}

function apiError(status, code, message) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
