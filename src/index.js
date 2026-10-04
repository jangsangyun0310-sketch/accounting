// 본당살림 Worker 진입점
// /api/* 요청만 Worker 가 처리하고, 나머지는 public/ 정적 파일이 그대로 제공된다.
import { ApiError, errorResponse, json } from './lib/http.js';
import { getActor } from './lib/auth.js';
import { translateDbError } from './lib/db.js';
import { MoneyError } from '../public/js/shared/money.js';
import * as system from './routes/system.js';
import * as setup from './routes/setup.js';
import * as settings from './routes/settings.js';
import * as transactions from './routes/transactions.js';

const routes = [
  ['GET', '/api/health', system.health],
  ['GET', '/api/me', system.me],
  ['GET', '/api/balances', system.getBalances],
  ['GET', '/api/settings', settings.getSettings],
  ['POST', '/api/setup', setup.runSetup],
  ['PUT', '/api/settings/parish', settings.updateParish],
  ['POST', '/api/accounts', settings.createAccount],
  ['POST', '/api/accounts/reorder', settings.reorderAccounts],
  ['PUT', '/api/accounts/:id', settings.updateAccount],
  ['DELETE', '/api/accounts/:id', settings.deleteAccount],
  ['POST', '/api/subjects', settings.createSubject],
  ['POST', '/api/subjects/reorder', settings.reorderSubjects],
  ['PUT', '/api/subjects/:id', settings.updateSubject],
  ['DELETE', '/api/subjects/:id', settings.deleteSubject],
  ['PUT', '/api/approval-steps', settings.updateApprovalSteps],
  ['GET', '/api/day', transactions.getDay],
  ['GET', '/api/transactions', transactions.search],
  ['POST', '/api/transactions', transactions.create],
  ['GET', '/api/transactions/:id', transactions.detail],
  ['POST', '/api/transactions/:id/void', transactions.voidTx],
  ['POST', '/api/transactions/:id/replace', transactions.replace],
  ['POST', '/api/transfers', transactions.createTransfer],
].map(([method, path, handler]) => {
  const keys = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  return { method, pattern, keys, handler };
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    return handleApi(request, env, url);
  },
};

function matchRoute(method, pathname) {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return { handler: r.handler, params };
  }
  if (pathMatched) throw new ApiError(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 요청 방식입니다.');
  throw new ApiError(404, 'NOT_FOUND', '요청한 기능을 찾을 수 없습니다.');
}

async function handleApi(request, env, url) {
  try {
    const { handler, params } = matchRoute(request.method, url.pathname);
    // 변경 요청은 JSON 만 허용: 다른 사이트의 폼 전송(CSRF)은 이 헤더를 붙일 수 없다
    if (request.method !== 'GET' && request.method !== 'DELETE'
        && !(request.headers.get('content-type') || '').startsWith('application/json')) {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '요청 형식이 올바르지 않습니다.');
    }
    const actor = await getActor(request, env);
    return await handler({ request, env, url, actor, params });
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
