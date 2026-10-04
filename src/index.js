// 본당살림 Worker 진입점
//   /api/*      : 서버 D1 모드 (기존 설치, Deploy to Cloudflare 로 성당별 설치)
//   /p/{id}/... : 성당별 암호화 모드의 화면. 계산은 브라우저 안에서 하고 서버는 암호문만 보관한다.
//   그 밖       : public/ 정적 파일
import { handleApi } from '../public/core/engine.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
    return env.ASSETS.fetch(request);
  },
};
