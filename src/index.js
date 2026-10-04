// 본당살림 Worker 진입점
//   /api/*      : 서버 D1 모드 (기존 설치, Deploy to Cloudflare 로 성당별 설치)
//   /p/{id}/... : 성당별 암호화 모드의 화면. 계산은 브라우저 안에서 하고 서버는 암호문만 보관한다.
//   그 밖       : public/ 정적 파일
import { handleApi } from '../public/core/engine.js';

const PARISH_PATH = /^\/p\/[A-Za-z0-9_-]{16,64}(\/.*)?$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);

    // 성당별 주소의 화면: /p/{id}/entry → /entry 화면 파일 (데이터는 브라우저가 따로 연다)
    const m = PARISH_PATH.exec(url.pathname);
    if (m) {
      const page = !m[1] || m[1] === '/' ? '/' : m[1];
      return env.ASSETS.fetch(new Request(new URL(page + url.search, url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
