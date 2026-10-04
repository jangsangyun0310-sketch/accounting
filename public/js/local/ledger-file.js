// 본당 컴퓨터에 저장하는 장부 파일 (.bondang)
//   형식: 'BDF1'(4) + 머리말 길이(4, little-endian) + 머리말 JSON + 암호문(crypto.js 의 seal)
//   머리말 = { format, id, kdf } : 비밀이 아닌 값만 둔다. 암호문의 추가 인증값(AAD)은 id.
//   파일은 크롬·엣지의 File System Access API 로 읽고 쓴다. 마지막으로 연 파일은 IndexedDB 에 기억한다.
import { deriveKeys, newKdf, randomId, seal, unseal } from './crypto.js';

const MAGIC = new TextEncoder().encode('BDF1');
export const FILE_EXT = '.bondang';
export const FILE_TYPES = [{ description: '본당살림 장부', accept: { 'application/octet-stream': [FILE_EXT] } }];

/** 이 브라우저에서 장부 파일을 쓸 수 있는지 (크롬·엣지) */
export const fileAccessSupported = typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function' && typeof window.showSaveFilePicker === 'function';

export function fileError(message, code) {
  return Object.assign(new Error(message), { code });
}

/** 장부 파일 바이트 → { header, sealed } */
export function parseLedgerFile(bytes) {
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw fileError('본당살림 장부 파일이 아닙니다. 확장자가 .bondang 인 파일을 고르세요.', 'NOT_LEDGER');
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true);
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length)));
  } catch {
    throw fileError('장부 파일이 손상되었습니다.', 'BROKEN');
  }
  if (header.format !== 1 || !header.id || !header.kdf) throw fileError('이 프로그램이 모르는 장부 파일 형식입니다.', 'BROKEN');
  return { header, sealed: bytes.subarray(8 + length) };
}

export function buildLedgerFile(header, sealed) {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + head.length + sealed.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, head.length, true);
  out.set(head, 8);
  out.set(sealed, 8 + head.length);
  return out;
}

/** 새 장부의 머리말과 열쇠 */
export async function newLedgerKeys(password) {
  const header = { format: 1, id: randomId(), kdf: newKdf() };
  return { header, keys: await deriveKeys(password, header.kdf) };
}

/** SQLite 바이트를 열쇠로 잠가 장부 파일 바이트로 */
export async function sealLedger(header, encKey, dbBytes) {
  return buildLedgerFile(header, await seal(dbBytes, encKey, header.id));
}

/** 장부 파일 바이트를 풀어 SQLite 바이트로. 비밀번호가 틀리면 오류 */
export async function unsealLedger(header, sealed, encKey) {
  try {
    return await unseal(sealed, encKey, header.id);
  } catch {
    throw fileError('비밀번호가 맞지 않습니다.', 'WRONG_PASSWORD');
  }
}

/** 파일 읽기 → { header, sealed, lastModified } */
export async function readLedgerHandle(handle) {
  const file = await handle.getFile();
  return { ...parseLedgerFile(new Uint8Array(await file.arrayBuffer())), lastModified: file.lastModified };
}

/** 파일 통째로 쓰기 (브라우저가 임시 파일에 쓴 뒤 한 번에 바꾼다). 쓴 뒤의 수정 시각을 돌려준다 */
export async function writeHandle(handle, bytes) {
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
  return (await handle.getFile()).lastModified;
}

// ---------------------------------------------------------------- 마지막으로 연 파일 기억 (IndexedDB)

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('bondang', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kv(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function rememberHandle(handle) {
  try { await kv('readwrite', (s) => s.put(handle, 'ledger')); } catch { /* 기억 못 해도 다음에 파일을 다시 고르면 된다 */ }
}

export async function recallHandle() {
  try { return (await kv('readonly', (s) => s.get('ledger'))) ?? null; } catch { return null; }
}

export async function forgetHandle() {
  try { await kv('readwrite', (s) => s.delete('ledger')); } catch { /* 무시 */ }
}
