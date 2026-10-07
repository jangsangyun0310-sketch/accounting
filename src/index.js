// 본당살림 Worker 진입점
//   /auth/*   : 구글 로그인 · 세션 · 성당 등록 (src/auth.js)
//   /login    : 로그인 화면 (누구나)
//   /signup   : 성당 등록 화면 (로그인했지만 아직 성당이 없는 사용자)
//   그 밖 화면 : 로그인하고 성당이 등록된 사용자만. 아니면 로그인·성당 등록 화면으로 보낸다.
// css·js·그림 같은 프로그램 파일은 wrangler.jsonc 의 run_worker_first 에서 빼서 Worker 를 거치지 않는다.
import { getSession, handleAuth, redirect } from './auth.js';

const PUBLIC_PAGES = new Set(['/login', '/login.html']);
const SIGNUP_PAGES = new Set(['/signup', '/signup.html']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/auth/')) return handleAuth(request, env, url);

    const session = await getSession(request, env);
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
