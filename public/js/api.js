// API 호출 공용 함수. 오류는 사용자 메시지를 담은 Error 로 던진다.
// 성당별 모드(/p/{id}/...)에서는 서버 대신 이 브라우저 안의 엔진이 처리한다.
import { isLocalMode } from './base.js';

/** fetch 와 같은 모양. 성당별 모드면 로컬 엔진으로 보낸다 */
export async function apiFetch(path, init = {}) {
  if (!isLocalMode) return fetch(path, init);
  const { ready } = await import('./local/session.js');
  const engine = await ready();
  return engine.fetch(path, init);
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await apiFetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error?.message || `요청 실패 (${res.status})`);
    err.code = data?.error?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 텍스트를 안전하게 HTML 에 넣기 위한 이스케이프 */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
