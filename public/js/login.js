// 로그인 화면: 구글 로그인 버튼에 돌아갈 화면(next)을 붙이고, 실패 이유를 보여 준다
const params = new URLSearchParams(location.search);

const MESSAGES = {
  config: '구글 로그인이 아직 준비되지 않았습니다. 운영자에게 알려 주세요.',
  expired: '로그인 시간이 지났습니다. 버튼을 다시 눌러 주세요.',
  denied: '구글 로그인을 취소했습니다.',
  google: '구글 로그인을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  email: '이메일 확인이 끝난 구글 계정만 쓸 수 있습니다.',
};

const next = params.get('next');
if (next) document.getElementById('google').href = `/auth/google?next=${encodeURIComponent(next)}`;

const error = MESSAGES[params.get('error')]
  ?? (params.has('bye') ? '탈퇴했습니다. 장부와 계정을 모두 지웠습니다. 그동안 본당살림을 써 주셔서 감사합니다.' : null);
if (error) {
  const box = document.getElementById('error');
  box.textContent = error;
  if (!MESSAGES[params.get('error')]) box.className = 'notice'; // 탈퇴 안내는 오류가 아니므로 빨간 글씨 대신
  box.hidden = false;
}

// 카카오톡·네이버·밴드 같은 앱 안의 브라우저는 휴대폰에 로그인된 구글 계정을 모른다 (이메일·비밀번호를 다시 쳐야 함).
// 휴대폰 기본 브라우저(크롬·삼성 인터넷)로 넘겨서 계정만 눌러 로그인하게 한다.
const ua = navigator.userAgent;
const here = location.href;
const box = document.getElementById('inapp');
const isAndroid = /Android/i.test(ua);

if (/KAKAOTALK/i.test(ua)) {
  // 카카오톡: 기본 브라우저로 바로 연다
  location.href = `kakaotalk://web/openExternal?url=${encodeURIComponent(here)}`;
  box.innerHTML = '휴대폰 기본 브라우저에서 여는 중입니다… 열리지 않으면 오른쪽 아래 <b>⋮</b> → <b>다른 브라우저로 열기</b>를 누르세요.';
  box.hidden = false;
} else if (/ Line\//i.test(ua) && !params.has('openExternalBrowser')) {
  // 라인: 주소에 표시를 붙이면 바깥 브라우저로 연다
  const url = new URL(here);
  url.searchParams.set('openExternalBrowser', '1');
  location.replace(url.toString());
} else if (/NAVER\(|Instagram|FBAN|FBAV|BAND\/|DaumApps|SamsungBrowser\/.*CrossApp|; wv\)/i.test(ua)) {
  // 그 밖의 앱 안 브라우저: 버튼과 안내
  const chrome = `intent://${here.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;end`;
  box.innerHTML = `앱 안의 브라우저에서는 구글 로그인이 번거롭습니다. ${isAndroid
    ? `<a class="button" href="${chrome}">크롬으로 열기</a>`
    : '오른쪽 아래(또는 위) <b>⋯</b> → <b>Safari로 열기</b>를 누르세요.'}`;
  box.hidden = false;
}
