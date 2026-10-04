// 주소 모드 판별
//   /p/{성당ID}/...  : 성당별 암호화 모드. 계산·저장은 이 브라우저 안의 엔진이 하고 서버에는 암호문만 보낸다.
//   그 밖           : 서버 모드 (기존 설치, 서버의 D1 사용)
const match = /^\/p\/([A-Za-z0-9_-]{16,64})(?=\/|$)/.exec(location.pathname);

export const PARISH_ID = match ? match[1] : null;
export const BASE = match ? `/p/${match[1]}` : '';
export const isLocalMode = Boolean(match);

/** 화면 주소에 성당 경로를 붙인다. href('/entry?date=..') → '/p/{id}/entry?date=..' */
export const href = (path) => BASE + path;
