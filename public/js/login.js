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

const error = MESSAGES[params.get('error')];
if (error) {
  const box = document.getElementById('error');
  box.textContent = error;
  box.hidden = false;
}
