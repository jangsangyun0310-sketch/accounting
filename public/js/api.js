// API 호출 공용 함수. 오류는 사용자 메시지를 담은 Error 로 던진다.
// /api/* 는 서버가 로그인한 사용자의 성당 장부로 보낸다.

/** 장부 서버에 보낸다. 로그인이 풀렸으면 로그인 화면으로 */
export async function apiFetch(path, init = {}) {
  const res = await fetch(path, init);
  if (res.status === 401) {
    location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    return new Promise(() => {}); // 이동 중에는 이후 코드 실행 안 함
  }
  return res;
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
