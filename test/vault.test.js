import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createDb, d1Adapter } from './helpers.js';
import { deriveKeys, newKdf, randomId, seal, unseal } from '../public/js/local/crypto.js';

const ORIGIN = 'http://local';

function vaultClient(db) {
  const env = { DB: d1Adapter(db) };
  return async (method, path, { auth, headers = {}, body } = {}) => {
    const res = await worker.fetch(new Request(ORIGIN + path, {
      method,
      headers: { ...(auth ? { authorization: `Vault ${auth}` } : {}), ...headers },
      body,
    }), env);
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, data };
  };
}

const sample = new TextEncoder().encode('SQLite format 3\0'.padEnd(5000, 'x'));

test('암호화: 같은 비밀번호로만 풀리고, 다른 성당 ID 로도 못 푼다', async () => {
  const kdf = newKdf();
  const id = randomId();
  const a = await deriveKeys('성당비밀번호123', kdf);
  const blob = await seal(sample, a.encKey, id);
  assert.notDeepEqual(blob.slice(16, 40), sample.slice(0, 24)); // 원문이 그대로 보이지 않음
  assert.deepEqual(await unseal(blob, a.encKey, id), sample);
  const again = await deriveKeys('성당비밀번호123', kdf);
  assert.equal(again.authHex, a.authHex);
  const wrong = await deriveKeys('성당비밀번호124', kdf);
  await assert.rejects(unseal(blob, wrong.encKey, id), /풀 수 없습니다/);
  await assert.rejects(unseal(blob, a.encKey, randomId()), /풀 수 없습니다/);
  // 확인용 열쇠와 암호화 열쇠는 다른 값
  assert.notEqual(Buffer.from(a.rawEnc).toString('hex'), a.authHex);
  assert.equal(randomId().length, 24);
});

test('보관함: 만들기 → 열기 → 저장(버전) → 동시 수정 거부 → 비밀번호 바꾸기', async () => {
  const db = createDb({ seed: false });
  const call = vaultClient(db);
  const id = randomId();
  const kdf = newKdf();
  const keys = await deriveKeys('pass-1234', kdf);
  const blob1 = await seal(sample, keys.encKey, id);

  let r = await call('POST', `/vault/${id}`, { auth: keys.authHex, headers: { 'x-vault-kdf': JSON.stringify(kdf) }, body: blob1 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  r = await call('POST', `/vault/${id}`, { auth: keys.authHex, headers: { 'x-vault-kdf': JSON.stringify(kdf) }, body: blob1 });
  assert.equal(r.data.error.code, 'EXISTS');

  // 서버에 저장된 것: 원문 없음, 확인용 열쇠 원본 없음
  const row = db.prepare('SELECT * FROM vaults').get();
  assert.notEqual(row.auth_hash, keys.authHex);
  assert.ok(!Buffer.from(db.prepare('SELECT data FROM vault_chunks').get().data).includes(Buffer.from('SQLite format 3')));

  r = await call('GET', `/vault/${id}/meta`);
  assert.deepEqual(r.data.kdf, kdf);
  r = await call('GET', `/vault/${id}`, { auth: keys.authHex });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-vault-version'), '1');
  assert.deepEqual(await unseal(r.data, keys.encKey, id), sample);
  r = await call('GET', `/vault/${id}`, { auth: keys.authHex, headers: { 'x-have-version': '1' } });
  assert.equal(r.status, 304);

  // 저장: 버전 1 → 2. 같은 버전 기준으로 다시 저장하면 거부(다른 PC 에서 먼저 저장한 경우)
  const changed = new TextEncoder().encode('changed'.padEnd(3000, 'y'));
  const blob2 = await seal(changed, keys.encKey, id);
  r = await call('PUT', `/vault/${id}`, { auth: keys.authHex, headers: { 'x-expected-version': '1' }, body: blob2 });
  assert.deepEqual(r.data, { version: 2 });
  r = await call('PUT', `/vault/${id}`, { auth: keys.authHex, headers: { 'x-expected-version': '1' }, body: blob1 });
  assert.equal(r.data.error.code, 'VERSION_CONFLICT');
  r = await call('GET', `/vault/${id}`, { auth: keys.authHex });
  assert.deepEqual(await unseal(r.data, keys.encKey, id), changed);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vault_chunks').get().n, 1); // 이전 버전 조각은 지워짐

  // 비밀번호 바꾸기
  const kdf2 = newKdf();
  const keys2 = await deriveKeys('new-pass-5678', kdf2);
  r = await call('POST', `/vault/${id}/rekey`, {
    auth: keys.authHex,
    headers: { 'x-expected-version': '2', 'x-new-auth': keys2.authHex, 'x-vault-kdf': JSON.stringify(kdf2) },
    body: await seal(changed, keys2.encKey, id),
  });
  assert.deepEqual(r.data, { version: 3 });
  assert.equal((await call('GET', `/vault/${id}`, { auth: keys.authHex })).status, 401); // 예전 비밀번호는 거부
  r = await call('GET', `/vault/${id}`, { auth: keys2.authHex });
  assert.deepEqual(await unseal(r.data, keys2.encKey, id), changed);
  assert.deepEqual((await call('GET', `/vault/${id}/meta`)).data.kdf, kdf2);
});

test('보관함: 비밀번호 10번 틀리면 15분 잠금, 없는 주소, 잘못된 요청', async () => {
  const db = createDb({ seed: false });
  const call = vaultClient(db);
  const id = randomId();
  const kdf = newKdf();
  const keys = await deriveKeys('right-pass', kdf);
  await call('POST', `/vault/${id}`, { auth: keys.authHex, headers: { 'x-vault-kdf': JSON.stringify(kdf) }, body: sample });
  const bad = 'f'.repeat(64);
  for (let i = 0; i < 9; i++) assert.equal((await call('GET', `/vault/${id}`, { auth: bad })).status, 401);
  assert.equal((await call('GET', `/vault/${id}`, { auth: bad })).status, 401); // 10번째 → 잠금
  const locked = await call('GET', `/vault/${id}`, { auth: keys.authHex });
  assert.equal(locked.data.error.code, 'LOCKED'); // 잠긴 동안은 맞는 비밀번호도 거부
  db.prepare("UPDATE vaults SET locked_until = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await call('GET', `/vault/${id}`, { auth: keys.authHex })).status, 200);

  assert.equal((await call('GET', `/vault/${randomId()}/meta`)).data.error.code, 'NO_VAULT');
  assert.equal((await call('GET', '/vault/short/meta')).status, 404);
  const weak = { ...newKdf(), iterations: 1000 };
  const r = await call('POST', `/vault/${randomId()}`, { auth: keys.authHex, headers: { 'x-vault-kdf': JSON.stringify(weak) }, body: sample });
  assert.equal(r.status, 400); // 너무 약한 열쇠 설정 거부
});
