// 새 성당 장부 만들기: 비밀번호 → 열쇠 → 빈 장부 암호화 → 서버 보관함 생성 → 최초 설정 화면
import { deriveKeys, newKdf, randomId, seal } from './local/crypto.js';
import { openEngine } from './local/engine.js';
import { rememberKeys } from './local/session.js';

const $ = (id) => document.getElementById(id);

$('start-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('start-error');
  error.textContent = '';
  const pw = $('pw1').value;
  if (pw.length < 8) { error.textContent = '비밀번호는 8자 이상으로 정하세요.'; return; }
  if (pw !== $('pw2').value) { error.textContent = '비밀번호 확인이 다릅니다.'; $('pw2').select(); return; }
  if (!$('ack').checked) { error.textContent = '안내를 확인하고 체크해 주세요.'; return; }

  const button = $('start');
  button.disabled = true;
  button.textContent = '장부를 만드는 중…';
  try {
    const kdf = newKdf();
    const keys = await deriveKeys(pw, kdf);
    const engine = await openEngine(null); // 표 구조만 있는 빈 장부
    const bytes = engine.exportBytes();
    engine.close();

    for (let attempt = 0; attempt < 3; attempt++) {
      const id = randomId();
      const res = await fetch(`/vault/${id}`, {
        method: 'POST',
        headers: { authorization: `Vault ${keys.authHex}`, 'x-vault-kdf': JSON.stringify(kdf) },
        body: await seal(bytes, keys.encKey, id),
      });
      if (res.status === 409) continue; // 매우 드문 ID 충돌: 다시
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || `장부를 만들지 못했습니다 (${res.status})`);
      }
      rememberKeys(id, keys);
      location.replace(`/p/${id}/setup`);
      return;
    }
    throw new Error('장부를 만들지 못했습니다. 다시 시도하세요.');
  } catch (err) {
    error.textContent = err.message;
    button.disabled = false;
    button.textContent = '장부 만들기';
  }
});
