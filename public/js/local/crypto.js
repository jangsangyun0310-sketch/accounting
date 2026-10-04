// 성당 자료 암호화 (브라우저 안에서만)
//   비밀번호 --PBKDF2-SHA256(60만 회, 성당별 salt)--> 512비트
//     앞 256비트: 암호화 열쇠 (AES-256-GCM). 브라우저 밖으로 보내지 않는다.
//     뒤 256비트: 확인용 열쇠. 서버는 이것의 SHA-256 만 저장한다. 여기서 암호화 열쇠를 알아낼 수 없다.
//   암호문 형식: 'BDS1'(4) + IV(12) + AES-GCM( gzip(SQLite 파일) ), 추가 인증값(AAD) = 성당 ID

export const KDF_ITERATIONS = 600_000;
const MAGIC = new TextEncoder().encode('BDS1');

const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** 추측할 수 없는 성당 ID (base64url 24자 = 144비트) */
export function randomId() {
  return toB64(crypto.getRandomValues(new Uint8Array(18))).replace(/\+/g, '-').replace(/\//g, '_');
}

/** 새 성당용 kdf 설정 (salt 는 비밀이 아님) */
export function newKdf() {
  return { alg: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt: toB64(crypto.getRandomValues(new Uint8Array(16))) };
}

/** 비밀번호 → { encKey(CryptoKey), rawEnc(Uint8Array), authHex } */
export async function deriveKeys(password, kdf) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(kdf.salt), iterations: kdf.iterations }, base, 512));
  const rawEnc = bits.slice(0, 32);
  return { encKey: await importEncKey(rawEnc), rawEnc, authHex: toHex(bits.slice(32)) };
}

export function importEncKey(rawEnc) {
  return crypto.subtle.importKey('raw', rawEnc, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function transform(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/** SQLite 바이트 → 암호문 */
export async function seal(bytes, encKey, parishId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const packed = await transform(bytes, new CompressionStream('gzip'));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(parishId) }, encKey, packed));
  const out = new Uint8Array(MAGIC.length + iv.length + ct.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(ct, MAGIC.length + iv.length);
  return out;
}

/** 암호문 → SQLite 바이트. 열쇠가 다르거나 내용이 바뀌었으면 오류 */
export async function unseal(blob, encKey, parishId) {
  if (blob.length < 16 || MAGIC.some((b, i) => blob[i] !== b)) throw new Error('본당살림 자료 형식이 아닙니다.');
  const iv = blob.subarray(4, 16);
  let packed;
  try {
    packed = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(parishId) }, encKey, blob.subarray(16)));
  } catch {
    throw new Error('자료를 풀 수 없습니다. 비밀번호가 다르거나 자료가 손상되었습니다.');
  }
  return transform(packed, new DecompressionStream('gzip'));
}

export const encodeKey = toB64;
export const decodeKey = fromB64;
