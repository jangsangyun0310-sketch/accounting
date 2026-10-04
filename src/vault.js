// 성당별 암호화 보관함 API (/vault/*)
// 서버는 암호문을 보관·전달만 한다. 내용을 풀 수 있는 열쇠는 없다.
//   GET  /vault/{id}/meta     : 열쇠 만드는 방법(kdf). 비밀번호 확인 전에 필요
//   POST /vault/{id}          : 새 보관함 (확인용 열쇠 + 첫 암호문)
//   GET  /vault/{id}          : 암호문 받기 (확인용 열쇠 필요)
//   PUT  /vault/{id}          : 암호문 저장 (X-Expected-Version 이 현재 버전과 같을 때만)
//   POST /vault/{id}/rekey    : 비밀번호 바꾸기 (새 확인용 열쇠·kdf·암호문으로 한 번에 교체)
// 확인용 열쇠는 Authorization: Vault <hex> 로 받는다. 서버는 그 SHA-256 만 저장한다.

const ID = /^[A-Za-z0-9_-]{16,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CHUNK = 1_000_000;
const MAX_BYTES = 20_000_000;
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const fail = (status, code, message) => json({ error: { code, message } }, status);

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function authToken(request) {
  const m = /^Vault ([0-9a-f]{64})$/.exec(request.headers.get('authorization') || '');
  return m ? m[1] : null;
}

/** kdf 설정 검증: 알고리즘·반복 횟수·salt 형식만 확인 (비밀 아님) */
function parseKdf(text) {
  try {
    const k = JSON.parse(text);
    const saltLen = atob(k.salt).length;
    if (k.alg === 'PBKDF2-SHA256' && Number.isInteger(k.iterations) && k.iterations >= 100_000
        && k.iterations <= 10_000_000 && saltLen >= 16 && saltLen <= 64) {
      return JSON.stringify({ alg: k.alg, iterations: k.iterations, salt: k.salt });
    }
  } catch { /* 아래에서 거부 */ }
  return null;
}

async function readBody(request) {
  const buf = new Uint8Array(await request.arrayBuffer());
  if (!buf.length) return { error: fail(400, 'EMPTY', '저장할 자료가 없습니다.') };
  if (buf.length > MAX_BYTES) return { error: fail(413, 'TOO_LARGE', '자료가 너무 큽니다.') };
  return { buf };
}

function chunkStatements(db, id, version, buf, { expected = null } = {}) {
  const out = [];
  for (let i = 0, idx = 0; i < buf.length; i += CHUNK, idx++) {
    const part = buf.subarray(i, i + CHUNK);
    out.push(expected == null
      ? db.prepare('INSERT INTO vault_chunks (vault_id, version, idx, data) VALUES (?, ?, ?, ?)').bind(id, version, idx, part)
      // 버전이 그대로일 때만 넣는다 (동시에 저장한 다른 쪽이 먼저 바꿨으면 아무것도 안 함)
      : db.prepare(`INSERT INTO vault_chunks (vault_id, version, idx, data)
                    SELECT ?1, ?2, ?3, ?4 WHERE (SELECT version FROM vaults WHERE id = ?1) = ?5`)
        .bind(id, version, idx, part, expected));
  }
  return out;
}

/** 확인용 열쇠 검사. 여러 번 틀리면 잠시 잠근다. 성공하면 보관함 행을 돌려준다 */
async function authorize(db, id, request) {
  const row = await db.prepare('SELECT * FROM vaults WHERE id = ?').bind(id).first();
  if (!row) return { error: fail(404, 'NO_VAULT', '없는 성당 주소입니다. 주소를 확인하세요.') };
  const now = Date.now();
  if (row.locked_until && Date.parse(row.locked_until) > now) {
    return { error: fail(429, 'LOCKED', '비밀번호를 여러 번 틀려 15분 동안 잠겼습니다. 잠시 후 다시 시도하세요.') };
  }
  const token = authToken(request);
  if (!token || await sha256Hex(token) !== row.auth_hash) {
    const fails = row.failed_attempts + 1;
    await db.prepare('UPDATE vaults SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .bind(fails >= MAX_FAILS ? 0 : fails, fails >= MAX_FAILS ? new Date(now + LOCK_MS).toISOString() : null, id).run();
    return { error: fail(401, 'WRONG_PASSWORD', '비밀번호가 맞지 않습니다.') };
  }
  if (row.failed_attempts || row.locked_until) {
    await db.prepare('UPDATE vaults SET failed_attempts = 0, locked_until = NULL WHERE id = ?').bind(id).run();
  }
  return { row };
}

export async function handleVault(request, env, url) {
  const m = /^\/vault\/([^/]+)(\/meta|\/rekey)?$/.exec(url.pathname);
  if (!m || !ID.test(m[1])) return fail(404, 'NOT_FOUND', '요청한 기능을 찾을 수 없습니다.');
  const id = m[1];
  const action = m[2] ?? '';
  const db = env.DB;
  const method = request.method;

  if (action === '/meta' && method === 'GET') {
    const kdf = await db.prepare('SELECT kdf FROM vaults WHERE id = ?').bind(id).first('kdf');
    return kdf ? json({ kdf: JSON.parse(kdf) }) : fail(404, 'NO_VAULT', '없는 성당 주소입니다. 주소를 확인하세요.');
  }

  if (action === '' && method === 'POST') {
    const token = authToken(request);
    const kdf = parseKdf(request.headers.get('x-vault-kdf') || '');
    if (!token || !kdf) return fail(400, 'BAD_REQUEST', '요청 형식이 올바르지 않습니다.');
    const { buf, error } = await readBody(request);
    if (error) return error;
    const now = new Date().toISOString();
    try {
      await db.batch([
        db.prepare(`INSERT INTO vaults (id, kdf, auth_hash, version, size, chunks, created_at, updated_at)
                    VALUES (?, ?, ?, 1, ?, ?, ?, ?)`)
          .bind(id, kdf, await sha256Hex(token), buf.length, Math.ceil(buf.length / CHUNK), now, now),
        ...chunkStatements(db, id, 1, buf),
      ]);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return fail(409, 'EXISTS', '이미 있는 주소입니다. 다시 시도하세요.');
      throw e;
    }
    return json({ version: 1 }, 201);
  }

  if (action === '' && method === 'GET') {
    const { row, error } = await authorize(db, id, request);
    if (error) return error;
    if (request.headers.get('x-have-version') === String(row.version)) {
      return new Response(null, { status: 304, headers: { 'x-vault-version': String(row.version) } });
    }
    const { results } = await db.prepare('SELECT data FROM vault_chunks WHERE vault_id = ? AND version = ? ORDER BY idx')
      .bind(id, row.version).all();
    const parts = results.map((r) => new Uint8Array(r.data));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return new Response(out, {
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-vault-version': String(row.version) },
    });
  }

  if ((action === '' && method === 'PUT') || (action === '/rekey' && method === 'POST')) {
    const { row, error } = await authorize(db, id, request);
    if (error) return error;
    const expected = Number(request.headers.get('x-expected-version'));
    if (!Number.isInteger(expected)) return fail(400, 'BAD_REQUEST', '요청 형식이 올바르지 않습니다.');
    if (expected !== row.version) return conflict();
    let newAuth = row.auth_hash;
    let newKdf = row.kdf;
    if (action === '/rekey') {
      const t = request.headers.get('x-new-auth') || '';
      newKdf = parseKdf(request.headers.get('x-vault-kdf') || '');
      if (!HEX64.test(t) || !newKdf) return fail(400, 'BAD_REQUEST', '요청 형식이 올바르지 않습니다.');
      newAuth = await sha256Hex(t);
    }
    const { buf, error: bodyError } = await readBody(request);
    if (bodyError) return bodyError;
    const next = expected + 1;
    const results = await db.batch([
      ...chunkStatements(db, id, next, buf, { expected }),
      db.prepare(`UPDATE vaults SET version = ?, size = ?, chunks = ?, auth_hash = ?, kdf = ?, updated_at = ?
                  WHERE id = ? AND version = ?`)
        .bind(next, buf.length, Math.ceil(buf.length / CHUNK), newAuth, newKdf, new Date().toISOString(), id, expected),
      db.prepare('DELETE FROM vault_chunks WHERE vault_id = ?1 AND version < (SELECT version FROM vaults WHERE id = ?1)').bind(id),
    ]);
    const updated = results.at(-2);
    if (!(updated.meta?.changes > 0)) return conflict();
    return json({ version: next });
  }

  return fail(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 요청 방식입니다.');
}

function conflict() {
  return fail(409, 'VERSION_CONFLICT', '다른 곳(다른 PC나 창)에서 자료가 바뀌었습니다. 새로고침한 뒤 다시 입력하세요.');
}
