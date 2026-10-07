// 성당 등록 화면: 구글로 처음 로그인한 사용자가 성당 이름을 등록한다
import { esc } from './api.js';
import { logout } from './account.js';

const form = document.getElementById('form');
const message = document.getElementById('message');

const res = await fetch('/auth/me');
if (res.ok) {
  const { user } = await res.json();
  document.getElementById('account').innerHTML = `${esc(user.email)}`;
} else {
  location.replace('/login');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  message.textContent = '';
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const r = await fetch('/auth/parish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: form.querySelector('#name').value, agree: form.querySelector('#agree').checked }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok && r.status !== 409) throw new Error(data?.error?.message || `등록하지 못했습니다 (${r.status})`);
    location.replace('/');
  } catch (err) {
    message.textContent = err.message;
    button.disabled = false;
  }
});

document.getElementById('switch').addEventListener('click', logout);
