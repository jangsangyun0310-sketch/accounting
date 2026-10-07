// 열린 장부
//   본당 컴퓨터의 장부 파일(.bondang) → 비밀번호로 풀기 → 브라우저 안의 엔진.
//   자료가 바뀔 때마다 다시 잠가서 그 파일에 바로 저장한다. 서버에는 아무것도 보내지 않는다.
//   풀린 열쇠는 이 탭이 열려 있는 동안만 sessionStorage 에 둔다 (탭·창을 닫으면 사라짐).
import { openEngine } from './engine.js';
import { decodeKey, deriveKeys, encodeKey, importEncKey } from './crypto.js';
import {
  FILE_EXT, FILE_TYPES, fileAccessSupported, fileError, forgetHandle, newLedgerKeys, readLedgerHandle,
  recallHandle, rememberHandle, sealLedger, unsealLedger, writeHandle,
} from './ledger-file.js';
import { todayKST } from '../shared/dates.js';

const KEY_STORE = 'bondang.key';

function rememberKey(id, rawEnc) {
  try { sessionStorage.setItem(KEY_STORE, JSON.stringify({ id, enc: encodeKey(rawEnc) })); } catch { /* 페이지를 옮길 때마다 비밀번호를 다시 묻는다 */ }
}

function recallKey() {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY_STORE));
    return s ? { id: s.id, rawEnc: decodeKey(s.enc) } : null;
  } catch {
    return null;
  }
}

let state = null; // { handle, header, encKey, rawEnc, lastModified }
let enginePromise = null;

/** 장부를 한 번만 열어 엔진을 돌려준다. 열 수 없으면 시작 화면을 띄운다 */
export function ready() {
  enginePromise ??= (async () => {
    if (!fileAccessSupported) return unsupportedScreen();
    const opened = (await reopen()) ?? (await startScreen());
    state = opened.state;
    return openEngine(opened.dbBytes, { onChange: save });
  })();
  return enginePromise;
}

/** 같은 탭에서 화면을 옮긴 경우: 기억한 파일과 열쇠로 바로 연다 */
async function reopen() {
  const handle = await recallHandle();
  const key = recallKey();
  if (!handle || !key) return null;
  try {
    let permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission === 'prompt') permission = await permissionScreen(handle);
    if (permission !== 'granted') return null;
    const file = await readLedgerHandle(handle);
    if (file.header.id !== key.id) return null;
    const encKey = await importEncKey(key.rawEnc);
    const dbBytes = await unsealLedger(file.header, file.sealed, encKey);
    return { dbBytes, state: { handle, header: file.header, encKey, rawEnc: key.rawEnc, lastModified: file.lastModified } };
  } catch {
    return null; // 파일이 옮겨졌거나 바뀐 경우: 시작 화면에서 다시 연다
  }
}

async function save(dbBytes) {
  const { handle } = state;
  let current;
  try {
    current = await handle.getFile();
  } catch {
    throw fileError('장부 파일을 찾을 수 없습니다. 파일을 옮기거나 지우지 않았는지 확인하세요.', 'FILE_MISSING');
  }
  if (current.lastModified !== state.lastModified) {
    throw fileError('다른 창에서 장부 파일이 바뀌었습니다. 본당살림 창을 하나만 열어 두세요.', 'FILE_CHANGED');
  }
  state.lastModified = await writeHandle(handle, await sealLedger(state.header, state.encKey, dbBytes));
}

/** 지금 비밀번호가 맞는지 */
export async function checkPassword(password) {
  await ready();
  const keys = await deriveKeys(password, state.header.kdf);
  return keys.rawEnc.every((b, i) => b === state.rawEnc[i]);
}

/** 비밀번호 바꾸기: 새 열쇠로 파일 전체를 다시 잠근다 */
export async function changePassword(newPassword) {
  const engine = await ready();
  const { header, keys } = await newLedgerKeys(newPassword);
  const next = { ...state.header, kdf: header.kdf };
  const previous = state;
  state = { ...state, header: next, encKey: keys.encKey, rawEnc: keys.rawEnc };
  try {
    await save(engine.exportBytes());
  } catch (err) {
    state = previous;
    throw err;
  }
  rememberKey(next.id, keys.rawEnc);
}

/** 지금 장부 파일 이름 */
export async function ledgerFileName() {
  await ready();
  return state.handle.name;
}

/** 백업: 지금 장부 파일(같은 비밀번호로 잠긴 상태)의 사본을 고른 곳에 저장. 저장했으면 파일 이름 */
export async function saveBackupCopy(parishName) {
  await ready();
  const suggestedName = `본당살림 백업 ${parishName || ''} ${todayKST()}${FILE_EXT}`.replace(/\s+/g, ' ');
  let target;
  try {
    target = await window.showSaveFilePicker({ suggestedName, types: FILE_TYPES });
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  }
  if (await target.isSameEntry(state.handle)) throw fileError('지금 쓰는 장부 파일과 다른 이름으로 저장하세요.', 'SAME_FILE');
  const bytes = new Uint8Array(await (await state.handle.getFile()).arrayBuffer());
  await writeHandle(target, bytes);
  return target.name;
}

/** 이 장부를 닫고 시작 화면으로 (다른 장부 파일을 열 때) */
export async function closeLedger() {
  try { sessionStorage.removeItem(KEY_STORE); } catch { /* 무시 */ }
  await forgetHandle();
  location.href = '/';
}

// ---------------------------------------------------------------- 화면

function overlay(html) {
  const box = document.createElement('div');
  box.className = 'unlock-screen';
  box.innerHTML = `<div class="unlock-box"><img src="/img/logo.png" alt="본당살림" width="200" height="56">${html}</div>`;
  document.body.append(box);
  return box;
}

function unsupportedScreen() {
  overlay(`<h2>크롬 또는 엣지에서 열어 주세요</h2>
    <p>본당살림은 장부를 이 컴퓨터의 파일에 저장합니다. 이 기능은 <b>크롬</b>과 <b>엣지</b>에서만 됩니다.</p>`);
  return new Promise(() => {});
}

/** 브라우저가 파일 사용을 다시 묻는 경우: 버튼 한 번으로 허락 */
function permissionScreen(handle) {
  return new Promise((resolve) => {
    const box = overlay(`<h2>장부 파일 열기</h2>
      <p class="file-name">📒 ${escapeHtml(handle.name)}</p>
      <button type="button" id="grant">장부 열기</button>
      <p class="help">브라우저가 이 파일을 쓸지 한 번 더 묻습니다. <b>허용</b>을 눌러 주세요.</p>`);
    const button = box.querySelector('#grant');
    button.focus();
    button.addEventListener('click', async () => {
      const permission = await handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
      box.remove();
      resolve(permission);
    });
  });
}

/** 시작 화면: 지난번 장부 열기 / 다른 장부 파일 열기 / 새 장부 만들기 */
async function startScreen() {
  let handle = await recallHandle();
  return new Promise((resolve) => {
    const box = overlay('<div id="start-body"></div>');
    const body = box.querySelector('#start-body');
    const done = (result) => { box.remove(); resolve(result); };

    const showOpen = () => {
      body.innerHTML = handle ? `
        <h2>장부 열기</h2>
        <form id="open-form" autocomplete="off">
          <p class="file-name">📒 ${escapeHtml(handle.name)}</p>
          <label>비밀번호 <input type="password" id="open-password" required></label>
          <button type="submit">열기</button>
          <p class="error" id="open-error" role="alert"></p>
        </form>
        <p class="start-links"><a href="#" id="pick-file">다른 장부 파일 열기</a> · <a href="#" id="go-new">새 장부 만들기</a></p>` : `
        <h2>시작하기</h2>
        <p>장부는 이 컴퓨터의 파일 하나에 비밀번호로 잠가 저장합니다. 장부 내용은 서버로 보내지 않습니다.</p>
        <div class="start-actions">
          <button type="button" id="pick-file">장부 파일 열기</button>
          <button type="button" class="secondary" id="go-new">새 장부 만들기</button>
        </div>
        <p class="error" id="open-error" role="alert"></p>`;
      body.querySelector('#open-password')?.focus();
      body.querySelector('#go-new').addEventListener('click', (e) => { e.preventDefault(); showNew(); });
      body.querySelector('#pick-file').addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          [handle] = await window.showOpenFilePicker({ types: FILE_TYPES, excludeAcceptAllOption: false });
          showOpen();
        } catch (err) {
          if (err.name !== 'AbortError') body.querySelector('#open-error').textContent = err.message;
        }
      });
      body.querySelector('#open-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const message = body.querySelector('#open-error');
        const button = e.target.querySelector('button');
        button.disabled = true;
        button.textContent = '여는 중…';
        message.textContent = '';
        try {
          // 파일 사용 허락은 버튼을 누른 직후에 물어야 한다 (비밀번호 확인보다 먼저)
          if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted'
              && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') {
            throw fileError('장부 파일 사용을 허용해야 열 수 있습니다.', 'DENIED');
          }
          const file = await readLedgerHandle(handle);
          const keys = await deriveKeys(body.querySelector('#open-password').value, file.header.kdf);
          const dbBytes = await unsealLedger(file.header, file.sealed, keys.encKey);
          await rememberHandle(handle);
          rememberKey(file.header.id, keys.rawEnc);
          done({ dbBytes, state: { handle, header: file.header, encKey: keys.encKey, rawEnc: keys.rawEnc, lastModified: file.lastModified } });
        } catch (err) {
          message.textContent = err.code === 'WRONG_PASSWORD' || err.code ? err.message : `장부를 열지 못했습니다: ${err.message}`;
          body.querySelector('#open-password').select();
          button.disabled = false;
          button.textContent = '열기';
        }
      });
    };

    const showNew = () => {
      body.innerHTML = `
        <h2>새 장부 만들기</h2>
        <ul class="start-points">
          <li>장부는 <b>이 컴퓨터의 파일 하나</b>에 저장됩니다. 다음 단계에서 저장할 곳을 고릅니다.
            <b>OneDrive 폴더</b>에 두면 컴퓨터가 고장 나도 자료가 남습니다.</li>
          <li>파일은 이 비밀번호로 잠깁니다. <b>비밀번호를 잊으면 누구도 열 수 없습니다.</b></li>
        </ul>
        <form id="new-form" autocomplete="off">
          <label>비밀번호 (8자 이상) <input type="password" id="pw1" minlength="8" required></label>
          <label>비밀번호 확인 <input type="password" id="pw2" minlength="8" required></label>
          <label class="check"><input type="checkbox" id="ack" required>
            비밀번호를 잊으면 누구도(개발자 포함) 자료를 되살릴 수 없다는 것을 이해했습니다.</label>
          <button type="submit">저장할 곳 고르고 만들기</button>
          <p class="error" id="new-error" role="alert"></p>
        </form>
        <p class="start-links"><a href="#" id="go-open">← 돌아가기</a></p>`;
      body.querySelector('#pw1').focus();
      body.querySelector('#go-open').addEventListener('click', (e) => { e.preventDefault(); showOpen(); });
      body.querySelector('#new-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const message = body.querySelector('#new-error');
        message.textContent = '';
        const pw = body.querySelector('#pw1').value;
        if (pw.length < 8) { message.textContent = '비밀번호는 8자 이상으로 정하세요.'; return; }
        if (pw !== body.querySelector('#pw2').value) { message.textContent = '비밀번호 확인이 다릅니다.'; body.querySelector('#pw2').select(); return; }
        const button = e.target.querySelector('button');
        try {
          // 저장 위치 고르기는 버튼을 누른 직후에 띄워야 한다
          const target = await window.showSaveFilePicker({ suggestedName: `본당살림 장부${FILE_EXT}`, types: FILE_TYPES });
          if ((await target.getFile()).size > 0) {
            throw fileError('이미 있는 파일입니다. 덮어쓰지 않도록 새 이름으로 저장하세요.', 'EXISTS');
          }
          button.disabled = true;
          button.textContent = '장부를 만드는 중…';
          const { header, keys } = await newLedgerKeys(pw);
          const engine = await openEngine(null); // 표 구조만 있는 빈 장부
          const dbBytes = engine.exportBytes();
          engine.close();
          const lastModified = await writeHandle(target, await sealLedger(header, keys.encKey, dbBytes));
          await rememberHandle(target);
          rememberKey(header.id, keys.rawEnc);
          done({ dbBytes, state: { handle: target, header, encKey: keys.encKey, rawEnc: keys.rawEnc, lastModified } });
        } catch (err) {
          if (err.name !== 'AbortError') message.textContent = err.message;
          button.disabled = false;
          button.textContent = '저장할 곳 고르고 만들기';
        }
      });
    };

    showOpen();
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
