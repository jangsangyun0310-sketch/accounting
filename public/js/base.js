// 주소 모드 판별
//   /p/{성당ID}/...  : 성당별 암호화 모드. 계산·저장은 이 브라우저 안의 엔진이 하고 서버에는 암호문만 보낸다.
//   그 밖           : 서버 모드 (기존 설치, 서버의 D1 사용)
const match = /^\/p\/([A-Za-z0-9_-]{16,64})(?=\/|$)/.exec(location.pathname);

export const PARISH_ID = match ? match[1] : null;
export const BASE = match ? `/p/${match[1]}` : '';
export const isLocalMode = Boolean(match);

/** 화면 주소에 성당 경로를 붙인다. href('/entry?date=..') → '/p/{id}/entry?date=..' */
export const href = (path) => BASE + path;

// 앱 설치(바탕화면 아이콘)용 manifest. 성당별 주소에서는 /p/{id}/manifest.webmanifest 를 써서
// 설치한 아이콘이 그 성당 주소(start_url "./")로 열리게 한다.
const manifest = document.createElement('link');
manifest.rel = 'manifest';
manifest.href = href('/manifest.webmanifest');
document.head.append(manifest);

/** 브라우저가 "앱 설치"를 허락하면 그 신호를 보관해 두었다가 버튼으로 띄운다 */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
window.addEventListener('appinstalled', () => { installPrompt = null; });

/** 이미 설치한 앱 창에서 열렸는지 */
export const isInstalledApp = window.matchMedia('(display-mode: standalone)').matches;

/** 바탕화면 아이콘 만들기. 브라우저가 설치 창을 띄웠으면 true, 못 띄우면 false */
export async function installApp() {
  if (!installPrompt) return false;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  return true;
}
