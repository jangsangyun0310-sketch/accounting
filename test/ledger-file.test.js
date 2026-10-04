import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLedgerFile, newLedgerKeys, parseLedgerFile, sealLedger, unsealLedger } from '../public/js/local/ledger-file.js';
import { deriveKeys } from '../public/js/local/crypto.js';

test('장부 파일: 잠그고 다시 풀면 원래 바이트, 머리말에는 비밀이 없다', async () => {
  const db = new TextEncoder().encode('SQLite format 3\0 가짜 장부 내용');
  const { header, keys } = await newLedgerKeys('비밀번호1234');
  const file = await sealLedger(header, keys.encKey, db);

  const parsed = parseLedgerFile(file);
  assert.deepEqual(parsed.header, header);
  assert.deepEqual(Object.keys(parsed.header).sort(), ['format', 'id', 'kdf']);
  assert.ok(!new TextDecoder().decode(file).includes('가짜 장부'));

  const again = await deriveKeys('비밀번호1234', parsed.header.kdf);
  assert.deepEqual(await unsealLedger(parsed.header, parsed.sealed, again.encKey), db);
});

test('장부 파일: 틀린 비밀번호, 다른 파일, 바뀐 머리말은 열리지 않는다', async () => {
  const { header, keys } = await newLedgerKeys('비밀번호1234');
  const file = await sealLedger(header, keys.encKey, new Uint8Array([1, 2, 3]));
  const parsed = parseLedgerFile(file);

  const wrong = await deriveKeys('다른비밀번호', parsed.header.kdf);
  await assert.rejects(unsealLedger(parsed.header, parsed.sealed, wrong.encKey), { code: 'WRONG_PASSWORD' });

  assert.throws(() => parseLedgerFile(new TextEncoder().encode('{"hello":1}')), { code: 'NOT_LEDGER' });

  // 머리말의 id 를 바꿔 끼우면(다른 장부의 암호문) 인증값이 맞지 않는다
  const swapped = parseLedgerFile(buildLedgerFile({ ...header, id: 'other-id-000000000000' }, parsed.sealed));
  await assert.rejects(unsealLedger(swapped.header, swapped.sealed, keys.encKey), { code: 'WRONG_PASSWORD' });
});
