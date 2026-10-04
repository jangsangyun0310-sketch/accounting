// 화면 공용 기초
//   장부는 본당 컴퓨터의 파일에 있고, 계산·저장은 이 브라우저 안의 엔진이 한다 (서버에는 아무것도 보내지 않는다).

/** 화면 주소. 모든 화면이 사이트 바로 아래(/entry 등)에 있다 */
export const href = (path) => path;

// 앱 설치(바탕화면 아이콘)용 manifest
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
