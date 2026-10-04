// 사용자 식별
// AUTH_MODE = 'open'   (기본 배포) : 로그인 없이 사용. 성당마다 사무장 한 명이 쓰므로
//                                    처리자는 설정의 '결산서 작성자' 이름으로 기록한다 (없으면 '사무실').
// AUTH_MODE = 'access' (선택)      : Cloudflare Access 로그인. Cf-Access-Jwt-Assertion 서명·대상·만료를 검증한다.
// AUTH_MODE = 'dev'    (로컬 개발) : 검증 없이 DEV_USER 로 동작한다.
// 값이 없으면 안전하게 'access' 로 취급한다.
import { ApiError } from './http.js';

const CERT_TTL_MS = 60 * 60 * 1000;
let certCache = { url: '', fetchedAt: 0, keys: [] };

export const OPEN_ACTOR = '사무실';

/** @returns {Promise<{ email: string }>} */
export async function getActor(request, env) {
  const mode = env.AUTH_MODE || 'access';
  if (mode === 'open') {
    const writer = await env.DB.prepare('SELECT writer_name FROM parish_settings WHERE id = 1').first('writer_name');
    return { email: writer?.trim() || OPEN_ACTOR };
  }
  if (mode === 'dev') return { email: env.DEV_USER || 'dev@local' };
  if (mode !== 'access') throw new ApiError(500, 'AUTH_MODE_INVALID', '인증 설정(AUTH_MODE)이 올바르지 않습니다.');

  const teamDomain = (env.ACCESS_TEAM_DOMAIN || '').replace(/\/+$/, '');
  const audience = env.ACCESS_AUD || '';
  if (!teamDomain || !audience) {
    throw new ApiError(500, 'ACCESS_NOT_CONFIGURED',
      'Cloudflare Access 설정(ACCESS_TEAM_DOMAIN, ACCESS_AUD)이 필요합니다. 설치 안내서를 확인하세요.');
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');

  const payload = await verifyAccessJwt(token, teamDomain, audience);
  if (!payload.email) throw new ApiError(401, 'UNAUTHENTICATED', '사용자 이메일을 확인할 수 없습니다.');
  return { email: payload.email };
}

async function verifyAccessJwt(token, teamDomain, audience) {
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthenticated();
  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(base64UrlDecodeText(headerB64));
    payload = JSON.parse(base64UrlDecodeText(payloadB64));
  } catch {
    throw unauthenticated();
  }
  if (header.alg !== 'RS256' || !header.kid) throw unauthenticated();

  const jwk = await findKey(teamDomain, header.kid);
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, base64UrlDecodeBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw unauthenticated();

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) throw unauthenticated();
  if (payload.iss !== teamDomain) throw unauthenticated();
  if (typeof payload.exp !== 'number' || payload.exp < now) throw unauthenticated();
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) throw unauthenticated();
  return payload;
}

async function findKey(teamDomain, kid) {
  const url = `${teamDomain}/cdn-cgi/access/certs`;
  const fresh = certCache.url === url && Date.now() - certCache.fetchedAt < CERT_TTL_MS;
  let key = fresh ? certCache.keys.find((k) => k.kid === kid) : undefined;
  if (key) return key;

  // 캐시가 없거나 키가 교체된 경우 다시 가져온다
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(502, 'ACCESS_CERTS', '인증서 정보를 가져오지 못했습니다.');
  const { keys = [] } = await res.json();
  certCache = { url, fetchedAt: Date.now(), keys };
  key = keys.find((k) => k.kid === kid);
  if (!key) throw unauthenticated();
  return key;
}

function base64UrlDecodeBytes(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function base64UrlDecodeText(text) {
  return new TextDecoder().decode(base64UrlDecodeBytes(text));
}

function unauthenticated() {
  return new ApiError(401, 'UNAUTHENTICATED', '로그인 정보가 유효하지 않습니다. 다시 로그인하세요.');
}
