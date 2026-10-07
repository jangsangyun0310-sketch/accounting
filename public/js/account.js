// 로그인 계정 (서버): 지금 로그인한 사용자·성당, 로그아웃

/** { user, parish } — 로그인이 풀렸으면 로그인 화면으로 보낸다 */
export async function currentAccount() {
  const res = await fetch('/auth/me');
  if (res.status === 401) {
    location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    return new Promise(() => {});
  }
  if (!res.ok) throw new Error(`로그인 정보를 불러오지 못했습니다 (${res.status})`);
  return res.json();
}

/** 로그아웃: 서버 세션을 지우고, 이 탭에 기억한 장부 열쇠도 지운다 */
export async function logout() {
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
  try { sessionStorage.clear(); } catch { /* 무시 */ }
  location.replace('/login');
}
