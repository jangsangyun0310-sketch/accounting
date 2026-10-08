// 본당살림 API 엔진: 거래·마감·결산 규칙을 처리한다.
// 서버(Worker, D1)와 브라우저(성당별 암호화 모드, sqlite-wasm) 양쪽에서 같은 코드로 동작한다.
// env.DB 는 D1 과 같은 prepare/bind/first/all/run/batch 를 제공하는 객체면 된다.
import { ApiError, errorResponse, json } from './lib/http.js';
import { getActor } from './lib/auth.js';
import { translateDbError } from './lib/db.js';
import { MoneyError } from '../js/shared/money.js';
import * as system from './routes/system.js';
import * as setup from './routes/setup.js';
import * as settings from './routes/settings.js';
import * as transactions from './routes/transactions.js';
import * as closings from './routes/closings.js';
import * as reports from './routes/reports.js';
import * as backup from './routes/backup.js';
import * as budgets from './routes/budgets.js';
import * as journal from './routes/journal.js';

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
  ['PUT', '/api/approval-steps/daily', settings.updateDailyApprovalSteps],
  ['PUT', '/api/mass-schedule', settings.updateMassSchedule],
  ['PUT', '/api/journal-settings', settings.updateJournalSettings],
  ['GET', '/api/day', transactions.getDay],
  ['GET', '/api/transactions', transactions.search],
  ['POST', '/api/transactions', transactions.create],
  ['PUT', '/api/transactions/:id', transactions.update],
  ['DELETE', '/api/transactions/:id', transactions.remove],
  ['POST', '/api/transfers', transactions.createTransfer],
  ['GET', '/api/closings', closings.list],
  ['GET', '/api/closing-events', closings.events],
  ['GET', '/api/closings/:date', closings.detail],
  ['POST', '/api/closings/:date/close', closings.close],
  ['POST', '/api/closings/:date/reopen', closings.reopen],
  ['GET', '/api/reports/daily', reports.daily],
  ['GET', '/api/reports/period', reports.period],
  ['GET', '/api/budgets', budgets.list],
  ['PUT', '/api/budgets', budgets.save],
  ['GET', '/api/journal', journal.get],
  ['PUT', '/api/journal', journal.save],
  ['GET', '/api/backup', backup.download],
  ['GET', '/api/backup/status', backup.status],
  ['POST', '/api/backup/log', backup.log],
  ['POST', '/api/restore', backup.restore],
].map(([method, path, handler]) => {
  const keys = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
  return { method, pattern, keys, handler };
});

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

/** /api/* 요청 하나를 처리해 Response 를 돌려준다 */
export async function handleApi(request, env, url = new URL(request.url)) {
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
