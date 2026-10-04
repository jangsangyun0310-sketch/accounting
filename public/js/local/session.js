// 성당별 모드의 "열린 장부"
//   비밀번호 → 열쇠 → 서버에서 암호문 받기 → 브라우저 안에서 풀기 → 엔진.
//   자료가 바뀔 때마다 다시 암호화해서 서버에 저장한다 (서버는 암호문만 받는다).
//   열쇠는 이 탭이 열려 있는 동안만 sessionStorage 에 둔다 (탭을 닫거나 [잠금]을 누르면 사라짐).
import { PARISH_ID } from '../base.js';
import { openEngine } from './engine.js';
import { decodeKey, deriveKeys, encodeKey, importEncKey, newKdf, seal, unseal } from './crypto.js';

const keyStoreName = (id) => `bondang.key.${id}`;

export function rememberKeys(id, keys) {
  try {
    sessionStorage.setItem(keyStoreName(id), JSON.stringify({ enc: encodeKey(keys.rawEnc), auth: keys.authHex }));
  } catch { /* 저장 불가 환경: 페이지를 옮길 때마다 비밀번호를 다시 묻는다 */ }
}

function loadKeys() {
  try {
    const s = JSON.parse(sessionStorage.getItem(keyStoreName(PARISH_ID)));
    return s ? { rawEnc: decodeKey(s.enc), authHex: s.auth } : null;
  } catch {
    return null;
  }
}

/** 장부 잠그기: 열쇠를 지우고 비밀번호 화면으로 */
export function lock() {
  try { sessionStorage.removeItem(keyStoreName(PARISH_ID)); } catch { /* 무시 */ }
  location.href = `/p/${PARISH_ID}/`;
}

async function errorFrom(res) {
  const data = await res.json().catch(() => null);
  const err = new Error(data?.error?.message || `요청 실패 (${res.status})`);
  err.status = res.status;
  err.code = data?.error?.code;
  return err;
}

async function pull(authHex) {
  const res = await fetch(`/vault/${PARISH_ID}`, { headers: { authorization: `Vault ${authHex}` } });
  if (!res.ok) throw await errorFrom(res);
  return { blob: new Uint8Array(await res.arrayBuffer()), version: Number(res.headers.get('x-vault-version')) };
}

let state = null; // { keys, encKey, version }
let enginePromise = null;

/** 장부를 한 번만 열어 엔진을 돌려준다. 열쇠가 없으면 비밀번호를 묻는다 */
export function ready() {
  enginePromise ??= (async () => {
    let keys = loadKeys();
    let pulled = null;
    if (keys) {
      try {
        pulled = await pull(keys.authHex);
      } catch (err) {
        if (err.status !== 401) throw err;
        keys = null; // 다른 곳에서 비밀번호가 바뀐 경우
      }
    }
    if (!keys) ({ keys, pulled } = await unlockScreen());
    const encKey = await importEncKey(keys.rawEnc);
    const bytes = await unseal(pulled.blob, encKey, PARISH_ID);
    state = { keys, encKey, version: pulled.version };
    return openEngine(bytes, { onChange: save });
  })();
  return enginePromise;
}

async function save(bytes) {
  const blob = await seal(bytes, state.encKey, PARISH_ID);
  const res = await fetch(`/vault/${PARISH_ID}`, {
    method: 'PUT',
    headers: { authorization: `Vault ${state.keys.authHex}`, 'x-expected-version': String(state.version) },
    body: blob,
  });
  if (!res.ok) throw await errorFrom(res);
  state.version = (await res.json()).version;
}

/** 현재 비밀번호가 맞는지 (열쇠를 다시 만들어 비교) */
export async function checkPassword(password) {
  await ready();
  const meta = await (await fetch(`/vault/${PARISH_ID}/meta`)).json();
  const keys = await deriveKeys(password, meta.kdf);
  return keys.authHex === state.keys.authHex;
}

/** 비밀번호 바꾸기: 새 열쇠로 다시 암호화해서 한 번에 교체 */
export async function changePassword(newPassword) {
  const engine = await ready();
  const kdf = newKdf();
  const keys = await deriveKeys(newPassword, kdf);
  const encKey = await importEncKey(keys.rawEnc);
  const blob = await seal(engine.exportBytes(), encKey, PARISH_ID);
  const res = await fetch(`/vault/${PARISH_ID}/rekey`, {
    method: 'POST',
    headers: {
      authorization: `Vault ${state.keys.authHex}`,
      'x-expected-version': String(state.version),
      'x-new-auth': keys.authHex,
      'x-vault-kdf': JSON.stringify(kdf),
    },
    body: blob,
  });
  if (!res.ok) throw await errorFrom(res);
  state = { keys, encKey, version: (await res.json()).version };
  rememberKeys(PARISH_ID, keys);
}

// ---------------------------------------------------------------- 비밀번호 화면

function unlockScreen() {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'unlock-screen';
    box.innerHTML = `
      <form class="unlock-box" autocomplete="off">
        <img src="/img/logo.png" alt="본당살림" width="200" height="56">
        <h2>장부 열기</h2>
        <label>비밀번호 <input type="password" id="unlock-password" required autofocus></label>
        <button type="submit">열기</button>
        <p class="error" id="unlock-error" role="alert"></p>
        <p class="help">이 장부의 자료는 비밀번호로 암호화되어 있습니다. 비밀번호를 모르면 누구도(프로그램 개발자 포함) 열 수 없습니다.</p>
        <p class="help">처음 쓰시나요? <a href="/new">새 장부 만들기</a></p>
      </form>`;
    document.body.append(box);
    const form = box.querySelector('form');
    const input = box.querySelector('#unlock-password');
    const message = box.querySelector('#unlock-error');
    input.focus();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      message.textContent = '';
      button.textContent = '확인 중…';
      try {
        const metaRes = await fetch(`/vault/${PARISH_ID}/meta`);
        if (!metaRes.ok) throw await errorFrom(metaRes);
        const { kdf } = await metaRes.json();
        const keys = await deriveKeys(input.value, kdf);
        const pulled = await pull(keys.authHex);
        rememberKeys(PARISH_ID, keys);
        box.remove();
        resolve({ keys, pulled });
      } catch (err) {
        message.textContent = err.message;
        input.select();
        button.disabled = false;
        button.textContent = '열기';
      }
    });
  });
}
