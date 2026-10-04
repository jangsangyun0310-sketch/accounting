// 본당살림 Worker 진입점
// /api/* 요청만 Worker 가 처리하고, 나머지는 public/ 정적 파일이 그대로 제공된다.
import { ApiError, errorResponse, json } from './lib/http.js';
import { getActor } from './lib/auth.js';
import { translateDbError } from './lib/db.js';
import { MoneyError } from '../public/js/shared/money.js';
import * as system from './routes/system.js';

const routes = [
  ['GET', '/api/health', system.health],
  ['GET', '/api/me', system.me],
  ['GET', '/api/settings', system.getSettings],
  ['GET', '/api/balances', system.getBalances],
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    return handleApi(request, env, url);
  },
};

async function handleApi(request, env, url) {
  try {
    const matches = routes.filter(([, path]) => path === url.pathname);
    if (matches.length === 0) throw new ApiError(404, 'NOT_FOUND', '요청한 기능을 찾을 수 없습니다.');
    const route = matches.find(([method]) => method === request.method);
    if (!route) throw new ApiError(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 요청 방식입니다.');

    const actor = await getActor(request, env);
    return await route[2]({ request, env, url, actor });
  } catch (err) {
    if (err instanceof ApiError) return errorResponse(err);
    if (err instanceof MoneyError) return errorResponse(new ApiError(400, 'BAD_AMOUNT', err.message));
    try {
      return errorResponse(translateDbError(err));
    } catch {
      console.error(err);
      return json({ error: { code: 'INTERNAL', message: '처리 중 오류가 발생했습니다.' } }, 500);
    }
  }
}
